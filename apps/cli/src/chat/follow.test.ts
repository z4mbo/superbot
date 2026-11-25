import { describe, expect, it } from "vitest";
import type { Exchange } from "../test/loopback.test-support.js";
import {
  AGENT,
  card,
  event,
  events,
  loopback,
  refused,
  rpc,
  snapshot,
} from "../test/loopback.test-support.js";
import { scriptedIo } from "../test/scripted-io.test-support.js";
import type { Snapshot } from "../threads/thread-api.js";
import { ChatThread, followReply, resumeWaiting } from "./follow.js";

const BUDGET = 30_000;

function thread(client: ChatThread["client"], interactive: boolean, io = scriptedIo().io) {
  return new ChatThread({ client, spaceId: "space-1", agent: AGENT, interactive, io });
}

/** A read of the approval choice that answers once with `input` and fails the test if asked again. */
function oneAnswer(input: string | null) {
  let asked = 0;
  return {
    read: async () => {
      asked += 1;
      if (asked > 1) throw new Error("exactly one terminal prompt");
      return input;
    },
    asked: () => asked,
  };
}

const never = async (): Promise<string | null> => {
  throw new Error("the approval must not be read here");
};

async function answerThroughStream(input: string, action: string, stale: boolean) {
  const requested = [
    event(4, "thread.message.created", { messageId: "message-1", role: "bot", blocks: [card()] }),
    event(5, "run.waiting_input", {}),
  ];
  const answer = { botId: "bot-1", runId: "run-1", messageId: "message-1", answer: action };
  const exchanges: Exchange[] = [
    events(3, requested),
    rpc("threads/get", { botId: "bot-1" }, snapshot(card())),
    stale
      ? refused(
          "threads/answer",
          answer,
          409,
          "CONFLICT",
          "This prompt is no longer awaiting an answer",
        )
      : rpc("threads/answer", answer, { ok: true }),
  ];
  if (!stale) {
    exchanges.push(
      events(5, [
        event(6, "thread.message.created", {
          role: "bot",
          blocks: [{ kind: "text", text: action === "allow" ? "212 Fahrenheit" : "Denied." }],
        }),
        event(7, "run.completed", {}),
      ]),
    );
  }
  const server = await loopback(exchanges);
  const terminal = scriptedIo();
  const choice = oneAnswer(input);
  const cursor = { value: 3 };
  await followReply(
    thread(server.client, true, terminal.io),
    cursor,
    ["run-1"],
    undefined,
    choice.read,
    BUDGET,
  );
  expect(choice.asked()).toBe(1);
  expect(cursor.value).toBe(stale ? 5 : 7);
  server.assertDone();
  return terminal;
}

describe("approvals in a chat", () => {
  it("approves once and follows the run to completion", async () => {
    const terminal = await answerThroughStream("1", "allow", false);
    expect(terminal.stdout()).toContain("  1. Allow once\n  2. Deny\n");
    expect(terminal.stdout()).toContain("Tools > 212 Fahrenheit\n");
  });

  it("denies and follows the run to completion", async () => {
    const terminal = await answerThroughStream("2", "deny", false);
    expect(terminal.stdout()).toContain("Tools > Denied.\n");
  });

  it("never retries a stale answer", async () => {
    const terminal = await answerThroughStream("1", "allow", true);
    expect(terminal.stderr()).toContain("This approval is no longer awaiting an answer.\n");
  });

  it("leaves the card pending for piped input, an empty line or another choice", async () => {
    const server = await loopback([
      events(3, [event(5, "run.waiting_input", {})]),
      rpc("threads/get", { botId: "bot-1" }, snapshot(card())),
    ]);
    const piped = scriptedIo();
    const cursor = { value: 3 };
    await followReply(
      thread(server.client, false, piped.io),
      cursor,
      ["run-1"],
      undefined,
      never,
      BUDGET,
    );
    expect(cursor.value).toBe(5);
    expect(piped.stderr()).toBe(
      "Approval left pending. Reopen the chat in an interactive terminal to answer.\n",
    );
    server.assertDone();
    const waiting = snapshot(card()) as unknown as Snapshot;
    for (const input of [null, "", "always", "3"]) {
      const outcome = await thread(server.client, true).offer(
        waiting,
        "run-1",
        oneAnswer(input).read,
      );
      expect(outcome).toBe("leftPending");
    }
  });

  it("leaves secret, typed, Space-wide and receipt cards to Superbot", async () => {
    const server = await loopback([]);
    const secret = { ...card(), input: "secret" };
    const typed = { ...card(), input: "text" };
    const scope = card();
    (scope.actions as Array<{ label: string }>)[0] = {
      ...(scope.actions as Array<{ id: string; label: string }>)[0],
      label: "Allow in this space",
    } as { label: string };
    const receipt = { ...card(), receipt: {} };
    for (const block of [secret, typed, scope, receipt]) {
      const terminal = scriptedIo();
      const outcome = await thread(server.client, true, terminal.io).offer(
        snapshot(block) as unknown as Snapshot,
        "run-1",
        never,
      );
      expect(outcome).toBe("leftPending");
      expect(terminal.stderr()).toBe(
        "The agent is waiting for input. Open Superbot to answer this card.\n",
      );
    }
  });

  it("resumes an outstanding approval from the first snapshot", async () => {
    const server = await loopback([
      rpc("threads/get", { botId: "bot-1" }, snapshot(card())),
      rpc(
        "threads/answer",
        { botId: "bot-1", runId: "run-1", messageId: "message-1", answer: "allow" },
        { ok: true },
      ),
      events(5, [event(6, "run.completed", {})]),
    ]);
    const chat = thread(server.client, true);
    const first = await chat.snapshot();
    const cursor = { value: first.cursor };
    await resumeWaiting(chat, first, cursor, oneAnswer("1").read, BUDGET);
    expect(cursor.value).toBe(6);
    server.assertDone();
  });

  it("does not offer a card again for a replayed waiting event once it is answered", async () => {
    const resolved = snapshot(card());
    resolved.activeRuns = [{ id: "run-1", status: "running" }];
    const server = await loopback([
      events(3, [event(5, "run.waiting_input", {})]),
      rpc("threads/get", { botId: "bot-1" }, resolved),
      events(5, [event(6, "run.completed", {})]),
    ]);
    const cursor = { value: 3 };
    await followReply(thread(server.client, true), cursor, ["run-1"], undefined, never, BUDGET);
    expect(cursor.value).toBe(6);
    server.assertDone();
  });

  it("gives up after three dropped reconnects", async () => {
    const server = await loopback([events(3, []), events(3, []), events(3, []), events(3, [])]);
    const terminal = scriptedIo();
    await followReply(
      thread(server.client, true, terminal.io),
      { value: 3 },
      ["run-1"],
      undefined,
      never,
      BUDGET,
    );
    expect(terminal.stderr()).toBe(
      "The reply stream disconnected. Reopen the chat to see its latest messages.\n",
    );
    server.assertDone();
  });
});
