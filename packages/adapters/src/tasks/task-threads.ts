import { ACTIVE_RUN_STATUSES, CARD_TITLE_ESCAPED_CHARACTERS, redactSecrets } from "@rakazo/core";
import { storedMessageBlocks, THREAD_LOCK_TRANSACTION_OPTIONS } from "@rakazo/db";
import type { FleetCardSummary } from "../approvals/approval-ask.js";
import type { RunContext } from "../runs/assembly/run-context.js";
import { messageBlocksText } from "../runs/assembly/run-replies.prompt.js";
import { cancelThreadRuns, finishThreadStop } from "../runs/lifecycle/thread-stop.js";
import { ownedTaskThreadWhere, startBackgroundHelper } from "./background-helpers.js";
import {
  TASK_THREAD_FOLLOW_UP_INSTRUCTIONS,
  TASK_THREAD_INSTRUCTIONS,
  TASK_THREAD_NESTED,
  TASK_THREAD_NOT_FOUND,
  taskThreadStoppedNote,
} from "./task-threads.prompt.js";

/** A task thread's title: one line, short enough for the conversation list. */
const TITLE_MAX_LENGTH = 80;
/** How many task threads link_to_thread answers with at most. */
const LINK_LIMIT = 10;
/** How much of a task's latest report follow_up reads back. */
const REPORT_LIMIT = 4_000;

export type TaskThreadStatus = "running" | "finished" | "stopped" | "failed";

/** The app path that opens a task thread: the bot's chat at that conversation. */
export function taskThreadLink(botId: string, threadId: string): string {
  return `/app/${botId}?threadId=${threadId}`;
}

/** The title the person sees, from the one given or else the brief's first line. */
export function taskThreadTitle(title: string, brief: string): string {
  const line = (text: string) =>
    text
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const chosen = line(title) || line(brief.split("\n", 1)[0] ?? "");
  const letters = Array.from(chosen);
  if (letters.length <= TITLE_MAX_LENGTH) return chosen || "Task";
  return `${letters
    .slice(0, TITLE_MAX_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

/** Where a task stands, from its thread's latest run. */
export function taskThreadStatus(runStatus: string | undefined): TaskThreadStatus {
  if (!runStatus) return "finished";
  if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(runStatus)) return "running";
  if (runStatus === "cancelled") return "stopped";
  if (runStatus === "failed") return "failed";
  return "finished";
}

/**
 * Start a task thread: a new conversation with this bot, linked to the run's conversation, whose
 * helper starts at once. Its result comes back here as a background helper's does.
 */
export async function delegateTask(
  ctx: RunContext,
  input: { brief: string; title: string; executionId: string; effectKey: string },
) {
  // One level deep, as run_subagent is: a task thread starts no task threads of its own.
  if (ctx.thread.parentThreadId) return { error: TASK_THREAD_NESTED };
  const brief = redactSecrets(input.brief.trim(), ctx.secrets);
  if (!brief) return { error: "brief is required" };
  const title = taskThreadTitle(redactSecrets(input.title, ctx.secrets), brief);
  const started = await startBackgroundHelper(ctx, {
    name: title,
    task: brief,
    instructions: TASK_THREAD_INSTRUCTIONS,
    modelProvider: "",
    modelId: "",
    executionId: input.executionId,
    effectKey: input.effectKey,
    taskThread: { title, message: brief },
  });
  if ("error" in started || !started.threadId) return started;
  return {
    ok: true as const,
    threadId: started.threadId,
    title,
    link: taskThreadLink(ctx.bot.id, started.threadId),
    note: started.note,
  };
}

/** The task thread this run's conversation started, by id; nothing for any other thread. */
async function findOwnedTaskThread(ctx: RunContext, threadId: string) {
  const id = threadId.trim();
  if (!id) return null;
  return ctx.deps.prisma.thread.findFirst({
    where: { ...ownedTaskThreadWhere(ctx), id },
    select: { id: true, conversationTitle: true },
  });
}

/** Where a task stands: its latest run's status and the latest report a run of it wrote. */
async function taskThreadState(ctx: RunContext, threadId: string) {
  const newest = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const [run, reply] = await Promise.all([
    ctx.deps.prisma.run.findFirst({
      where: { threadId },
      orderBy: newest,
      select: { status: true },
    }),
    // A run's reply; the brief shown first in the thread has no run.
    ctx.deps.prisma.message.findFirst({
      where: { threadId, role: "bot", runId: { not: null } },
      orderBy: { seq: "desc" },
      select: { id: true, blocks: true },
    }),
  ]);
  const report = reply ? messageBlocksText(storedMessageBlocks(reply)).trim() : "";
  return {
    status: taskThreadStatus(run?.status),
    report: report.length > REPORT_LIMIT ? `${report.slice(0, REPORT_LIMIT - 1)}…` : report,
  };
}

/**
 * Read where a task this conversation started stands, or, with a message, send it more work,
 * which runs once the task's last run has ended.
 */
export async function followUpTask(
  ctx: RunContext,
  input: { threadId: string; message: string; executionId: string; effectKey: string },
) {
  const owned = await findOwnedTaskThread(ctx, input.threadId);
  if (!owned) return { error: TASK_THREAD_NOT_FOUND };
  const title = owned.conversationTitle || "Task";
  const message = redactSecrets(input.message.trim(), ctx.secrets);
  if (!message) {
    return {
      ok: true as const,
      threadId: owned.id,
      title,
      ...(await taskThreadState(ctx, owned.id)),
      link: taskThreadLink(ctx.bot.id, owned.id),
    };
  }
  const started = await startBackgroundHelper(ctx, {
    name: title,
    task: message,
    instructions: TASK_THREAD_FOLLOW_UP_INSTRUCTIONS,
    modelProvider: "",
    modelId: "",
    executionId: input.executionId,
    effectKey: input.effectKey,
    taskThread: { threadId: owned.id, message },
  });
  if ("error" in started) return started;
  return {
    ok: true as const,
    threadId: owned.id,
    title,
    status: "running" as const,
    link: taskThreadLink(ctx.bot.id, owned.id),
    note: started.note,
  };
}

/**
 * stop_task's approval card, naming the task. Nothing for a thread this conversation did not
 * start, so no card shows for it.
 */
export async function stopTaskSummary(
  ctx: RunContext,
  threadId: string,
): Promise<FleetCardSummary | undefined> {
  const owned = await findOwnedTaskThread(ctx, threadId);
  if (!owned) return undefined;
  const title = (owned.conversationTitle || "Task").replace(
    new RegExp(CARD_TITLE_ESCAPED_CHARACTERS, "g"),
    "\\$&",
  );
  return { title: `Stop task “${title}”?`, lines: [] };
}

/**
 * Stop the work in a task thread this conversation started, the way Stop in that thread does:
 * its runs are cancelled, and the task's card here settles as stopped.
 */
export async function stopTask(ctx: RunContext, input: { threadId: string }) {
  const { deps, run, bot } = ctx;
  const owned = await findOwnedTaskThread(ctx, input.threadId);
  if (!owned) return { error: TASK_THREAD_NOT_FOUND };
  const target = { kind: "bot" as const, botId: bot.id, threadId: owned.id };
  const stop = await deps.prisma.$transaction(
    cancelThreadRuns({ spaceId: run.spaceId }, target, { botId: bot.id }),
    THREAD_LOCK_TRANSACTION_OPTIONS,
  );
  await finishThreadStop(deps, { spaceId: run.spaceId, userId: run.userId }, target, stop);
  const title = owned.conversationTitle || "Task";
  return {
    ok: true as const,
    threadId: owned.id,
    title,
    stopped: stop.runIds.length > 0,
    note: taskThreadStoppedNote(title, stop.runIds.length > 0),
  };
}

/** The task threads this conversation started, newest first, matching `query` when given. */
export async function listTaskThreads(ctx: RunContext, input: { query: string }) {
  const query = input.query.trim();
  const threads = await ctx.deps.prisma.thread.findMany({
    where: {
      ...ownedTaskThreadWhere(ctx),
      ...(query
        ? {
            OR: [
              { conversationTitle: { contains: query, mode: "insensitive" as const } },
              { tasks: { some: { prompt: { contains: query, mode: "insensitive" as const } } } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LINK_LIMIT,
    select: {
      id: true,
      conversationTitle: true,
      runs: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { status: true } },
    },
  });
  return {
    threads: threads.map((thread) => ({
      threadId: thread.id,
      title: thread.conversationTitle || "Task",
      status: taskThreadStatus(thread.runs[0]?.status),
      link: taskThreadLink(ctx.bot.id, thread.id),
    })),
  };
}
