import { afterEach, describe, expect, it } from "vitest";
import { SERVER_UNREACHABLE, SuperbotError } from "../errors.js";
import { Client } from "./client.js";
import { eventMessage } from "./messages.js";
import type { Exchange } from "./wire-fixture.test-support.js";
import { eventStream, json, wireFixture } from "./wire-fixture.test-support.js";

const fixtures: Awaited<ReturnType<typeof wireFixture>>[] = [];

async function fixture(exchanges: Exchange[]) {
  const server = await wireFixture(exchanges);
  fixtures.push(server);
  return { server, client: new Client(server.origin) };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((server) => server.close()));
});

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const event of events) all.push(event);
  return all;
}

async function failure(promise: Promise<unknown>): Promise<SuperbotError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SuperbotError);
  return error as SuperbotError;
}

describe("Client", () => {
  it("signs in, discovers, sends, follows and signs out", async () => {
    const { server, client } = await fixture([
      {
        ...json("/api/auth/sign-in/email", '{"token":"unsigned-body-token"}'),
        headers: { "content-type": "application/json", "set-auth-token": "session.signature%3D" },
      },
      json(
        "/rpc/spaces/list",
        '{"json":{"current":{"id":"space-1"},"spaces":[{"id":"space-1","name":"Personal"}]}}',
      ),
      json(
        "/rpc/organizations/list",
        '{"json":{"activeOrganizationId":"org-1","organizations":[{"id":"org-1","defaultSpaceId":"space-1","spaceIds":["space-1"]},{"id":"org-2","defaultSpaceId":"space-2","spaceIds":["space-2"]}]}}',
      ),
      json(
        "/rpc/spaces/list",
        '{"json":{"spaces":[{"id":"space-2","name":"Team"},{"id":"space-1","name":"Personal"}]}}',
      ),
      json("/rpc/bots/list", '{"json":[{"id":"bot-1","name":"Research"}]}'),
      json(
        "/rpc/threads/get",
        '{"json":{"threadId":"thread-1","cursor":4,"messages":[{"id":"m0","seq":1,"role":"bot","blocks":[{"kind":"text","text":"Welcome"}]}]}}',
      ),
      json(
        "/rpc/threads/send",
        '{"json":{"taskId":"task-1","runId":"run-1","runIds":["run-1"],"seq":2}}',
      ),
      eventStream(
        "/rpc/threads/subscribe",
        [
          ": keepalive\r\n\r\n",
          'event: message\r\ndata: {"json":{"type":"heartbeat","seq":0,"id":"heartbeat","payload":{}}}\r\n\r\n',
          'event: message\ndata: {"json":{"type":"thread.message.created","seq":6,"id":"event-1","runId":"run-1","payload":{"messageId":"reply-1","seq":3,"role":"bot","blocks":[{"kind":"text","text":"Caffè ☕"}]}}}\n\n',
          'event: message\ndata: {"json":{"type":"run.completed","seq":7,"id":"event-2","runId":"run-1","payload":{}}}\n\n',
          "event: done\ndata: {}\n\n",
        ].join(""),
      ),
      json("/api/auth/sign-out", '{"success":true}'),
    ]);

    const signedIn = await client.signIn("fixture@example.test", "fixture-password");
    const spaces = await signedIn.listSpaces();
    expect(spaces.map((space) => space.name)).toEqual(["Personal", "Team"]);
    const space = spaces[0]!;
    const agent = (await signedIn.listAgents(space.id))[0]!;
    expect(agent.name).toBe("Research");
    const snapshot = await signedIn.thread(space.id, agent.id);
    expect(snapshot.messages[0]?.text).toBe("Welcome");
    const sent = await signedIn.sendWithNonce(space.id, agent.id, "Hello", "nonce-1");
    expect(sent.seq).toBe(2);
    const events = await collect(await signedIn.subscribe(space.id, agent.id, snapshot.cursor));
    expect(events.map((event) => event.type)).toEqual([
      "heartbeat",
      "thread.message.created",
      "run.completed",
    ]);
    expect(eventMessage(events[1]!)).toMatchObject({ id: "reply-1", seq: 3, text: "Caffè ☕" });
    expect(events[2]?.runId).toBe(sent.runId);
    await signedIn.signOut();

    const requests = server.requests;
    expect(requests[0]?.headers.origin).toBe("rakazo://");
    expect(requests[0]?.body).toEqual({
      email: "fixture@example.test",
      password: "fixture-password",
    });
    for (const request of requests.slice(1)) {
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe("Bearer session.signature%3D");
      expect(request.headers.cookie).toBeUndefined();
    }
    expect(requests[1]?.headers["x-rakazo-space-id"]).toBeUndefined();
    expect(requests[3]?.headers["x-rakazo-space-id"]).toBe("space-2");
    for (const request of requests.slice(4, 8)) {
      expect(request.headers["x-rakazo-space-id"]).toBe("space-1");
    }
    expect(requests[6]?.body).toEqual({
      json: { botId: "bot-1", text: "Hello", clientNonce: "nonce-1" },
    });
    expect(requests[7]?.body).toEqual({ json: { botId: "bot-1", cursor: 4 } });
    expect(requests[7]?.headers.accept).toBe("text/event-stream");
    expect(requests[8]?.path).toBe("/api/auth/sign-out");
    expect(server.pending()).toBe(0);
  });

  it("gives each send a fresh nonce unless the caller retries with its own", async () => {
    const receipt = '{"json":{"taskId":"task-1","runId":"run-1","seq":2}}';
    const { server, client } = await fixture([
      json("/rpc/threads/send", receipt),
      json("/rpc/threads/send", receipt),
      json("/rpc/threads/send", receipt),
      json("/rpc/threads/send", receipt),
    ]);
    const signedIn = client.withToken("fixture.signature");
    await signedIn.sendMessage("space", "bot", "One");
    await signedIn.sendMessage("space", "bot", "One");
    await signedIn.sendWithNonce("space", "bot", "Two", "retry-key");
    await signedIn.sendWithNonce("space", "bot", "Two", "retry-key");
    const nonces = server.requests.map(
      (request) => (request.body as { json: { clientNonce: string } }).json.clientNonce,
    );
    expect(nonces[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(nonces[1]).not.toBe(nonces[0]);
    expect(nonces.slice(2)).toEqual(["retry-key", "retry-key"]);
  });

  it("refuses an empty or oversized message before sending it", async () => {
    const signedIn = new Client("https://example.test").withToken("fixture.signature");
    for (const text of [" \n", "x".repeat(100_001)]) {
      expect((await failure(signedIn.sendMessage("space", "bot", text))).kind).toBe(
        "invalidMessage",
      );
    }
  });

  it("records local history with signed text-only requests", async () => {
    const { server, client } = await fixture([
      json("/rpc/threads/appendLocalHistory", '{"json":{"messageIds":["note"]}}'),
      json("/rpc/threads/appendLocalHistory", '{"json":{"messageIds":["prompt","reply"]}}'),
    ]);
    const signedIn = client.withToken("fixture.signature");
    const operationId = "4f7df854-760b-4aaf-9efe-ed8442d81c43";
    const note = await signedIn.appendLocalNote("space", { botId: "agent" }, operationId, "Note");
    const turn = await signedIn.appendLocalTurn(
      "space",
      { groupId: "room" },
      operationId,
      "Prompt",
      "Reply",
    );
    expect(note.messageIds).toEqual(["note"]);
    expect(turn.messageIds).toEqual(["prompt", "reply"]);
    for (const request of server.requests) {
      expect(request.headers.authorization).toBe("Bearer fixture.signature");
      expect(request.headers["x-rakazo-space-id"]).toBe("space");
    }
    expect(server.requests[0]?.body).toEqual({
      json: { botId: "agent", operationId, text: "Note" },
    });
    expect(server.requests[1]?.body).toEqual({
      json: { groupId: "room", operationId, text: "Prompt", reply: "Reply" },
    });
  });

  it("lists, creates and updates bot conversations", async () => {
    const conversation =
      '{"threadId":"t-2","botId":"bot","createdAt":"2026-01-01T00:00:00.000Z","title":"Plans","pinnedAt":null,"archivedAt":null,"preview":null}';
    const { server, client } = await fixture([
      json("/rpc/threads/listBotConversations", `{"json":[${conversation}]}`),
      json("/rpc/threads/createBotConversation", `{"json":${conversation}}`),
      json("/rpc/threads/updateBotConversation", `{"json":${conversation}}`),
    ]);
    const signedIn = client.withToken("fixture.signature");
    expect(await signedIn.listBotConversations("space", "bot")).toHaveLength(1);
    expect((await signedIn.createBotConversation("space", "bot")).threadId).toBe("t-2");
    await signedIn.updateBotConversation("space", "bot", "t-2", { pinned: true });
    expect(server.requests.map((request) => request.body)).toEqual([
      { json: { botId: "bot" } },
      { json: { botId: "bot" } },
      { json: { botId: "bot", threadId: "t-2", pinned: true } },
    ]);
  });

  it("resumes a group stream after its cursor with both speaker identities", async () => {
    const { server, client } = await fixture([
      eventStream(
        "/rpc/threads/subscribe",
        [
          'event: message\ndata: {"json":{"id":"ev1","seq":14,"type":"thread.message.created","botId":"agent-1","payload":{"messageId":"m1","seq":9,"role":"user","author":{"id":"member-1","name":"Casey"},"blocks":[{"kind":"text","text":"Hello"}]}}}\n\n',
          'event: message\ndata: {"json":{"id":"ev2","seq":15,"type":"thread.message.created","botId":"agent-1","payload":{"messageId":"m2","seq":10,"role":"bot","blocks":[{"kind":"text","text":"Hi"}]}}}\n\n',
          'event: message\ndata: {"json":{"id":"ev3","seq":16,"type":"thread.message.created","botId":"thread","payload":{"messageId":"m3","seq":11,"role":"bot","origin":"local_cli","author":{"id":"member-1","name":"Casey"},"blocks":[{"kind":"text","text":"Local reply"}]}}}\n\n',
          "event: done\ndata: {}\n\n",
        ].join(""),
      ),
    ]);
    const signedIn = client.withToken("fixture.signature");
    const events = await collect(
      await signedIn.subscribeThread("shared-space", { groupId: "room" }, 13),
    );
    const [human, bot, local] = events.map((event) => eventMessage(event));
    expect(human?.author?.name).toBe("Casey");
    expect(human?.botId).toBeUndefined();
    expect(bot?.botId).toBe("agent-1");
    expect(local?.origin).toBe("local_cli");
    expect(local?.author?.id).toBe("member-1");
    expect(local?.botId).toBeUndefined();
    expect(local?.runId).toBeUndefined();
    expect(server.requests[0]?.body).toEqual({ json: { groupId: "room", cursor: 13 } });
    expect(server.requests[0]?.headers["x-rakazo-space-id"]).toBe("shared-space");
  });

  it("reconnects from the last event it consumed", async () => {
    const event = (seq: number) =>
      `event: message\ndata: {"json":{"id":"ev${seq}","seq":${seq},"type":"run.completed","botId":"bot","payload":{}}}\n\n`;
    const { server, client } = await fixture([
      eventStream("/rpc/threads/subscribe", `${event(5)}${event(6)}`),
      eventStream("/rpc/threads/subscribe", `${event(7)}event: done\ndata: {}\n\n`),
    ]);
    const signedIn = client.withToken("fixture.signature");
    let cursor = 4;
    for (const _connection of [1, 2]) {
      for await (const next of await signedIn.subscribe("space", "bot", cursor)) cursor = next.seq;
    }
    expect(cursor).toBe(7);
    expect(server.requests.map((request) => request.body)).toEqual([
      { json: { botId: "bot", cursor: 4 } },
      { json: { botId: "bot", cursor: 6 } },
    ]);
  });

  it("refuses a thread event without the fields every event has", async () => {
    const { client } = await fixture([
      eventStream("/rpc/threads/subscribe", 'event: message\ndata: {"json":{"type":"x"}}\n\n'),
    ]);
    const events = await client.withToken("fixture.signature").subscribe("space", "bot", 0);
    const error = await failure(events.next());
    expect(error.kind).toBe("protocol");
  });

  it("keeps the other organizations' Spaces in the picker", async () => {
    const { server, client } = await fixture([
      json(
        "/rpc/organizations/list",
        '{"json":{"activeOrganizationId":"team-org","organizations":[{"id":"team-org","defaultSpaceId":"team","spaceIds":["team"]},{"id":"home-org","defaultSpaceId":"home","spaceIds":["home"]}]}}',
      ),
      json(
        "/rpc/spaces/list",
        '{"json":{"spaces":[{"id":"home","name":"Personal"},{"id":"team","name":"Team","shared":true}]}}',
      ),
    ]);
    const signedIn = client.withToken("fixture.signature");
    const current = { id: "team", name: "Team", shared: true } as never;
    const spaces = await signedIn.includeOtherSpaces("team", [current]);
    expect(spaces.map((space) => space.id)).toEqual(["team", "home"]);
    expect(server.requests[0]?.headers["x-rakazo-space-id"]).toBe("team");
    expect(server.requests[1]?.headers["x-rakazo-space-id"]).toBe("home");
  });

  it("keeps the listed Spaces when the server has no organizations", async () => {
    const { client } = await fixture([{ path: "/rpc/organizations/list", status: 404, body: "" }]);
    const current = { id: "team", name: "Team" } as never;
    const spaces = await client.withToken("fixture.signature").includeOtherSpaces(null, [current]);
    expect(spaces).toEqual([current]);
  });

  it("signs up into a session or asks to verify the mailbox, and requires a signed session", async () => {
    const path = "/api/auth/sign-up/email";
    const { server, client } = await fixture([
      {
        ...json(path, '{"token":"unsigned","user":{"name":"Alex"}}'),
        headers: {
          "content-type": "application/json",
          "set-cookie": "better-auth.session_token=signed.fixture; HttpOnly",
        },
      },
      json(path, '{"token":null,"user":{"name":"Alex"}}'),
      json(path, '{"token":"unsigned"}'),
    ]);
    const signUp = () => client.signUp("Alex", "alex@example.test", "fixture-password");
    const signedIn = await signUp();
    expect(signedIn.kind).toBe("signedIn");
    expect(await signUp()).toEqual({ kind: "verifyEmail" });
    expect((await failure(signUp())).kind).toBe("invalidSession");
    expect(server.requests[0]?.body).toEqual({
      email: "alex@example.test",
      name: "Alex",
      password: "fixture-password",
    });
  });

  it("requests and redeems an email sign-in code", async () => {
    const { server, client } = await fixture([
      json("/api/auth/email-otp/send-verification-otp", '{"success":true}'),
      {
        ...json("/api/auth/sign-in/email-otp", "{}"),
        headers: { "set-auth-token": "code.signature" },
      },
    ]);
    await client.requestSignInCode("fixture@example.test");
    const signedIn = await client.signInWithCode("fixture@example.test", "123456");
    expect(signedIn.server).toBe(client.server);
    expect(server.requests.map((request) => request.body)).toEqual([
      { email: "fixture@example.test", type: "sign-in" },
      { email: "fixture@example.test", otp: "123456" },
    ]);
  });

  it("reports HTTP and stream authorization errors", async () => {
    const { client } = await fixture([
      {
        ...json(
          "/rpc/spaces/list",
          '{"json":{"status":401,"code":"UNAUTHORIZED","message":"Session expired"}}',
        ),
        status: 401,
      },
      eventStream(
        "/rpc/threads/subscribe",
        'event: error\ndata: {"json":{"status":401,"code":"UNAUTHORIZED","message":"Session expired"}}\n\n',
      ),
    ]);
    const signedIn = client.withToken("session.signature");
    const error = await failure(signedIn.listSpaces());
    expect(error.isUnauthorized()).toBe(true);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.message).toContain("Session expired");
    const stream = await signedIn.subscribe("space-1", "bot-1", 4);
    expect((await failure(stream.next())).isUnauthorized()).toBe(true);
    expect((await stream.next()).done).toBe(true);
  });

  it("reports gateways as unavailable with or without a body", async () => {
    const exchanges = [502, 503, 504].flatMap((status) =>
      ["", '{"json":{"status":401,"message":"Proxy error"}}'].map((body) => ({
        path: "/rpc/me",
        status,
        headers: { "content-type": "application/json", "retry-after": "3" },
        body,
      })),
    );
    const { server, client } = await fixture(exchanges);
    const signedIn = client.withToken("fixture.signature");
    for (const _exchange of exchanges) {
      const error = await failure(signedIn.rpc("me", null, {}));
      expect(error.kind).toBe("unavailable");
      expect(error.retryAfterMs).toBe(3_000);
      expect(error.isRetryable()).toBe(true);
      expect(error.isUnauthorized()).toBe(false);
      expect(error.message).toBe(SERVER_UNREACHABLE);
    }
    expect(server.pending()).toBe(0);
  });

  it("refuses unsigned sessions and does not follow a redirected sign-in", async () => {
    const { client } = await fixture([
      json("/api/auth/sign-in/email", '{"token":"unsigned"}'),
      {
        path: "/api/auth/sign-in/email",
        status: 307,
        headers: { location: "http://127.0.0.1:1/" },
      },
    ]);
    const signIn = () => client.signIn("fixture@example.test", "fixture-password");
    expect((await failure(signIn())).kind).toBe("invalidSession");
    const redirected = await failure(signIn());
    expect([redirected.kind, redirected.status]).toEqual(["server", 307]);
  });

  it("needs a session before calling procedures", async () => {
    const client = new Client("https://example.test");
    expect((await failure(client.rpc("me", null, {}))).isUnauthorized()).toBe(true);
    expect((await failure(client.subscribeNotifications("space"))).kind).toBe("missingSession");
    expect((await failure(client.signOut())).kind).toBe("missingSession");
  });

  it("refuses procedure paths outside the RPC namespace", async () => {
    const signedIn = new Client("https://example.test").withToken("fixture.signature");
    for (const path of ["", "../api/auth/sign-out", "threads//get", "threads/get?x=1"]) {
      expect((await failure(signedIn.rpc(path, null, {}))).kind).toBe("protocol");
    }
  });

  it("accepts only signed session tokens", () => {
    const client = new Client("https://example.test");
    for (const token of ["unsigned", ".signature", "session.", "session. signature", ""]) {
      expect(() => client.withToken(token)).toThrow(SuperbotError);
    }
    expect(client.withToken("session.signature").server).toBe("https://example.test/");
  });

  it("reports an unreachable server as a transport failure", async () => {
    const { server, client } = await fixture([]);
    await server.close();
    fixtures.splice(fixtures.indexOf(server), 1);
    const error = await failure(client.withToken("fixture.signature").rpc("me", null, {}));
    expect(error.kind).toBe("transport");
    expect(error.isRetryable()).toBe(true);
  });

  it("follows Space hints and drops chat alerts, heartbeats and unknown kinds", async () => {
    const { server, client } = await fixture([
      eventStream(
        "/rpc/notifications/subscribe",
        [
          'event: message\ndata: {"json":{"type":"heartbeat"}}\n\n',
          'event: message\ndata: {"json":{"type":"alert","alert":{"body":"Private chat text"}}}\n\n',
          'event: message\ndata: {"json":{"type":"roster"}}\n\n',
          'event: message\ndata: {"json":{"type":"runs"}}\n\n',
          'event: message\ndata: {"json":{"type":"organizations"}}\n\n',
          'event: message\ndata: {"json":{"type":"unknownFutureSignal"}}\n\n',
          "event: done\ndata: {}\n\n",
        ].join(""),
      ),
      {
        ...json("/rpc/notifications/subscribe", '{"json":{"status":401,"code":"UNAUTHORIZED"}}'),
        status: 401,
      },
    ]);
    const signedIn = client.withToken("fixture.signature");
    const hints = await collect(await signedIn.subscribeNotifications("space-1"));
    expect(hints).toEqual(["roster", "runs", "organizations"]);
    expect((await failure(signedIn.subscribeNotifications("space-2"))).isUnauthorized()).toBe(true);
    server.requests.forEach((request, index) => {
      expect(request.headers["x-rakazo-space-id"]).toBe(`space-${index + 1}`);
      expect(request.headers.authorization).toBe("Bearer fixture.signature");
      expect(request.body).toEqual({ json: {} });
    });
  });

  it("refuses a stream procedure that answers with a plain result", async () => {
    const { client } = await fixture([json("/rpc/threads/subscribe", '{"json":{}}')]);
    const error = await failure(client.withToken("fixture.signature").subscribe("space", "bot", 0));
    expect(error.message).toContain("expected a Superbot event stream");
  });
});
