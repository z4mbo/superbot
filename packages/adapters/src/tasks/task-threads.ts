import { ACTIVE_RUN_STATUSES, redactSecrets } from "@rakazo/core";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "@rakazo/db";
import type { RunContext } from "../runs/assembly/run-context.js";
import { cancelThreadRuns, finishThreadStop } from "../runs/lifecycle/thread-stop.js";
import { ownedTaskThreadWhere, startBackgroundHelper } from "./background-helpers.js";
import {
  TASK_THREAD_FOLLOW_UP_INSTRUCTIONS,
  TASK_THREAD_INSTRUCTIONS,
  TASK_THREAD_NOT_FOUND,
  taskThreadStoppedNote,
} from "./task-threads.prompt.js";

/** A task thread's title: one line, short enough for the conversation list. */
const TITLE_MAX_LENGTH = 80;
/** How many task threads link_to_thread answers with at most. */
const LINK_LIMIT = 10;

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

/** Send more for a task this conversation started; it runs once the task's last run has ended. */
export async function followUpTask(
  ctx: RunContext,
  input: { threadId: string; message: string; executionId: string; effectKey: string },
) {
  const message = redactSecrets(input.message.trim(), ctx.secrets);
  if (!message) return { error: "message is required" };
  const owned = await findOwnedTaskThread(ctx, input.threadId);
  if (!owned) return { error: TASK_THREAD_NOT_FOUND };
  const title = owned.conversationTitle || "Task";
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
    link: taskThreadLink(ctx.bot.id, owned.id),
    note: started.note,
  };
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
