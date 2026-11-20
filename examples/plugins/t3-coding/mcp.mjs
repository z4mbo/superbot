import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../packages/adapters/package.json", import.meta.url));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { UnauthorizedError } = require("@modelcontextprotocol/sdk/client/auth.js");

export function endpoint(input, path) {
  const url = new URL(input);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== path
  ) {
    throw new Error(`Use an HTTPS endpoint or an HTTP loopback address with path ${path}.`);
  }
  return url;
}

function transport(url, options) {
  return new StreamableHTTPClientTransport(url, {
    ...options,
    fetch: (input, init) => {
      const to = new URL(input);
      if (to.origin !== url.origin || to.username || to.password) {
        throw new Error("T3 MCP discovery and token requests must stay on the configured origin.");
      }
      return fetch(to, { ...init, redirect: "error" });
    },
  });
}

function client() {
  return new Client({ name: "superbot-t3-inbox", version: "1.0.0" });
}

const timeout = { timeout: 30_000 };

export async function authorize(url, showAuthorizationUrl) {
  const state = randomBytes(32).toString("base64url");
  const callback = Promise.withResolvers();
  const listener = createServer((request, response) => {
    const params = new URL(request.url, "http://127.0.0.1");
    const code = params.searchParams.get("code");
    const isCallback =
      request.method === "GET" &&
      params.pathname === "/callback" &&
      params.searchParams.get("state") === state;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.statusCode = !isCallback ? 404 : code ? 200 : 400;
    response.end(!isCallback ? "Not found." : code ? "Return to the terminal." : "Sign-in denied.");
    if (isCallback) callback.resolve(code);
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const redirectUrl = `http://127.0.0.1:${listener.address().port}/callback`;
  let registration;
  let verifier;
  let tokens;
  let showedAuthorizationUrl = false;
  const oauth = {
    redirectUrl,
    clientMetadata: {
      client_name: "Superbot T3 Code inbox",
      redirect_uris: [redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    state: () => state,
    clientInformation: () => registration,
    saveClientInformation: (value) => {
      registration = value;
    },
    codeVerifier: () => verifier,
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    redirectToAuthorization: (authorizationUrl) => {
      if (authorizationUrl.origin !== url.origin) {
        throw new Error("T3 advertised authorization on a different origin.");
      }
      showedAuthorizationUrl = true;
      showAuthorizationUrl(authorizationUrl.href);
    },
  };
  const connection = transport(url, { authProvider: oauth });
  const mcp = client();
  try {
    try {
      await mcp.connect(connection, timeout);
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !showedAuthorizationUrl) {
        throw new Error("T3 MCP sign-in could not start. Check the MCP URL and T3 version.");
      }
    }
    if (!showedAuthorizationUrl)
      throw new Error("The endpoint did not ask for external MCP OAuth.");
    const deadline = AbortSignal.timeout(5 * 60_000);
    deadline.addEventListener("abort", () => callback.resolve(null), { once: true });
    const code = await callback.promise;
    if (!code) throw new Error("T3 MCP sign-in was denied or expired.");
    try {
      await connection.finishAuth(code);
    } catch {
      throw new Error("T3 rejected the OAuth exchange. Restart the sign-in.");
    }
    if (!tokens?.access_token) throw new Error("T3 did not issue an MCP access token.");
    return { url: url.href, token: tokens.access_token };
  } finally {
    listener.close();
    await mcp.close();
  }
}

export async function withT3(auth, work) {
  const mcp = client();
  const url = endpoint(auth.url, "/mcp");
  const connection = transport(url, {
    requestInit: { headers: { authorization: `Bearer ${auth.token}` } },
  });
  try {
    try {
      await mcp.connect(connection, timeout);
    } catch {
      throw new Error(
        "Could not connect with the saved T3 OAuth grant. Check the endpoint and grant.",
      );
    }
    return await work(async (name, args) => {
      let result;
      try {
        result = await mcp.callTool({ name, arguments: args }, undefined, timeout);
      } catch {
        throw new Error(`${name} did not return a receipt. Retry with the same options and grant.`);
      }
      const data = result.structuredContent;
      if (result.isError || !data || data.code) {
        const code = data?.code;
        const detail = typeof code === "string" && /^[a-z_]{1,60}$/.test(code) ? ` (${code})` : "";
        throw new Error(`${name} failed${detail}. Check T3 before retrying.`);
      }
      return data;
    });
  } finally {
    await mcp.close();
  }
}
