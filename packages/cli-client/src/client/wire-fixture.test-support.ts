import { once } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted answer, served for a request to `path`. */
export type Exchange = {
  path: string;
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: string;
};

export type RecordedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
};

export const json = (path: string, body: string): Exchange => ({
  path,
  headers: { "content-type": "application/json" },
  body,
});

export const gatewayError = (path: string, headers?: Record<string, string>): Exchange => ({
  path,
  status: 502,
  headers,
});

export const eventStream = (path: string, body: string): Exchange => ({
  path,
  headers: { "content-type": "text/event-stream" },
  body,
});

/**
 * A local HTTP server that answers each request with the next scripted exchange, in order, and
 * records what it was sent. A request for an unexpected path gets a 418 so the test fails.
 */
export async function wireFixture(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const path = request.url ?? "";
    requests.push({
      method: request.method ?? "",
      path,
      headers: request.headers,
      body: text ? JSON.parse(text) : undefined,
    });
    const exchange = queue.shift();
    if (!exchange || exchange.path !== path) {
      response.writeHead(418, { "content-type": "text/plain" });
      response.end(`Unexpected request for ${path}; expected ${exchange?.path ?? "none"}`);
      return;
    }
    response.writeHead(exchange.status ?? 200, { connection: "close", ...exchange.headers });
    response.end(exchange.body ?? "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    /** Exchanges not yet served. */
    pending: () => queue.length,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
