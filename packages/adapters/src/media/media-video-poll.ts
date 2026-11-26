import type {
  AdapterContext,
  ArtifactStore,
  JobPublisher,
  MediaGenerationProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { mediaPollJob } from "@rakazo/adapter-kit";
import type { GeneratedMediaInfo, MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction, changeMessageBlocks, isUniqueViolation } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { persistMessageInTransaction } from "../runs/assembly/run-messages.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { mediaVideoWakePrompt } from "../runs/wakeups/wakes.prompt.js";
import { attachWorkspaceFileToThread } from "../storage/thread-artifacts.js";
import type { MediaSettled } from "./media-generation-tools.js";
import { generateMediaFromTool, MEDIA_JOB_KIND } from "./media-generation-tools.js";
import type { MediaProviderRegistry } from "./media-providers.js";
import { MediaConnectionError, reopenMediaRoute, SERVER_MEDIA_ROUTE } from "./media-router.js";

/** A short video takes minutes; one still unfinished after this is reported as failed. */
export const MEDIA_POLL_DEADLINE_MS = 60 * 60_000;
/** A poll lock held this long belongs to a worker that died; a live poll finishes well within it. */
const ABANDONED_POLL_LOCK_MS = 10 * 60_000;
/** How long past the deadline provider errors are retried before the video is reported failed. */
const ERROR_GRACE_MS = 15 * 60_000;
/** Longer than the widest poll interval, so a job left this long lost its scheduled poll. */
const STALLED_MS = 10 * 60_000;
const PENDING_STATUSES = ["media_pending", "media_polling"];
/** Images share the job kind but finish within their turn; only videos are polled. */
const VIDEO_JOB = { kind: MEDIA_JOB_KIND, request: { path: ["tool"], equals: "generate_video" } };

export interface MediaVideoDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: Pick<ThreadEvents, "notify" | "publishSpaceChange">;
  artifacts?: ArtifactStore;
  maxUploadSizeBytes?: number;
  /** The server's own provider, for jobs submitted to it. */
  mediaGeneration?: MediaGenerationProvider;
  /** Reads the saved key or model connection a job was submitted with. */
  secretStore: Pick<SecretStore, "load" | "put" | "delete" | "isRemote">;
  mediaRegistry?: MediaProviderRegistry;
}

type MediaRun = { id: string; threadId: string; botId: string; userId: string; spaceId: string };

/** Poll soon after submission, then less often as the job ages. */
export function nextMediaPollAt(createdAt: Date, now = Date.now()): Date {
  const delay = Math.min(5 * 60_000, Math.max(10_000, (now - createdAt.getTime()) / 5));
  return new Date(now + delay);
}

/** The job row is the outbox; a lost enqueue is recovered by reconcileMediaVideos. */
export async function scheduleMediaPoll(
  jobs: JobPublisher,
  jobId: string,
  createdAt = new Date(),
): Promise<void> {
  await jobs.enqueue(mediaPollJob(jobId, nextMediaPollAt(createdAt))).catch((error) => {
    getLogger().warn("media.poll_deferred", { "media.job_id": jobId, error });
  });
}

type Settled = MediaSettled;

/** The client nonce of a video's pending card, one per job. */
function cardNonce(jobId: string): string {
  return `media-card:${jobId}`;
}

/**
 * Changes a video's pending card to how its job ended. Returns the event's seq to signal, or
 * null when there is no pending card (an image, a job from before cards, or one already settled).
 */
async function settleMediaCard(
  tx: Prisma.TransactionClient,
  run: MediaRun,
  jobId: string,
  change: { status: Settled; artifactId?: string },
): Promise<number | null> {
  const message = await tx.message.findFirst({
    where: { threadId: run.threadId, clientNonce: cardNonce(jobId) },
    select: { id: true, blocks: true },
  });
  if (!message) return null;
  const changed = changeMessageBlocks(message, (block) =>
    block.kind === "media_generation" && block.jobId === jobId && block.status === "pending"
      ? { ...block, ...change }
      : block,
  );
  if (!changed) return null;
  await tx.message.update({ where: { id: message.id }, data: { blocks: changed.stored } });
  const event = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.message.updated",
    payload: { messageId: message.id, role: "bot", blocks: changed.blocks },
  });
  return event.seq;
}

/** Attach a finished video to the run's chat and post it, once, with the job's completion. */
export function mediaDelivery(
  deps: Pick<MediaVideoDeps, "prisma" | "events" | "maxUploadSizeBytes"> & {
    artifacts: ArtifactStore;
  },
  run: MediaRun,
  options: {
    groupId?: string;
    operationId: string;
    /** Background delivery outlives the turn that asked, even one that was stopped. */
    afterRun?: boolean;
    /** Commits with the job's final state, so what follows it cannot be lost to a crash. */
    onSettled?: (tx: Prisma.TransactionClient, status: Settled) => Promise<void>;
  },
) {
  /** The newest card change a committed transaction made, signalled once it commits. */
  let cardSeq: number | null = null;
  const notify = (seq: number | null, firstResponseRunId?: string) =>
    seq === null
      ? undefined
      : deps.events.notify(run.threadId, seq, firstResponseRunId).catch(() => undefined);
  return {
    attach: (
      output: { bytes: Uint8Array },
      fileName: string,
      job: { id: string; result: { provider: string; jobId?: string } },
    ) =>
      attachWorkspaceFileToThread(
        {
          prisma: deps.prisma,
          artifacts: deps.artifacts,
          maxUploadSizeBytes: deps.maxUploadSizeBytes,
          events: deps.events,
        },
        {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: run.botId,
          groupId: options.groupId,
          runId: run.id,
          filePath: fileName,
          bytes: output.bytes,
          operationId: options.operationId,
          onAttached: async (tx, artifact) => {
            const checkpointed = await tx.externalEffect.updateMany({
              where: {
                id: job.id,
                status: { in: ["media_submitting", "media_polling"] },
                result: { equals: job.result },
              },
              data: {
                status: "media_polling",
                result: { ...job.result, artifactId: artifact.id },
              },
            });
            if (!checkpointed.count) throw new Error("Media attachment was already checkpointed");
          },
        },
      ),
    /** Posts a video's pending card once; the job's end changes it in place. */
    announce: async (jobId: string, media: GeneratedMediaInfo) => {
      const card: MessageBlock = { kind: "media_generation", jobId, status: "pending", media };
      try {
        const posted = await deps.prisma.$transaction((tx) =>
          persistMessageInTransaction(
            tx,
            run,
            "bot",
            [card],
            undefined,
            cardNonce(jobId),
            options.afterRun,
          ),
        );
        await notify(posted.eventSeq, posted.firstResponseRunId);
      } catch (error) {
        // A retried submission already posted it.
        if (!isUniqueViolation(error)) throw error;
      }
    },
    publish: async (
      block: Parameters<typeof persistMessageInTransaction>[3][number],
      jobId: string,
      artifactId: string,
      providerId: string,
    ) => {
      const committed = await deps.prisma.$transaction(async (tx) => {
        // Commit completion with the message so a restarted poll cannot post twice, and a job
        // closed meanwhile is never posted.
        const claimed = await tx.externalEffect.updateMany({
          where: { id: jobId, status: "media_polling" },
          data: {
            status: "media_completed",
            result: { provider: providerId, artifactId },
          },
        });
        if (!claimed.count) return null;
        const cardEventSeq = await settleMediaCard(tx, run, jobId, {
          status: "completed",
          artifactId,
        });
        const message = await persistMessageInTransaction(
          tx,
          run,
          "bot",
          [block],
          undefined,
          undefined,
          options.afterRun,
        );
        await options.onSettled?.(tx, "completed");
        return { ...message, cardEventSeq };
      });
      if (committed) {
        await notify(
          Math.max(committed.eventSeq, committed.cardEventSeq ?? 0),
          committed.firstResponseRunId,
        );
      }
    },
    onSettled: async (tx: Prisma.TransactionClient, status: Settled, jobId: string) => {
      const seq = await settleMediaCard(tx, run, jobId, { status });
      if (seq !== null) cardSeq = Math.max(cardSeq ?? 0, seq);
      await options.onSettled?.(tx, status);
    },
    afterSettled: async () => {
      const seq = cardSeq;
      cardSeq = null;
      await notify(seq);
    },
  };
}

class MediaRecipientGone extends Error {}

/**
 * Whether the chat that asked can still receive the video: its bot and owner remain and it was
 * not cleared since. In a transaction, the thread row is locked first, as clearing a chat does.
 */
async function recipientRemains(
  db: Prisma.TransactionClient,
  run: MediaRun,
  threadGeneration: number | undefined,
): Promise<boolean> {
  const thread = await db.thread.updateMany({
    where: {
      id: run.threadId,
      spaceId: run.spaceId,
      ...(threadGeneration === undefined ? {} : { historyCompactionGeneration: threadGeneration }),
    },
    data: { nextEventSeq: { increment: 0 } },
  });
  if (!thread.count) return false;
  const [member, bot] = await Promise.all([
    db.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
      select: { id: true },
    }),
    db.bot.findFirst({
      where: { id: run.botId, spaceId: run.spaceId, archivedAt: null },
      select: { id: true },
    }),
  ]);
  return Boolean(member && bot);
}

/**
 * Check one submitted video for the chat that asked for it. A finished video is posted and a
 * failed or expired one is marked failed; either way the bot gets one turn to follow up.
 */
export async function pollMediaVideo(deps: MediaVideoDeps, payload: { jobId: string }) {
  const artifacts = deps.artifacts;
  if (!artifacts) return;
  const job = await deps.prisma.externalEffect.findFirst({
    where: { id: payload.jobId, ...VIDEO_JOB, status: { in: PENDING_STATUSES } },
    select: {
      id: true,
      createdAt: true,
      request: true,
      run: {
        select: {
          id: true,
          threadId: true,
          botId: true,
          userId: true,
          spaceId: true,
          thread: { select: { groupId: true } },
        },
      },
    },
  });
  if (!job) return;
  const { thread, ...run } = job.run;
  const saved = (job.request as { threadGeneration?: unknown }).threadGeneration;
  const threadGeneration = typeof saved === "number" ? saved : undefined;
  const expired = Date.now() - job.createdAt.getTime() >= MEDIA_POLL_DEADLINE_MS;
  // Nobody is left to tell once the bot or its owner is gone or the chat was cleared. A job
  // saved before background delivery existed is closed quietly once overdue, so old chats stay
  // quiet. Closing it stops recovery from picking it up again.
  if (
    (threadGeneration === undefined && expired) ||
    !(await recipientRemains(deps.prisma, run, threadGeneration))
  ) {
    await deps.prisma.externalEffect.updateMany({
      where: { id: job.id, status: { in: PENDING_STATUSES } },
      data: { status: "media_failed" },
    });
    return;
  }
  let wakeRunId: string | null = null;
  const onSettled = async (tx: Prisma.TransactionClient, status: Settled) => {
    if (!(await recipientRemains(tx, run, threadGeneration))) {
      // Undo the post; the next check finds the recipient gone and closes the job.
      if (status === "completed") throw new MediaRecipientGone();
      return;
    }
    wakeRunId = await queueWake(tx, job.id, run, status === "completed");
  };
  const operationId = `media.poll:${job.id}`;
  const context: AdapterContext = {
    operationId,
    traceId: job.id,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    signal: AbortSignal.timeout(5 * 60_000),
  };
  const delivery = mediaDelivery({ ...deps, artifacts }, run, {
    groupId: thread.groupId ?? undefined,
    operationId,
    afterRun: true,
    onSettled,
  });
  const result = await generateMediaFromTool({
    name: "generate_video",
    args: { jobId: job.id },
    executionId: operationId,
    recoverOnly: true,
    // The background check never submits; it only rebuilds the provider the job went to.
    route: {
      prepare: () => Promise.reject(new MediaConnectionError("Media generation is unavailable.")),
      reopen: (route) =>
        reopenMediaRoute(
          {
            prisma: deps.prisma,
            secretStore: deps.secretStore,
            serverDefault: deps.mediaGeneration,
            registry: deps.mediaRegistry,
          },
          run,
          route ?? SERVER_MEDIA_ROUTE,
          context.signal,
        ),
    },
    prisma: deps.prisma,
    context,
    run,
    ...delivery,
  });
  let settled = result?.status === "completed" || result?.status === "failed";
  // A final check that errored is no answer; keep trying a little longer before giving up.
  const unanswered = Boolean(result && "error" in result);
  if (
    !settled &&
    expired &&
    (!unanswered || Date.now() - job.createdAt.getTime() >= MEDIA_POLL_DEADLINE_MS + ERROR_GRACE_MS)
  ) {
    // Still unfinished after the final check: report it failed. Only a released or abandoned
    // claim is taken, so a check still in flight decides instead.
    settled = await deps.prisma.$transaction(async (tx) => {
      const failed = await tx.externalEffect.updateMany({
        where: {
          id: job.id,
          OR: [
            { status: "media_pending" },
            {
              status: "media_polling",
              updatedAt: { lt: new Date(Date.now() - ABANDONED_POLL_LOCK_MS) },
            },
          ],
        },
        data: { status: "media_failed" },
      });
      if (failed.count) await delivery.onSettled(tx, "failed", job.id);
      return failed.count > 0;
    });
    if (settled) await delivery.afterSettled();
  }
  // Still running, briefly locked by another check, or a provider error: try again later.
  if (!settled) await scheduleMediaPoll(deps.jobs, job.id, job.createdAt);
  if (wakeRunId) await wakeRun(deps.jobs, wakeRunId);
}

/** Queue one turn for the bot on the outcome, so it can follow up and the user is notified. */
async function queueWake(
  tx: Prisma.TransactionClient,
  jobId: string,
  run: MediaRun,
  completed: boolean,
): Promise<string | null> {
  const clientNonce = `media-wake:${jobId}`;
  const prior = await tx.run.findFirst({
    where: { spaceId: run.spaceId, clientNonce },
    select: { id: true },
  });
  if (prior) return null;
  const task = await tx.task.create({
    data: {
      spaceId: run.spaceId,
      botId: run.botId,
      threadId: run.threadId,
      userId: run.userId,
      prompt: mediaVideoWakePrompt(jobId, completed),
      status: "queued",
    },
  });
  const wake = await tx.run.create({
    data: {
      spaceId: run.spaceId,
      botId: run.botId,
      threadId: run.threadId,
      userId: run.userId,
      taskId: task.id,
      status: "queued",
      trigger: "media",
      clientNonce,
    },
  });
  return wake.id;
}

/**
 * Re-enqueue unfinished videos whose poll was lost, for example to a worker restart. A healthy
 * job is checked at least every five minutes, so only one untouched for longer is picked up.
 */
export async function reconcileMediaVideos(deps: Pick<MediaVideoDeps, "prisma" | "jobs">) {
  const now = Date.now();
  const pageSize = 100;
  let after: string | undefined;
  for (;;) {
    const page = await deps.prisma.externalEffect.findMany({
      where: {
        ...VIDEO_JOB,
        status: { in: PENDING_STATUSES },
        updatedAt: { lt: new Date(now - STALLED_MS) },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: pageSize,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: { id: true, createdAt: true },
    });
    for (const job of page) {
      await deps.jobs
        .enqueue({
          ...mediaPollJob(job.id, nextMediaPollAt(job.createdAt, now)),
          // A scheduled poll is left alone; only a missing, exhausted or abandoned one is
          // replaced.
          keepExisting: true,
          replaceLockedBefore: new Date(now - ABANDONED_POLL_LOCK_MS),
        })
        .catch((error) =>
          getLogger().warn("media.poll_recovery_deferred", { "media.job_id": job.id, error }),
        );
    }
    if (page.length < pageSize) return;
    after = page.at(-1)?.id;
  }
}
