import { cancelResponseBody, deadlineSignal } from "@rakazo/core";
import type { SafeRemoteFetch } from "../../mcp/remote-mcp.js";
import { createSafeRemoteFetch } from "../../mcp/remote-mcp.js";
import type { ResolveHostname } from "../../network/network-address.js";
import { AppFunctionCallError } from "../functions/app-function-runtime.js";

/**
 * `ctx.fetch` for an installed app the person allowed to use the network. Only HTTPS to the
 * exact hosts the manifest lists, through the same guarded fetch remote MCP servers use: a host
 * that resolves to a private, loopback, link-local or cloud metadata address is refused, and so
 * is every redirect. Nothing is added to the request: no cookies, no platform credentials, no
 * forwarding headers. Methods, headers, sizes, time and the number of calls per run are capped,
 * and a read-only action only reads: it sends GET and HEAD, nothing that could change a thing.
 */
export const APP_FETCH_LIMITS = {
  calls: 10,
  headers: 32,
  headerBytes: 8 * 1024,
  requestBytes: 64 * 1024,
  responseBytes: 1024 * 1024,
  timeoutMs: 8_000,
};

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// The platform's own: what reaches the host is only what the app wrote.
const FORBIDDEN_HEADER =
  /^(?:cookie|cookie2|host|connection|keep-alive|content-length|transfer-encoding|te|trailer|upgrade|expect|proxy-.*|x-forwarded-.*|forwarded|via)$/i;
const HIDDEN_RESPONSE_HEADER = /^(?:set-cookie|set-cookie2)$/i;

export type AppFetchAnswer = { status: number; headers: Record<string, string>; body: string };

function refuse(message: string): never {
  throw new AppFunctionCallError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!plainObject(value)) refuse("headers must be an object of names and text values.");
  const entries = Object.entries(value);
  if (entries.length > APP_FETCH_LIMITS.headers)
    refuse(`A request takes at most ${APP_FETCH_LIMITS.headers} headers.`);
  const headers: Record<string, string> = {};
  let bytes = 0;
  for (const [name, given] of entries) {
    if (!HEADER_NAME.test(name)) refuse(`"${name.slice(0, 40)}" is not a header name.`);
    if (FORBIDDEN_HEADER.test(name))
      refuse(`The ${name} header is set by the platform or not at all.`);
    if (typeof given !== "string" || /[\r\n]/.test(given))
      refuse(`The ${name} header must be one line of text.`);
    bytes += name.length + given.length;
    headers[name] = given;
  }
  if (bytes > APP_FETCH_LIMITS.headerBytes)
    refuse(`A request's headers take at most ${APP_FETCH_LIMITS.headerBytes} bytes.`);
  return headers;
}

function requestBody(value: unknown, headers: Record<string, string>): string | undefined {
  if (value === undefined || value === null) return undefined;
  let body: string;
  if (typeof value === "string") body = value;
  else if (plainObject(value) || Array.isArray(value)) {
    body = JSON.stringify(value);
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type"))
      headers["content-type"] = "application/json";
  } else refuse("body must be text or a JSON object.");
  if (new TextEncoder().encode(body).byteLength > APP_FETCH_LIMITS.requestBytes)
    refuse(`A request body takes at most ${APP_FETCH_LIMITS.requestBytes} bytes.`);
  return body;
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > APP_FETCH_LIMITS.responseBytes) {
      await reader.cancel();
      refuse(`The answer is over ${APP_FETCH_LIMITS.responseBytes} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class AppNetwork {
  private calls = 0;
  private readonly fetcher: SafeRemoteFetch;

  constructor(
    private readonly hosts: readonly string[],
    options: {
      fetch?: typeof globalThis.fetch;
      resolveHostname?: ResolveHostname;
      signal?: AbortSignal;
      readOnly?: boolean;
    } = {},
  ) {
    this.fetcher = createSafeRemoteFetch(options.fetch, options.resolveHostname, {
      allowPrivateEndpoint: false,
    });
    this.signal = options.signal;
    this.readOnly = options.readOnly === true;
  }

  private readonly signal: AbortSignal | undefined;
  private readonly readOnly: boolean;

  /** The checked request, refused before anything is sent when it breaks a rule. */
  private request(url: unknown, init: unknown) {
    if (typeof url !== "string") refuse("fetch takes a URL.");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      refuse("fetch takes a full https:// URL.");
    }
    if (parsed.protocol !== "https:") refuse("Apps call out over HTTPS only.");
    if (parsed.username || parsed.password) refuse("A URL must not carry a user name or password.");
    if (parsed.port && parsed.port !== "443")
      refuse("Apps call out on the standard HTTPS port only.");
    const host = parsed.hostname.toLowerCase();
    if (!this.hosts.includes(host))
      refuse(`This app may call only ${this.hosts.join(", ")}; ${host} is not one of them.`);
    parsed.hash = "";
    const options = init === undefined ? {} : init;
    if (!plainObject(options)) refuse("fetch's second argument is an object.");
    const method = typeof options.method === "string" ? options.method.toUpperCase() : "GET";
    if (!METHODS.has(method)) refuse(`fetch sends ${[...METHODS].join(", ")}, not ${method}.`);
    if (this.readOnly && method !== "GET" && method !== "HEAD")
      refuse(`A read-only action sends GET or HEAD only, not ${method}.`);
    const headers = requestHeaders(options.headers);
    const body = requestBody(options.body, headers);
    if (body !== undefined && (method === "GET" || method === "HEAD"))
      refuse(`A ${method} request has no body.`);
    return { url: parsed, host, method, headers, body };
  }

  async fetch(url: unknown, init: unknown): Promise<AppFetchAnswer> {
    this.calls += 1;
    if (this.calls > APP_FETCH_LIMITS.calls)
      refuse(`A run makes at most ${APP_FETCH_LIMITS.calls} network calls.`);
    const request = this.request(url, init);
    const signal = deadlineSignal(APP_FETCH_LIMITS.timeoutMs, this.signal);
    let response: Response;
    try {
      response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal,
        credentials: "omit",
      });
    } catch {
      // Why it failed stays here: an app learns no more about the platform's network than this.
      refuse(
        signal.aborted
          ? `${request.host} did not answer in ${APP_FETCH_LIMITS.timeoutMs / 1000} seconds.`
          : `Could not reach ${request.host}.`,
      );
    }
    try {
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (!HIDDEN_RESPONSE_HEADER.test(name)) headers[name] = value;
      });
      const body = request.method === "HEAD" ? "" : await readLimited(response);
      return { status: response.status, headers, body };
    } catch (error) {
      cancelResponseBody(response);
      if (error instanceof AppFunctionCallError) throw error;
      refuse(`${request.host} stopped answering.`);
    }
  }

  close(): Promise<void> {
    return this.fetcher.close();
  }
}
