import type { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  HELPER_RESULT_TRIGGER,
  isApprovalAskBlock,
  isConversationalRun,
  STOPPED_HELPER_RESULT,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  assertRunCanWriteHistory,
  changeMessageBlocks,
  createThreadMessageInTransaction,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { RunContext } from "../runs/assembly/run-context.js";
import { runLeaseFor } from "../runs/assembly/run-messages.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import {
  helperResultText,
  MAX_PARALLEL_SUBAGENTS,
} from "../runtime/pi/tools/pi-runtime-subagent.js";
import {
  backgroundHelperLimitNote,
  helperPrompt,
  resultPrompt,
  SUBAGENT_DELEGATION_UNAVAILABLE,
  startedNote,
} from "./background-helpers.prompt.js";
import {
  TASK_THREAD_NOT_FOUND,
  TASK_THREAD_STILL_WORKING,
  taskThreadStartedNote,
} from "./task-threads.prompt.js";

const RESULT_LIMIT = 12_000;

// Stop only settles a card, so it brings no job queue.
type HelperDeps = Pick<ExecutorDeps, "prisma"> & {
  events: Pick<ExecutorDeps["events"], "notify">;
  jobs?: ExecutorDeps["jobs"];
};
type HelperBlock = Extract<MessageBlock, { kind: "subagent" }>;

/**
 * Where a helper works besides its own hidden thread: a new task thread the person can open, or
 * one this conversation started earlier, which takes a follow-up once its last run has ended.
 * `message` is shown first in that thread, so the person sees what the work was asked to do.
 */
export type TaskThreadTarget =
  | { title: string; message: string }
  | { threadId: string; message: string };

/** Delegation has one behavior in every conversation, without recursive result chains. */
export function backgroundHelpersAllowed(turn: { trigger: string }): boolean {
  return turn.trigger !== HELPER_RESULT_TRIGGER && isConversationalRun(turn.trigger);
}

export async function startBackgroundHelper(
  ctx: RunContext,
  input: {
    name: string;
    task: string;
    instructions: string;
    modelProvider: string;
    modelId: string;
    executionId: string;
    effectKey: string;
    taskThread?: TaskThreadTarget;
  },
): Promise<{ error: string } | { ok: true; name: string; note: string; threadId?: string }> {
  const { deps, run, runId, bot, thread } = ctx;
  const { taskThread } = input;
  if (!backgroundHelpersAllowed(run)) {
    return {
      error: SUBAGENT_DELEGATION_UNAVAILABLE,
    };
  }
  if (Boolean(input.modelProvider) !== Boolean(input.modelId)) {
    return { error: "model_provider and model_id must both be set" };
  }
  const modelProvider = input.modelProvider || (run.modelPinned ? run.modelProvider : "");
  const modelId = input.modelId || (run.modelPinned ? run.modelId : "");
  const clientNonce = `background-helper:${input.effectKey}`;
  const started = { ok: true as const, name: input.name, note: startedNote(input.name) };
  const card: HelperBlock = {
    kind: "subagent",
    agentId: input.executionId,
    name: input.name,
    task: input.task,
    status: "running",
  };
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Every start goes through this chat, so its lock makes the replay check and the cap exact
    // even when one turn starts several helpers at once.
    if (thread.groupId)
      await tx.$queryRaw`SELECT id FROM chat_groups WHERE id = ${thread.groupId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    // A follow-up's task thread next: its messages and runs change under this lock.
    if (taskThread && "threadId" in taskThread)
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${taskThread.threadId} FOR UPDATE`;
    // The cap belongs to the bot, including starts in different conversations.
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${bot.id} FOR UPDATE`;
    const replay = await tx.run.findFirst({
      where: { spaceId: run.spaceId, clientNonce },
      select: { threadId: true },
    });
    if (replay) return { replayThreadId: replay.threadId };
    if (taskThread && "threadId" in taskThread) {
      const owned = await tx.thread.findFirst({
        where: { ...ownedTaskThreadWhere(ctx), id: taskThread.threadId },
        select: { conversationArchivedAt: true },
      });
      if (!owned || owned.conversationArchivedAt) return "missing" as const;
      // A helper takes no steering, so more for a task waits until its work has ended.
      const working = await tx.run.findFirst({
        where: { threadId: taskThread.threadId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true },
      });
      if (working) return "working" as const;
    }
    const running = await tx.run.count({
      where: {
        botId: bot.id,
        trigger: BACKGROUND_HELPER_TRIGGER,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
    });
    if (running >= MAX_PARALLEL_SUBAGENTS) return "full" as const;
    // Only this turn's live worker may start one, but the card is not part of the turn: a turn
    // ending settles its own helper cards as stopped, while this helper keeps working.
    await assertRunCanWriteHistory(tx, runId, { lease: runLeaseFor(deps, runId) });
    const message = await createThreadMessageInTransaction(tx, {
      threadId: thread.id,
      role: "bot",
      blocks: [card],
      botId: bot.id,
      markUnread: false,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: thread.id,
      botId: bot.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks: [card] },
    });
    // The helper's own thread: no chat list shows it, nothing sent to the bot waits behind the
    // helper, and it goes when the bot is deleted. A task thread is instead one of the bot's
    // conversations, linked to this one, which the person can open.
    const helperThread = !taskThread
      ? await tx.thread.create({
          data: { spaceId: run.spaceId, userId: run.userId, helperBotId: bot.id },
          select: { id: true },
        })
      : "threadId" in taskThread
        ? { id: taskThread.threadId }
        : await tx.thread.create({
            data: {
              spaceId: run.spaceId,
              userId: run.userId,
              conversationBotId: bot.id,
              conversationTitle: taskThread.title,
              parentThreadId: thread.id,
            },
            select: { id: true },
          });
    if (taskThread) {
      // The bot's own words, never the person's: what it asked the task to do.
      const blocks: MessageBlock[] = [{ kind: "text", text: taskThread.message }];
      const shown = await createThreadMessageInTransaction(tx, {
        threadId: helperThread.id,
        role: "bot",
        botId: bot.id,
        blocks,
        markUnread: false,
      });
      await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: helperThread.id,
        botId: bot.id,
        type: "thread.message.created",
        payload: { messageId: shown.id, role: "bot", blocks },
      });
    }
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: bot.id,
        threadId: helperThread.id,
        userId: run.userId,
        prompt: helperPrompt(input),
        status: "queued",
      },
    });
    const helperRun = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: bot.id,
        threadId: helperThread.id,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: BACKGROUND_HELPER_TRIGGER,
        sourceMessageId: message.id,
        delegatedFromRunId: runId,
        clientNonce,
        ...(modelProvider && modelId ? { modelProvider, modelId, modelPinned: true } : {}),
      },
      select: { id: true },
    });
    // The originating user's files remain available even when the parent never booted
    // its computer. Keep the input on the helper's own history for restart and approval resume.
    const sources = await tx.message.findMany({
      where: {
        threadId: thread.id,
        role: "user",
        OR: [
          { id: run.sourceMessageId ?? "" },
          { steeringMessages: { some: { runId, claimedAt: { not: null } } } },
        ],
      },
      select: { id: true, blocks: true },
      orderBy: { seq: "asc" },
    });
    const attachments = sources.flatMap((source) =>
      storedMessageBlocks(source).filter(
        (block) => block.kind === "file" || block.kind === "image",
      ),
    );
    if (attachments.length) {
      const input = await createThreadMessageInTransaction(tx, {
        threadId: helperThread.id,
        role: "user",
        authorUserId: run.userId,
        botId: bot.id,
        runId: helperRun.id,
        blocks: attachments,
        markUnread: false,
      });
      await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: helperThread.id,
        botId: bot.id,
        runId: helperRun.id,
        type: "thread.message.created",
        payload: { messageId: input.id, role: "user", blocks: attachments },
      });
    }
    return {
      eventSeq: event.seq,
      helperRunId: helperRun.id,
      threadId: helperThread.id,
      replayThreadId: undefined,
    };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (committed === "full") {
    return {
      error: backgroundHelperLimitNote(MAX_PARALLEL_SUBAGENTS),
    };
  }
  if (committed === "missing") return { error: TASK_THREAD_NOT_FOUND };
  if (committed === "working") return { error: TASK_THREAD_STILL_WORKING };
  const startedIn = (threadId: string) =>
    taskThread ? { ...started, threadId, note: taskThreadStartedNote(input.name) } : started;
  if (committed.replayThreadId !== undefined) return startedIn(committed.replayThreadId);
  await deps.events.notify(thread.id, committed.eventSeq).catch((error) => {
    getLogger().error("background helper card notification", error);
  });
  await wakeRun(deps.jobs, committed.helperRunId);
  return startedIn(committed.threadId);
}

/**
 * The task threads a run's conversation started: the bot's conversations in this Space, of the
 * same person, linked to it. Every task-thread tool reads and acts only within these.
 */
export function ownedTaskThreadWhere(ctx: Pick<RunContext, "run" | "bot" | "thread">) {
  return {
    spaceId: ctx.run.spaceId,
    userId: ctx.run.userId,
    conversationBotId: ctx.bot.id,
    parentThreadId: ctx.thread.id,
  };
}

/**
 * Settle a finished helper's card and bring its result back to the chat that started it as a
 * new turn. Each helper returns once; a helper the user stopped only settles its card.
 */
export async function returnHelperOutcome(
  deps: HelperDeps,
  run: {
    id: string;
    spaceId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  outcome: { status: "completed" | "failed" | "stopped"; text: string },
) {
  // The card's chat, read first so the lock below can come before any other row.
  const source = run.sourceMessageId
    ? await deps.prisma.message.findUnique({
        where: { id: run.sourceMessageId },
        select: { threadId: true },
      })
    : null;
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Same lock order as clearing chat (and the cloud-agent wake): thread first.
    if (source) await tx.$queryRaw`SELECT id FROM threads WHERE id = ${source.threadId} FOR UPDATE`;
    const claimed = await tx.run.updateMany({
      where: {
        id: run.id,
        trigger: BACKGROUND_HELPER_TRIGGER,
        status: { in: ["completed", "failed", "cancelled"] },
        botOutcomeReturnedAt: null,
      },
      data: { botOutcomeReturnedAt: new Date() },
    });
    if (claimed.count !== 1 || !source || !run.sourceMessageId) return null;
    const card = await tx.message.findFirst({
      where: { id: run.sourceMessageId, threadId: source.threadId },
      select: {
        id: true,
        threadId: true,
        blocks: true,
        thread: {
          select: {
            group: {
              select: {
                archivedAt: true,
                members: { where: { botId: run.botId }, select: { botId: true } },
              },
            },
          },
        },
      },
    });
    const blocks = card ? storedMessageBlocks(card) : [];
    const helper = blocks.find((block): block is HelperBlock => block.kind === "subagent");
    // The chat was cleared since: nothing is left to settle or answer.
    if (!card || !helper) return null;
    if (outcome.status !== "completed") {
      const requests = await tx.message.findMany({
        where: { threadId: card.threadId, runId: run.id, role: "bot" },
        select: { id: true, blocks: true },
      });
      for (const request of requests) {
        const denied = changeMessageBlocks(request, (block) =>
          block.kind === "ask" && isApprovalAskBlock(block) && block.status !== "answered"
            ? { ...block, status: "answered" as const, answer: "deny" }
            : block,
        );
        if (!denied) continue;
        await tx.message.update({
          where: { id: request.id },
          data: { blocks: denied.stored },
        });
        await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: card.threadId,
          botId: run.botId,
          type: "thread.message.updated",
          runId: run.id,
          allowCancelledRun: true,
          payload: { messageId: request.id, role: "bot", blocks: denied.blocks },
        });
      }
    }
    const result =
      outcome.status === "stopped"
        ? STOPPED_HELPER_RESULT
        : helperResultText(outcome.text.trim() || "done.", undefined, RESULT_LIMIT);
    const settled: HelperBlock = {
      ...helper,
      status: outcome.status === "completed" ? "completed" : "failed",
      progress: undefined,
      result,
    };
    const next = changeMessageBlocks(card, (block) => (block === helper ? settled : block));
    if (!next) return null;
    const nextBlocks = next.blocks;
    await tx.message.update({ where: { id: card.id }, data: { blocks: next.stored } });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: card.threadId,
      botId: run.botId,
      type: "thread.message.updated",
      payload: { messageId: card.id, role: "bot", blocks: nextBlocks },
    });
    if (
      outcome.status === "stopped" ||
      (card.thread?.group && (card.thread.group.archivedAt || !card.thread.group.members.length))
    )
      return { threadId: card.threadId, eventSeq: event.seq };
    // Like the cloud-agent wake: only for a person still in the space and a bot still active
    // there. In a shared space that bot may be another member's; the turn runs as this person.
    const [member, bot] = await Promise.all([
      tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
        select: { id: true },
      }),
      tx.bot.findFirst({
        where: { id: run.botId, spaceId: run.spaceId, archivedAt: null },
        select: { id: true },
      }),
    ]);
    if (!member || !bot) return { threadId: card.threadId, eventSeq: event.seq };
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: card.threadId,
        userId: run.userId,
        prompt: resultPrompt(helper.name, outcome.status, result),
        status: "queued",
      },
    });
    const wake = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: card.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: HELPER_RESULT_TRIGGER,
        delegatedFromRunId: run.id,
        clientNonce: `helper-result:${run.id}`,
      },
      select: { id: true },
    });
    const replies = await tx.message.findMany({
      where: { runId: run.id, role: "bot" },
      orderBy: { seq: "asc" },
      select: { id: true, blocks: true },
    });
    const attachments = replies.flatMap((reply) =>
      storedMessageBlocks(reply).filter((block) => block.kind === "file" || block.kind === "image"),
    );
    let eventSeq = event.seq;
    if (attachments.length) {
      const attached = await createThreadMessageInTransaction(tx, {
        threadId: card.threadId,
        botId: run.botId,
        role: "bot",
        runId: wake.id,
        blocks: attachments,
      });
      eventSeq = (
        await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: card.threadId,
          botId: run.botId,
          runId: wake.id,
          type: "thread.message.created",
          payload: { messageId: attached.id, role: "bot", blocks: attachments },
        })
      ).seq;
    }
    return { threadId: card.threadId, eventSeq, wakeRunId: wake.id };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!committed) return;
  await deps.events.notify(committed.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("background helper card notification", error);
  });
  if (committed.wakeRunId && deps.jobs) await wakeRun(deps.jobs, committed.wakeRunId);
}
