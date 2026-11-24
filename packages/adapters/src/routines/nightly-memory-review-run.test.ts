import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runs/assembly/run-context.js";
import { completeRun } from "../runs/lifecycle/run-complete.js";
import { createReplyState } from "../runs/lifecycle/run-progress.js";
import type * as RunTools from "../runs/tools/run-tools.js";
import { consumeRunEvents } from "../runs/turn/run-turn.js";

// The saves themselves go through ordinary tool dispatch, covered in run-tools.test.ts.
const saves = vi.hoisted(() => [] as Array<{ name: string; args: Record<string, unknown> }>);
vi.mock("../runs/tools/run-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RunTools>()),
  applyTool: vi.fn(async (_ctx: unknown, name: string, args: Record<string, unknown>) => {
    saves.push({ name, args });
    return { ok: true };
  }),
}));
beforeEach(() => {
  saves.length = 0;
});

async function context(
  options: {
    trigger?: string;
    attempts?: number;
    outsideMessage?: boolean;
    steeredIds?: string[];
  } = {},
) {
  const createMany = vi.fn(async () => ({ count: 1 }));
  const append = vi.fn();
  const finalizeRun = vi.fn(async () => ({}));
  const enqueue = vi.fn(async () => undefined);
  const updateMany = vi.fn(async (_args: { data?: object }) => ({ count: 1 }));
  const tx = { usageRecord: { createMany } };
  const deps = {
    prisma: {
      attempt: { count: async () => options.attempts ?? 1 },
      message: { findMany: async () => [] },
      run: { updateMany },
      steeringMessage: {
        findMany: async () => (options.steeredIds ?? []).map((messageId) => ({ messageId })),
      },
      thread: {
        findUniqueOrThrow: async () => ({ nextMessageSeq: 0, historyCompactedUpToSeq: null }),
      },
      $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    },
    events: { append, finalizeRun },
    jobs: { enqueue },
  };
  const run = {
    id: "run-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "thread-1",
    taskId: "task-1",
    trigger: options.trigger ?? "routine",
    sourceMessageId: "message-1",
    clientNonce: "nightly-memory-review:bot-1:2026-11-24",
  };
  const reply = await createReplyState(deps as never, run as never, []);
  const ctx = {
    deps,
    run,
    runId: run.id,
    context: {},
    workerId: "worker-1",
    fence: 1,
    bot: { id: run.botId },
    thread: { id: run.threadId, botId: run.botId, groupId: null },
    attempt: { id: "attempt-1" },
    state: {
      reply,
      approval: { pausePending: false },
      lease: { valid: true, lastCheckAt: Date.now() },
      computerUse: {},
    },
    abortController: new AbortController(),
    computer: { lazy: { throwIfFailed: () => {} }, checkpoint: { flush: vi.fn() } },
    tools: { approvedReplays: { assertDrained: () => {} } },
    source: {},
    trust: { receivedOutsideMessage: async () => options.outsideMessage ?? false },
    memory: { semantic: { retainConversation: async () => undefined }, scope: "isolated" },
    secrets: [],
    allowSilentEmptyRun: true,
    settleRunningHelpers: async () => {},
    stopHeartbeatAfterCompletion: () => {},
  } as unknown as RunContext;
  return { ctx, createMany, append, finalizeRun, enqueue, updateMany };
}

async function* events(...items: AgentRuntimeEvent[]) {
  yield* items;
}

describe("nightly memory review execution", () => {
  it("never posts what the model wrote, and marks nothing unread", async () => {
    const { ctx, finalizeRun } = await context();
    await consumeRunEvents(
      ctx,
      events({ type: "done", text: "I saved two facts from your notes to memory." }),
    );
    await completeRun(ctx);
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", blocks: [], markUnread: false }),
    );
  });

  it("stays silent when the model ends with NO_RESPONSE", async () => {
    const { ctx, finalizeRun } = await context();
    await consumeRunEvents(ctx, events({ type: "done", text: "NO_RESPONSE" }));
    await completeRun(ctx);
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", blocks: [], markUnread: false }),
    );
  });

  it("saves the facts its reply keeps even when the model called no tool", async () => {
    const { ctx, finalizeRun } = await context();
    const keep = {
      keep: [
        { fact: "The storage locker code is 4471-B.", scope: "private" },
        { fact: "Dates as YYYY-MM-DD.", scope: "shared" },
      ],
    };
    (ctx.deps as { memory?: unknown }).memory = { read: async () => ({ documents: [] }) };
    await consumeRunEvents(
      ctx,
      events(
        { type: "text", text: JSON.stringify(keep).slice(0, 30) },
        { type: "text", text: JSON.stringify(keep).slice(30) },
        { type: "done", text: JSON.stringify(keep) },
      ),
    );
    await completeRun(ctx);
    expect(saves).toEqual([
      { name: "remember", args: { content: "The storage locker code is 4471-B." } },
      {
        name: "save_shared_memory",
        args: { path: "MEMORY.md", content: "Dates as YYYY-MM-DD.\n" },
      },
    ]);
    // The list itself is never posted.
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", blocks: [], markUnread: false }),
    );
  });

  it("saves nothing for an empty list or a bare NO_RESPONSE", async () => {
    for (const text of ['{"keep":[]}', "NO_RESPONSE"]) {
      const { ctx, finalizeRun } = await context();
      await consumeRunEvents(ctx, events({ type: "done", text }));
      await completeRun(ctx);
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    }
    expect(saves).toEqual([]);
  });

  it("does not apply scripted files or memory on completion", async () => {
    const { ctx } = await context();
    ctx.script = [
      {
        files: [{ path: "injected.txt", content: "untrusted" }],
        memory: [{ scope: "bot", path: "daily/2026-11-24.md", content: "untrusted" }],
      },
    ];
    await completeRun(ctx);
    // The context deliberately has no sandbox or memory writer: reaching either fails.
    expect(ctx.state.terminalCheckpointComplete).toBe(true);
  });

  it("refuses a runtime takeover or helper", async () => {
    const { ctx } = await context();
    await expect(
      consumeRunEvents(ctx, events({ type: "takeover", reason: "injected" })),
    ).rejects.toThrow("Memory reviews cannot start a computer or helper.");
  });
});
