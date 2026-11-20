import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import { T3McpEmulator } from "../../packages/adapters/src/providers/cloud-agent/t3code/t3code-mcp-emulator.test-support.ts";

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");

/**
 * T3 Code's external MCP server on loopback for fixtures: the shared tool emulator behind
 * T3's public-client OAuth (protected resource metadata, dynamic registration, PKCE S256).
 * The authorization page approves at once, as an operator choosing Supervised would.
 */
export async function startFakeT3() {
  const emulator = new T3McpEmulator();
  emulator.token = base64url(randomBytes(24));
  const clients = new Map();
  const codes = new Map();
  const seen = { registrations: [], authorizations: 0, tokens: 0, denied: false };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) body += chunk;
      const json = (status, value) =>
        response
          .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify(value));
      if (url.pathname === "/mcp") {
        const answer = await emulator.fetch(new URL("/mcp", origin), {
          method: request.method,
          headers: Object.entries(request.headers).filter(([, value]) => typeof value === "string"),
          body: request.method === "POST" ? body : undefined,
        });
        const headers = Object.fromEntries(answer.headers);
        if (answer.status === 401) {
          headers["www-authenticate"] =
            `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`;
        }
        response.writeHead(answer.status, headers).end(Buffer.from(await answer.arrayBuffer()));
        return;
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/oauth/register" && request.method === "POST") {
        const metadata = JSON.parse(body);
        assert.equal(metadata.token_endpoint_auth_method, "none");
        assert.equal(metadata.redirect_uris.length, 1);
        assert.match(metadata.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        const clientId = `client-${clients.size + 1}`;
        clients.set(clientId, metadata);
        seen.registrations.push(metadata);
        return json(201, { client_id: clientId, ...metadata });
      }
      if (url.pathname === "/oauth/authorize" && request.method === "GET") {
        const query = url.searchParams;
        const client = clients.get(query.get("client_id"));
        const redirect = query.get("redirect_uri");
        assert(client, "authorization for a registered client");
        assert(client.redirect_uris.includes(redirect), "registered redirect");
        assert.equal(query.get("response_type"), "code");
        assert.equal(query.get("code_challenge_method"), "S256");
        assert.equal(query.get("resource"), `${origin}/mcp`);
        seen.authorizations += 1;
        const back = new URL(redirect);
        back.searchParams.set("state", query.get("state"));
        if (seen.denied) {
          back.searchParams.set("error", "access_denied");
        } else {
          const code = base64url(randomBytes(16));
          codes.set(code, {
            client: query.get("client_id"),
            redirect,
            challenge: query.get("code_challenge"),
          });
          back.searchParams.set("code", code);
        }
        response.writeHead(302, { location: back.href, "cache-control": "no-store" }).end();
        return;
      }
      if (url.pathname === "/oauth/token" && request.method === "POST") {
        const form = new URLSearchParams(body);
        const grant = codes.get(form.get("code"));
        codes.delete(form.get("code"));
        const verified =
          grant &&
          form.get("grant_type") === "authorization_code" &&
          form.get("client_id") === grant.client &&
          form.get("redirect_uri") === grant.redirect &&
          form.get("resource") === `${origin}/mcp` &&
          base64url(
            createHash("sha256")
              .update(form.get("code_verifier") ?? "")
              .digest(),
          ) === grant.challenge;
        if (!verified) return json(400, { error: "invalid_grant" });
        seen.tokens += 1;
        return json(200, { access_token: emulator.token, token_type: "Bearer" });
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500).end();
      console.error(`fake T3: ${error.message}`);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/mcp`,
    emulator,
    seen,
    launches: () => emulator.calls.filter(({ tool }) => tool === "t3_thread_launch"),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
