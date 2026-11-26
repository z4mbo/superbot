import { runContinueJob } from "@rakazo/adapter-kit";
import type * as Db from "@rakazo/db";
import { createThreadMessageInTransaction } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runs/assembly/run-context.js";
import { cancelThreadRuns, finishThreadStop } from "../runs/lifecycle/thread-stop.js";
import { TASK_THREAD_NOT_FOUND, TASK_THREAD_STILL_WORKING } from "./task-threads.prompt.js";
import {
  delegateTask,
  followUpTask,
  listTaskThreads,
  stopTask,
  taskThreadLink,
  taskThreadStatus,
  taskThreadTitle,
} from "./task-threads.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  assertRunCanWriteHistory: vi.fn(async () => undefined),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "card" })),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));

vi.mock("../runs/lifecycle/thread-stop.js", () => ({
  cancelThreadRuns: vi.fn(() => async () => ({ runIds: ["task-run"] })),
  finishThreadStop: vi.fn(async () => undefined),
}));

/** The calling conversation is "chat"; the run's own task thread is "task-1". */
const OWNED = {
  spaceId: "space",
  userId: "user",
  conversationBotId: "bot",
  parentThreadId: "chat",
};

function harness() {
  const createRun = vi.fn(async (_args: unknown) => ({ id: "helper-run" }));
  const createThread = vi.fn(async (_args: unknown) => ({ id: "task-1" }));
  const ownedThread = vi.fn(
    async (_args: unknown): Promise<Record<string, unknown> | null> => ({
      id: "task-1",
      conversationTitle: "Venue shortlist",
      conversationArchivedAt: null,
    }),
  );
  const activeRun = vi.fn(async (_args: unknown): Promise<{ id: string } | null> => null);
  const tx = {
    $queryRaw: vi.fn(async () => []),
    message: { findMany: vi.fn(async () => []) },
    thread: { create: createThread, findFirst: ownedThread },
    task: { create: vi.fn(async () => ({ id: "helper-task" })) },
    run: {
      // The replay check by client nonce, then the follow-up's check for work under way.
      findFirst: vi.fn(async (args: { where: { clientNonce?: string } }) =>
        args.where.clientNonce ? null : activeRun(args),
      ),
      count: vi.fn(async () => 0),
      create: createRun,
    },
  };
  const findMany = vi.fn(async (_args: unknown) => [
    {
      id: "task-2",
      conversationTitle: "Coat check",
      runs: [{ status: "running" }],
    },
    { id: "task-1", conversationTitle: "Venue shortlist", runs: [{ status: "cancelled" }] },
  ]);
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    thread: { findFirst: ownedThread, findMany },
  };
  const enqueue = vi.fn(async () => undefined);
  const ctx = {
    deps: { prisma, events: { notify: vi.fn(async () => undefined) }, jobs: { enqueue } },
    run: { id: "run-1", spaceId: "space", userId: "user", trigger: "user" },
    runId: "run-1",
    bot: { id: "bot" },
    thread: { id: "chat", botId: "bot" },
    secrets: [],
  } as unknown as RunContext;
  return { ctx, prisma, tx, createRun, createThread, ownedThread, activeRun, findMany, enqueue };
}

const CALL = { executionId: "call-1", effectKey: "effect-1" };

beforeEach(() => vi.clearAllMocks());

describe("delegate", () => {
  it("opens a task thread linked to this conversation and starts its run without waiting", async () => {
    const h = harness();
    const result = await delegateTask(h.ctx, {
      ...CALL,
      brief: "Shortlist three venues for 40 people in Lisbon",
      title: "Venue shortlist",
    });
    expect(result).toEqual({
      ok: true,
      threadId: "task-1",
      title: "Venue shortlist",
      link: "/app/bot?threadId=task-1",
      note: expect.stringContaining("comes back to this conversation"),
    });
    expect(h.createThread).toHaveBeenCalledWith({
      data: {
        spaceId: "space",
        userId: "user",
        conversationBotId: "bot",
        conversationTitle: "Venue shortlist",
        parentThreadId: "chat",
      },
      select: { id: true },
    });
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "task-1",
        trigger: "helper",
        status: "queued",
        delegatedFromRunId: "run-1",
        sourceMessageId: "card",
      }),
      select: { id: true },
    });
    // Its run is queued for a worker now; the call never waits for it to finish.
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("helper-run"));
    // The person opening the thread sees the brief, as the bot's own message.
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        threadId: "task-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Shortlist three venues for 40 people in Lisbon" }],
      }),
    );
  });

  it("refuses an empty brief and runs nowhere a helper may not start", async () => {
    const h = harness();
    await expect(delegateTask(h.ctx, { ...CALL, brief: "  ", title: "" })).resolves.toEqual({
      error: "brief is required",
    });
    h.ctx.run.trigger = "helper_result";
    await expect(
      delegateTask(h.ctx, { ...CALL, brief: "Research it", title: "" }),
    ).resolves.toHaveProperty("error");
    expect(h.createThread).not.toHaveBeenCalled();
  });

  it("titles a thread from the brief when given none", () => {
    expect(taskThreadTitle("", "Compare the plans\nwith every detail")).toBe("Compare the plans");
    expect(taskThreadTitle(" a\tb ", "x")).toBe("a b");
    expect(Array.from(taskThreadTitle("", "word ".repeat(40))).length).toBeLessThanOrEqual(80);
  });
});

describe("follow_up", () => {
  it("starts more work in a task thread this conversation started", async () => {
    const h = harness();
    const result = await followUpTask(h.ctx, {
      ...CALL,
      threadId: "task-1",
      message: "Also check the parking",
    });
    expect(result).toMatchObject({ ok: true, threadId: "task-1", title: "Venue shortlist" });
    expect(h.ownedThread).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...OWNED, id: "task-1" } }),
    );
    expect(h.createThread).not.toHaveBeenCalled();
    expect(h.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ threadId: "task-1", trigger: "helper" }),
      }),
    );
  });

  it("refuses a thread this conversation did not start", async () => {
    const h = harness();
    h.ownedThread.mockResolvedValue(null);
    await expect(
      followUpTask(h.ctx, { ...CALL, threadId: "someone-elses", message: "Do more" }),
    ).resolves.toEqual({ error: TASK_THREAD_NOT_FOUND });
    expect(h.createRun).not.toHaveBeenCalled();
  });

  it("sends nothing while the task is still working", async () => {
    const h = harness();
    h.activeRun.mockResolvedValue({ id: "task-run" });
    await expect(
      followUpTask(h.ctx, { ...CALL, threadId: "task-1", message: "Do more" }),
    ).resolves.toEqual({ error: TASK_THREAD_STILL_WORKING });
    expect(h.createRun).not.toHaveBeenCalled();
  });
});

describe("stop_task", () => {
  it("stops an owned task thread through the thread's own stop", async () => {
    const h = harness();
    await expect(stopTask(h.ctx, { threadId: "task-1" })).resolves.toMatchObject({
      ok: true,
      threadId: "task-1",
      stopped: true,
    });
    const target = { kind: "bot", botId: "bot", threadId: "task-1" };
    expect(cancelThreadRuns).toHaveBeenCalledWith({ spaceId: "space" }, target, { botId: "bot" });
    expect(finishThreadStop).toHaveBeenCalledWith(
      h.ctx.deps,
      { spaceId: "space", userId: "user" },
      target,
      { runIds: ["task-run"] },
    );
  });

  it("refuses a thread this conversation did not start", async () => {
    const h = harness();
    h.ownedThread.mockResolvedValue(null);
    await expect(stopTask(h.ctx, { threadId: "other" })).resolves.toEqual({
      error: TASK_THREAD_NOT_FOUND,
    });
    expect(cancelThreadRuns).not.toHaveBeenCalled();
  });
});

describe("link_to_thread", () => {
  it("lists only this conversation's task threads, with status and link", async () => {
    const h = harness();
    await expect(listTaskThreads(h.ctx, { query: "" })).resolves.toEqual({
      threads: [
        {
          threadId: "task-2",
          title: "Coat check",
          status: "running",
          link: taskThreadLink("bot", "task-2"),
        },
        {
          threadId: "task-1",
          title: "Venue shortlist",
          status: "stopped",
          link: taskThreadLink("bot", "task-1"),
        },
      ],
    });
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: OWNED }));
  });

  it("narrows by title or brief", async () => {
    const h = harness();
    await listTaskThreads(h.ctx, { query: "venue" });
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ...OWNED,
          OR: [
            { conversationTitle: { contains: "venue", mode: "insensitive" } },
            { tasks: { some: { prompt: { contains: "venue", mode: "insensitive" } } } },
          ],
        },
      }),
    );
  });

  it.each([
    ["queued", "running"],
    ["waiting_input", "running"],
    ["completed", "finished"],
    ["cancelled", "stopped"],
    ["failed", "failed"],
    [undefined, "finished"],
  ])("reads a %s run as %s", (status, expected) => {
    expect(taskThreadStatus(status)).toBe(expected);
  });
});
