/**
 * A loopback Superbot server for command tests: each exchange answers one request in order and
 * checks what the client sent.
 */
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@rakazo/cli-client";
import { afterEach, expect } from "vitest";

export type Exchange = {
  path: string;
  /** The Space header the request must carry; null for account-wide requests. */
  space: string | null;
  /** The input the request must send; undefined skips the check (auth endpoints). */
  input?: unknown;
  /** Input fields the client fills with fresh values, checked only for presence. */
  fresh?: string[];
  status: number;
  contentType: string;
  headers?: Record<string, string>;
  body: string;
};

/** An RPC call answered with JSON, scoped to the fixture Space unless told otherwise. */
export function rpc(
  procedure: string,
  input: unknown,
  response: unknown,
  options: { status?: number; space?: string | null; fresh?: string[] } = {},
): Exchange {
  const status = options.status ?? 200;
  return {
    path: `/rpc/${procedure}`,
    space: options.space === undefined ? "space-1" : options.space,
    input,
    fresh: options.fresh,
    status,
    contentType: "application/json",
    body: JSON.stringify(status >= 400 ? response : { json: response }),
  };
}

/** A refused RPC call with the server's error body. */
export function refused(
  procedure: string,
  input: unknown,
  status: number,
  code: string,
  message: string,
): Exchange {
  return rpc(procedure, input, { json: { code, status, message } }, { status });
}

/** A thread stream that replays `events` after `cursor` and then ends. */
export function events(
  cursor: number,
  list: unknown[],
  target: object = { botId: "bot-1" },
): Exchange {
  return {
    path: "/rpc/threads/subscribe",
    space: "space-1",
    input: { ...target, cursor },
    status: 200,
    contentType: "text/event-stream",
    body: `${list.map((event) => `event: message\ndata: ${JSON.stringify({ json: event })}\n\n`).join("")}event: done\ndata: {}\n\n`,
  };
}

export function event(seq: number, type: string, payload: unknown): unknown {
  return {
    id: `event-${seq}`,
    spaceId: "space-1",
    threadId: "thread-1",
    seq,
    runId: "run-1",
    botId: "bot-1",
    type,
    createdAt: "2026-11-20T00:00:00Z",
    payload,
  };
}

/** A pending tool approval as the server shows it. */
export function card(): Record<string, unknown> {
  return {
    kind: "ask",
    status: "pending",
    approvalEffectId: "effect-1",
    text: "Allow convert_temperature?",
    site: "units.example.test",
    detail: 'Endpoint: https://units.example.test/mcp\nArguments: {"value":100}',
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow this tool" },
      { id: "deny", label: "Deny" },
    ],
  };
}

export function snapshot(block: unknown): Record<string, unknown> & { messages: unknown[] } {
  return {
    threadId: "thread-1",
    cursor: 5,
    olderCursor: null,
    run: null,
    activeRuns: [{ id: "run-1", status: "waiting_input" }],
    messages: [
      {
        id: "message-1",
        role: "bot",
        seq: 1,
        threadId: "thread-1",
        runId: "run-1",
        createdAt: "2026-11-19T00:00:00Z",
        blocks: [block],
      },
    ],
  };
}

/** The requests that discover one Space with one agent, as `discover` makes them. */
export function discovery(): Exchange[] {
  return [
    rpc(
      "spaces/list",
      {},
      { current: { id: "space-1" }, spaces: [{ id: "space-1", name: "Personal" }] },
      { space: null },
    ),
    { ...refused("organizations/list", {}, 404, "NOT_FOUND", "Not found"), space: null },
    rpc("bots/list", {}, [{ id: "bot-1", name: "Tools" }]),
  ];
}

export function me(): Exchange {
  return rpc(
    "me",
    {},
    { userId: "user-1", email: "fixture@example.test", name: "Fixture" },
    { space: null },
  );
}

export const AGENT = { id: "bot-1", name: "Tools" };
export const SPACE = { id: "space-1", name: "Personal" };

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Starts a loopback server for `exchanges`; `done` resolves once each was served as expected. */
export async function loopback(exchanges: Exchange[], token = "fixture.signed") {
  const queue = [...exchanges];
  const failures: string[] = [];
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const text = await body(request);
    requests.push({ path: request.url ?? "", body: text ? JSON.parse(text) : undefined });
    const exchange = queue.shift();
    const path = request.url ?? "";
    const fail = (reason: string) => {
      failures.push(reason);
      response.writeHead(418, { "content-type": "application/json" });
      response.end(JSON.stringify({ json: { code: "FIXTURE", status: 418, message: reason } }));
    };
    if (!exchange) return fail(`Unexpected request for ${path}`);
    if (exchange.path !== path) return fail(`Expected ${exchange.path}, got ${path}`);
    if (path.startsWith("/rpc/")) {
      if (request.headers.authorization !== `Bearer ${token}`)
        return fail(`${path} sent no session`);
      const space = request.headers["x-rakazo-space-id"] ?? null;
      if (space !== exchange.space) return fail(`${path} scoped to ${String(space)}`);
    }
    if (exchange.input !== undefined) {
      const sent = (text ? JSON.parse(text) : {}) as { json?: Record<string, unknown> };
      const input = { ...(sent.json ?? {}) };
      for (const field of exchange.fresh ?? []) {
        if (!(field in input)) return fail(`${path} sent no ${field}`);
        delete input[field];
      }
      try {
        expect(input).toEqual(exchange.input);
      } catch {
        return fail(
          `${path} sent ${JSON.stringify(input)}, expected ${JSON.stringify(exchange.input)}`,
        );
      }
    }
    response.writeHead(exchange.status, {
      "content-type": exchange.contentType,
      connection: "close",
      ...exchange.headers,
    });
    response.end(exchange.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const handle = {
    origin,
    /** What each request sent, in order. */
    requests,
    client: new Client(origin).withToken(token),
    /** Every exchange was served, and every request was the expected one. */
    assertDone() {
      expect(failures).toEqual([]);
      expect(queue.map((exchange) => exchange.path)).toEqual([]);
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
  servers.push(handle);
  return handle;
}

/** A sign-in endpoint that answers with a signed session. */
export function signIn(path = "/api/auth/sign-in/email", token = "fixture.signed"): Exchange {
  return {
    path,
    space: null,
    status: 200,
    contentType: "application/json",
    headers: { "set-auth-token": token },
    body: JSON.stringify({ token: "unsigned" }),
  };
}

/** An auth endpoint that answers with an empty success. */
export function authOk(path: string): Exchange {
  return { path, space: null, status: 200, contentType: "application/json", body: "{}" };
}
