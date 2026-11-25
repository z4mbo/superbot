import { describe, expect, it } from "vitest";
import type { Update } from "../chat/reply.js";
import type { App, Effect, Key } from "./state.js";
import { identityColor, pressKey, receive, start } from "./state.js";
import { app, bot, pending } from "./tui.test-support.js";

const press = (state: App, code: Key["code"]): Effect[] =>
  pressKey(state, code === "char" ? { code, char: "" } : ({ code } as Key));
const type = (state: App, char: string, ctrl = false) =>
  pressKey(state, { code: "char", char, ctrl });

function reply(id: string, role: "user" | "bot", text: string): Update {
  return { kind: "message", message: { id, role, text, seq: 1, runId: "run-1" } };
}

describe("full-screen chat state", () => {
  it("opens the first agent once the roster arrives", () => {
    const state = app();
    expect(start()).toEqual([{ kind: "loadAgents" }, { kind: "loadApprovals" }]);
    const effects = receive(state, {
      kind: "agents",
      bots: [
        bot("bot-1", "Fixture agent", "#3B82F6::shape_round"),
        bot("bot-2", "Research", "plum"),
      ],
    });
    expect(effects).toEqual([
      { kind: "follow", chat: { agentId: "bot-1", threadId: undefined }, generation: 1 },
      { kind: "loadConversations", agentId: "bot-1" },
    ]);
    expect(state.agents[0]?.color).toEqual([0x3b, 0x82, 0xf6]);
    expect(state.agents[1]?.color).toBeUndefined();
    expect(state.focus).toBe("composer");
    // A later roster read keeps the selection and does not reopen the chat.
    press(state, "esc");
    expect(state.focus).toBe("agents");
    press(state, "down");
    expect(
      receive(state, {
        kind: "agents",
        bots: [
          bot("bot-0", "Atlas", "#000000"),
          bot("bot-1", "Fixture agent", "#3B82F6"),
          bot("bot-2", "Research", "#ffffff"),
        ],
      }),
    ).toEqual([]);
    expect(state.agents[state.agent]?.name).toBe("Research");
    expect(
      receive(state, {
        kind: "agents",
        bots: [{ ...bot("bot-2", "Research", "#ffffff"), archivedAt: "2026-11-20T00:00:00Z" }],
      }),
    ).toEqual([]);
    expect(state.agents).toEqual([]);
  });

  it("sends typed text to the open chat and streams the reply in", () => {
    const state = app();
    receive(state, { kind: "agents", bots: [bot("bot-1", "Fixture agent", "#3b82f6")] });
    press(state, "enter");
    expect(state.focus).toBe("composer");
    for (const char of "Hi!") type(state, char);
    press(state, "backspace");
    const sent = press(state, "enter");
    expect(sent).toEqual([
      { kind: "send", chat: { agentId: "bot-1", threadId: undefined }, text: "Hi" },
    ]);
    expect(state.working && state.composer === "").toBe(true);
    const generation = state.generation;
    receive(state, {
      kind: "updates",
      generation,
      updates: [
        reply("m1", "user", "Hi"),
        { kind: "draft", delta: "The fixture " },
        { kind: "draft", delta: "response" },
      ],
    });
    expect(state.draft).toBe("The fixture response");
    // Events from a conversation that is no longer open are dropped.
    receive(state, {
      kind: "updates",
      generation: generation - 1,
      updates: [{ kind: "draft", delta: " stale" }],
    });
    expect(state.draft).toBe("The fixture response");
    receive(state, {
      kind: "updates",
      generation,
      updates: [
        reply("m2", "bot", "The fixture response is blue."),
        { kind: "runEnded", runId: "run-1", end: { kind: "completed" } },
      ],
    });
    expect(state.draft === "" && !state.working).toBe(true);
    expect(state.entries.map((entry) => entry.text)).toEqual([
      "Hi",
      "The fixture response is blue.",
    ]);
  });

  it("opens conversations from their list and new ones once created", () => {
    const state = app();
    receive(state, { kind: "agents", bots: [bot("bot-1", "Fixture agent", "#3b82f6")] });
    receive(state, {
      kind: "conversations",
      agentId: "bot-1",
      rows: [
        { threadId: "thread-1", first: true, title: null, preview: null },
        { threadId: "thread-2", first: false, title: "Launch plan", preview: null },
      ],
    });
    press(state, "backTab");
    expect(state.focus).toBe("conversations");
    press(state, "down");
    expect(press(state, "enter")).toEqual([
      { kind: "follow", chat: { agentId: "bot-1", threadId: "thread-2" }, generation: 2 },
    ]);
    state.focus = "conversations";
    expect(type(state, "n")).toEqual([{ kind: "newConversation", agentId: "bot-1" }]);
    const created = receive(state, { kind: "created", agentId: "bot-1", threadId: "thread-3" });
    expect(created[0]).toMatchObject({ kind: "follow", chat: { threadId: "thread-3" } });
    expect(created[1]).toEqual({ kind: "loadConversations", agentId: "bot-1" });
    expect(state.focus).toBe("composer");
  });

  it("puts approvals in the tab order only while some wait, and answers them by key", () => {
    const state = app();
    const order = () =>
      [0, 1, 2, 3].map(() => {
        press(state, "tab");
        return state.focus;
      });
    expect(order()).toEqual(["conversations", "composer", "agents", "conversations"]);
    receive(state, { kind: "approvals", found: [pending("message-1"), pending("message-2")] });
    state.focus = "composer";
    press(state, "tab");
    expect(state.focus).toBe("approvals");
    press(state, "down");
    const effects = type(state, "d");
    expect(effects).toEqual([{ kind: "answer", approval: pending("message-2"), answer: "deny" }]);
    expect(receive(state, { kind: "answered" })).toEqual([{ kind: "loadApprovals" }]);
    receive(state, { kind: "approvals", found: [] });
    expect(state.focus).toBe("composer");
  });

  it("reads approvals for a waiting run and shows a failure until the next key", () => {
    const state = app();
    receive(state, { kind: "agents", bots: [bot("bot-1", "Fixture agent", "#3b82f6")] });
    const generation = state.generation;
    expect(
      receive(state, {
        kind: "updates",
        generation,
        updates: [{ kind: "runEnded", runId: "run-1", end: { kind: "waitingInput" } }],
      }),
    ).toEqual([{ kind: "loadApprovals" }]);
    receive(state, {
      kind: "updates",
      generation,
      updates: [
        { kind: "runEnded", runId: "run-1", end: { kind: "failed", reason: "Model unavailable" } },
      ],
    });
    expect(state.notice).toBe("Agent run failed. Model unavailable");
    type(state, "x");
    expect(state.notice).toBeUndefined();
    expect(receive(state, { kind: "runsChanged" })).toEqual([{ kind: "loadApprovals" }]);
    expect(receive(state, { kind: "rosterChanged" })).toEqual([{ kind: "loadAgents" }]);
  });

  it("quits with q from a list but types it in the composer; Ctrl+C quits anywhere", () => {
    const state = app();
    state.focus = "composer";
    state.open = { agentId: "bot-1", threadId: undefined };
    type(state, "q");
    expect(state.quit).toBe(false);
    expect(state.composer).toBe("q");
    press(state, "esc");
    type(state, "q");
    expect(state.quit).toBe(true);
    const other = app();
    other.focus = "composer";
    type(other, "c", true);
    expect(other.quit).toBe(true);
  });

  it("scrolls with page keys and keeps the working state from the snapshot", () => {
    const state = app();
    receive(state, { kind: "agents", bots: [bot("bot-1", "Fixture agent", "#3b82f6")] });
    press(state, "pageUp");
    press(state, "pageUp");
    press(state, "pageDown");
    expect(state.scroll).toBe(10);
    receive(state, {
      kind: "snapshot",
      generation: state.generation,
      snapshot: {
        threadId: "thread-1",
        cursor: 3,
        run: { status: "running" },
        messages: [
          {
            id: "m1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            author: { id: "user-1", name: "Ada" },
            createdAt: "2026-11-20T00:00:00Z",
            blocks: [{ kind: "text", text: "Hello" }],
          },
          {
            id: "m2",
            threadId: "thread-1",
            seq: 2,
            role: "bot",
            createdAt: "2026-11-20T00:00:00Z",
            blocks: [{ kind: "ask", text: "Allow?" }],
          },
        ],
      },
    });
    expect(state.working).toBe(true);
    expect(state.entries).toEqual([
      { id: "m1", speaker: { kind: "member", name: "Ada" }, text: "Hello" },
    ]);
  });

  it("reads bot colours as #rrggbb with an optional shape", () => {
    expect(identityColor("#22c55e::shape_round")).toEqual([0x22, 0xc5, 0x5e]);
    expect(identityColor("#22c55")).toBeUndefined();
    expect(identityColor("green")).toBeUndefined();
  });
});
