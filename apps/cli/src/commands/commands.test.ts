import { describe, expect, it } from "vitest";
import { approvalJson, approvalLines, pendingApprovals } from "../approvals/approvals.js";
import { Exit } from "../output/errors.js";
import type { Catalog } from "../session/catalog.js";
import type { Exchange } from "../test/loopback.test-support.js";
import {
  AGENT,
  card,
  discovery,
  event,
  events,
  loopback,
  me,
  refused,
  rpc,
  SPACE,
  snapshot,
} from "../test/loopback.test-support.js";
import { scriptedIo, testContext } from "../test/scripted-io.test-support.js";
import { approvalsCommand } from "./approvals-command.js";
import type { SendArgs } from "./send.js";
import { Collected, messageText, replyStatus, sendCommand, WAITING_EXIT } from "./send.js";
import { conversations } from "./threads.js";

const opened = (): Exchange => {
  const empty = snapshot(card());
  empty.messages = [];
  empty.activeRuns = [];
  return rpc("threads/get", { botId: "bot-1" }, empty);
};

const sent = (): Exchange =>
  rpc(
    "threads/send",
    { botId: "bot-1", text: "What colour?" },
    { taskId: "task-1", runId: "run-1", seq: 6 },
    { fresh: ["clientNonce"] },
  );

const sendArgs = (): SendArgs => ({
  agent: "tools",
  message: ["What", "colour?"],
  newConversation: false,
  conversation: undefined,
});

async function sendWith(list: unknown[], after: Exchange[], json: boolean) {
  const server = await loopback([
    ...discovery(),
    me(),
    opened(),
    sent(),
    events(5, list),
    ...after,
  ]);
  const terminal = scriptedIo();
  const context = await testContext(terminal.io);
  let code = 0;
  try {
    await sendCommand(context, server.client, undefined, sendArgs(), json);
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    code = error.code;
  }
  server.assertDone();
  return { code, stdout: terminal.stdout(), stderr: terminal.stderr() };
}

const catalog = (): Catalog => [{ space: SPACE, agents: [AGENT] }];

const approvalScan = (conversationList: unknown): Exchange[] => [
  rpc("threads/get", { botId: "bot-1" }, snapshot(card())),
  rpc("threads/listBotConversations", { botId: "bot-1" }, conversationList),
];

const conversation = (threadId: string, archivedAt: string | null = null) => ({
  threadId,
  botId: "bot-1",
  createdAt: "2026-11-20T00:00:00Z",
  title: null,
  pinnedAt: null,
  archivedAt,
  preview: null,
});

describe("send", () => {
  it("takes the message from the words or from redirected input", async () => {
    const unused = () => Promise.reject(new Error("stdin is not read when words are given"));
    expect(await messageText(["What", "is", "blue?"], unused)).toBe("What is blue?");
    expect(await messageText([], () => Promise.resolve("From a pipe\n"))).toBe("From a pipe\n");
    await expect(messageText([], () => Promise.resolve("  \n"))).rejects.toThrow(
      "Type a message after the agent name, or pipe one in.",
    );
  });

  it("keeps each collected message once, and the failure", () => {
    const collected = new Collected();
    const bot = (id: string, text: string) => ({
      kind: "message" as const,
      message: { id, role: "bot" as const, seq: 1, text, botId: "bot-1", runId: "run-1" },
    });
    for (const update of [
      bot("m1", "Draft"),
      bot("m1", "Final"),
      bot("m2", ""),
      {
        kind: "runEnded" as const,
        runId: "run-1",
        end: { kind: "failed" as const, reason: "Model unavailable" },
      },
      { kind: "runEnded" as const, runId: "run-2", end: { kind: "completed" as const } },
    ]) {
      collected.update(update);
    }
    expect(collected.messages).toEqual([["m1", "Final"]]);
    expect(replyStatus(collected.end)).toBe("failed");
  });

  const reply = [
    event(6, "thread.progress", { streaming: true, delta: "The fixture " }),
    event(7, "thread.progress", { streaming: true, delta: "response" }),
    event(8, "thread.message.created", {
      messageId: "reply-1",
      seq: 7,
      role: "bot",
      blocks: [{ kind: "text", text: "The fixture response is blue." }],
    }),
    event(9, "run.completed", {}),
  ];

  it("streams the reply and exits cleanly", async () => {
    const text = await sendWith(reply, [], false);
    expect(text).toEqual({ code: 0, stdout: "The fixture response is blue.\n", stderr: "" });
    const json = await sendWith(reply, [], true);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      threadId: "thread-1",
      runIds: ["run-1"],
      status: "completed",
      reply: "The fixture response is blue.",
    });
    expect(json.stdout).toBe(`${JSON.stringify(JSON.parse(json.stdout), null, 2)}\n`);
  });

  it("reports a failed run with status one", async () => {
    const failed = [event(6, "run.failed", { error: "Model unavailable" })];
    const text = await sendWith(failed, [], false);
    expect(text.code).toBe(1);
    expect(text.stderr).toBe("Agent run failed. Model unavailable\n");
    const json = await sendWith(failed, [], true);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ status: "failed", error: "Model unavailable" });
  });

  it("stops on an approval with its own status", async () => {
    const waiting = [
      event(6, "thread.message.created", { messageId: "message-1", role: "bot", blocks: [card()] }),
      event(7, "run.waiting_input", {}),
    ];
    const reread = () => [rpc("threads/get", { botId: "bot-1" }, snapshot(card()))];
    const text = await sendWith(waiting, reread(), false);
    expect(text.code).toBe(WAITING_EXIT);
    expect(text.stderr).toBe(
      'Approval required\n  Allow convert_temperature?\n  Site: units.example.test\n  Endpoint: https://units.example.test/mcp\n  Arguments: {"value":100}\nAnswer with superbot approvals allow message-1 or superbot approvals deny message-1\n',
    );
    const json = await sendWith(waiting, reread(), true);
    expect(json.code).toBe(WAITING_EXIT);
    expect(JSON.parse(json.stdout)).toEqual({
      threadId: "thread-1",
      runIds: ["run-1"],
      status: "waiting",
      reply: "",
      approval: {
        id: "message-1",
        title: "Allow convert_temperature?",
        site: "units.example.test",
        detail: 'Endpoint: https://units.example.test/mcp\nArguments: {"value":100}',
      },
    });
  });

  it("refuses an agent that uses a local model on this device", async () => {
    const server = await loopback([...discovery(), me()]);
    const terminal = scriptedIo();
    const context = await testContext(terminal.io);
    const { LocalModelStore } = await import("../local/local-model-store.js");
    const store = LocalModelStore.forWorkspace(
      context.settings,
      server.client.server,
      "user-1",
      "space-1",
    );
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(store?.directory ?? "", { recursive: true });
    await writeFile(
      store?.modelPath("bot-1") ?? "",
      JSON.stringify({ provider: "claude", id: "fixture", label: "Fixture" }),
    );
    await expect(sendCommand(context, server.client, undefined, sendArgs(), false)).rejects.toThrow(
      "This agent uses a local model on this device. Use superbot chat to talk to it.",
    );
    server.assertDone();
  });
});

describe("threads list", () => {
  it("lists the first conversation and added ones", async () => {
    const server = await loopback([
      rpc("threads/head", { botId: "bot-1" }, { threadId: "thread-1", cursor: 5 }),
      rpc("threads/listBotConversations", { botId: "bot-1" }, [
        { ...conversation("thread-2"), title: "Launch plan" },
      ]),
    ]);
    const rows = await conversations(server.client, "space-1", "bot-1");
    server.assertDone();
    expect(rows).toEqual([
      { threadId: "thread-1", first: true, title: null, preview: null },
      { threadId: "thread-2", first: false, title: "Launch plan", preview: null },
    ]);
  });
});

describe("approvals", () => {
  it("finds approvals in every open conversation", async () => {
    const other = snapshot(card());
    other.threadId = "thread-2";
    (other.messages[0] as { id: string }).id = "message-2";
    const server = await loopback([
      ...approvalScan([conversation("thread-2"), conversation("thread-3", "2026-11-21T00:00:00Z")]),
      rpc("threads/get", { botId: "bot-1", threadId: "thread-2" }, other),
    ]);
    const found = await pendingApprovals(server.client, catalog());
    server.assertDone();
    expect(found.map((approval) => [approval.id, approval.conversation])).toEqual([
      ["message-1", undefined],
      ["message-2", "thread-2"],
    ]);
    const [first, second] = found;
    if (!first || !second) throw new Error("Expected two approvals");
    expect(approvalLines(first)).toBe(
      "message-1  Personal / Tools\n  Allow convert_temperature?\n  Site: units.example.test\n",
    );
    expect(approvalJson(second)).toEqual({
      id: "message-2",
      spaceId: "space-1",
      spaceName: "Personal",
      agentId: "bot-1",
      agentName: "Tools",
      threadId: "thread-2",
      runId: "run-1",
      title: "Allow convert_temperature?",
      site: "units.example.test",
      detail: 'Endpoint: https://units.example.test/mcp\nArguments: {"value":100}',
    });
  });

  it("lists nothing waiting in text and JSON", async () => {
    const empty = snapshot(card());
    empty.activeRuns = [];
    for (const json of [false, true]) {
      const server = await loopback([
        rpc("threads/get", { botId: "bot-1" }, empty),
        rpc("threads/listBotConversations", { botId: "bot-1" }, []),
      ]);
      const terminal = scriptedIo();
      await approvalsCommand(terminal.io, server.client, catalog(), undefined, json);
      server.assertDone();
      expect(terminal.stdout()).toBe(json ? "[]\n" : "No approvals are waiting.\n");
    }
  });

  it.each(["allow", "deny"] as const)("answers the listed card with %s", async (answer) => {
    const server = await loopback([
      ...approvalScan([]),
      rpc(
        "threads/answer",
        { botId: "bot-1", runId: "run-1", messageId: "message-1", answer },
        { ok: true },
      ),
    ]);
    const terminal = scriptedIo();
    await approvalsCommand(
      terminal.io,
      server.client,
      catalog(),
      { id: "message-1", answer },
      false,
    );
    server.assertDone();
    expect(terminal.stdout()).toBe(answer === "allow" ? "Allowed.\n" : "Denied.\n");
  });

  it("refuses an unknown or stale approval", async () => {
    let server = await loopback(approvalScan([]));
    await expect(
      approvalsCommand(
        scriptedIo().io,
        server.client,
        catalog(),
        { id: "message-9", answer: "allow" },
        false,
      ),
    ).rejects.toThrow('No approval "message-9" is waiting. Run superbot approvals to list them.');
    server.assertDone();
    server = await loopback([
      ...approvalScan([]),
      refused(
        "threads/answer",
        { botId: "bot-1", runId: "run-1", messageId: "message-1", answer: "deny" },
        409,
        "CONFLICT",
        "This prompt is no longer awaiting an answer",
      ),
    ]);
    await expect(
      approvalsCommand(
        scriptedIo().io,
        server.client,
        catalog(),
        { id: "message-1", answer: "deny" },
        false,
      ),
    ).rejects.toThrow("This approval is no longer awaiting an answer.");
    server.assertDone();
  });
});
