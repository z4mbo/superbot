import { once } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

/** One scripted registry call: the procedure and input expected, and the answer sent back. */
export type Exchange = {
  procedure: string;
  input?: unknown;
  response: unknown;
  status?: number;
};

export type RecordedCall = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The oRPC body's `json` member: the procedure's input. */
  input: unknown;
};

/**
 * A loopback server that answers each RPC with the next scripted exchange, in order, and records
 * what it was sent. A call to an unexpected procedure gets a 418 so the test fails.
 */
export function useRegistryFixture() {
  const servers: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });
  return async (exchanges: Exchange[]) => {
    const queue = [...exchanges];
    const calls: RecordedCall[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? (JSON.parse(text) as { json?: unknown }) : undefined;
      const path = request.url ?? "";
      calls.push({
        method: request.method ?? "",
        path,
        headers: request.headers,
        input: body?.json,
      });
      const exchange = queue.shift();
      if (!exchange || path !== `/rpc/${exchange.procedure}`) {
        response.writeHead(418, { "content-type": "text/plain" });
        response.end(`Unexpected request for ${path}; expected ${exchange?.procedure ?? "none"}`);
        return;
      }
      const reply = JSON.stringify({ json: exchange.response });
      response.writeHead(exchange.status ?? 200, {
        connection: "close",
        "content-type": "application/json",
      });
      response.end(reply);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const close = async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    };
    servers.push({ close });
    const { port } = server.address() as AddressInfo;
    return {
      origin: `http://127.0.0.1:${port}`,
      calls,
      /** Exchanges not yet served. */
      pending: () => queue.length,
    };
  };
}
