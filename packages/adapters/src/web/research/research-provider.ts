import {
  deadlineSignal,
  parseRetryAfter,
  ResponseTooLargeError,
  readBoundedResponseBytes,
  retry,
  withAbort,
} from "@rakazo/core";
import type { ResolveHostname } from "../web-ssrf.js";

/** What a research provider adds to a run once its owner saves a key. */
export type ResearchCapability = "search" | "page_read";

/** Declared by each provider; Settings and tool selection read only this. */
export interface ResearchProviderDescriptor {
  /** Opaque id, saved with the key. */
  id: string;
  /** The provider's name, shown in Settings. */
  label: string;
  /** The built-in tool a saved key turns on. */
  toolName: string;
  capability: ResearchCapability;
}

export interface ResearchCallOptions {
  signal: AbortSignal;
  /** Test seam for the provider's HTTP API. */
  fetch?: typeof globalThis.fetch;
  /** Test seam for the URL safety check. */
  resolveHostname?: ResolveHostname;
  /** Test seam for the wait before a retry. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam: a shorter deadline than the provider's own. */
  timeoutMs?: number;
}

/** A provider that answers one built-in tool with the person's own key. */
export interface ResearchProvider {
  descriptor: ResearchProviderDescriptor;
  /** The tool result for the model. Failures throw {@link ResearchProviderError}. */
  run(args: Record<string, unknown>, key: string, options: ResearchCallOptions): Promise<unknown>;
}

/**
 * A failure the model can act on. The message never carries the key or response headers; the
 * status and retry hint drive `retry`.
 */
export class ResearchProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ResearchProviderError";
  }
}

/** A provider-asked wait longer than this is reported instead of waited out inside the turn. */
const MAX_RETRY_WAIT_MS = 10_000;
const ATTEMPTS = 2;

/**
 * POSTs JSON to a provider's fixed endpoint and returns the parsed body. One deadline covers
 * every try. Only network failures, 408, 429 and 5xx are tried again.
 */
export async function postProviderJson(input: {
  label: string;
  url: string;
  key: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  maxBytes: number;
  options: ResearchCallOptions;
}): Promise<unknown> {
  const { label, options } = input;
  options.signal.throwIfAborted();
  const signal = deadlineSignal(options.timeoutMs ?? input.timeoutMs, options.signal);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    return await retry(
      async () => {
        let response: Response;
        try {
          response = await fetchImpl(input.url, {
            method: "POST",
            headers: { "content-type": "application/json", ...input.headers },
            body: JSON.stringify(input.body),
            redirect: "error",
            signal,
          });
        } catch (error) {
          if (signal.aborted) throw error;
          // The network failed before an answer; its error text can name hosts, never the key.
          throw new ResearchProviderError(
            `${label} could not be reached.`,
            undefined,
            undefined,
            true,
          );
        }
        const bytes = await readBoundedResponseBytes(response, {
          maxBytes: input.maxBytes,
          tooLargeMessage: `${label} returned too much data.`,
          read: (operation) => withAbort(operation(), signal),
        });
        const text = new TextDecoder().decode(bytes);
        if (!response.ok) throw statusError(label, response, text, input.key);
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new ResearchProviderError(`${label} returned an unexpected response.`);
        }
      },
      {
        attempts: ATTEMPTS,
        signal,
        retryable: (error) => error instanceof ResearchProviderError && error.retryable,
        ...(options.delay ? { delay: options.delay } : {}),
      },
    );
  } catch (error) {
    if (error instanceof ResearchProviderError) throw error;
    if (error instanceof ResponseTooLargeError) throw new ResearchProviderError(error.message);
    // The run itself was cancelled: let that propagate as it is.
    if (options.signal.aborted) throw error;
    if (signal.aborted) throw new ResearchProviderError(`${label} did not answer in time.`);
    throw new ResearchProviderError(`${label} request failed.`);
  }
}

function statusError(label: string, response: Response, body: string, key: string) {
  const { status } = response;
  if (status === 401 || status === 403)
    return new ResearchProviderError(
      `${label} rejected the saved key. Ask the person to replace it in Settings, or use web_search and web_fetch.`,
      status,
    );
  if (status === 402)
    return new ResearchProviderError(
      `${label} says the account is out of credits. Tell the person, or use web_search and web_fetch.`,
      status,
    );
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    const short = retryAfterMs === undefined || retryAfterMs <= MAX_RETRY_WAIT_MS;
    const wait =
      retryAfterMs === undefined ? "" : ` Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`;
    return new ResearchProviderError(
      `${label} is limiting requests right now.${wait}`,
      status,
      retryAfterMs,
      short,
    );
  }
  if (status >= 500 || status === 408)
    return new ResearchProviderError(`${label} is unavailable right now.`, status, undefined, true);
  return new ResearchProviderError(
    `${label} refused the request${providerReason(body, key)}.`,
    status,
  );
}

/** The provider's own short reason for a refused request, with the key taken out. */
function providerReason(body: string, key: string): string {
  let reason: unknown;
  try {
    reason = (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    return "";
  }
  if (typeof reason !== "string" || !reason.trim()) return "";
  const text = (key ? reason.replaceAll(key, "[key]") : reason).replace(/\s+/g, " ").trim();
  return `: ${text.slice(0, 300)}`;
}

/** A model-given number within bounds, or the default. */
export function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** A public http(s) URL without credentials, as given by a provider, or undefined. */
export function publicResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password)
      return url.href;
  } catch {
    // A malformed provider URL is not a usable citation.
  }
  return undefined;
}
