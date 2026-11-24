import type { JobPublisher } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES, computerUsingRuns, wallClock } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  isUniqueViolation,
  memberHasModelAccess,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { DAILY_NOTES_PREFIX } from "../memory/daily-notes.js";
import { modelCreditBillingEnabled } from "../runs/turn/run-model.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { nightlyMemoryReviewPrompt } from "./nightly-memory-review.prompt.js";

/**
 * Each night, at about 03:00 in its owner's time zone, a bot reviews the daily notes it wrote
 * since its last review and moves what is worth keeping into its memory or shared memory.
 * The run is a routine-trigger turn that only saves memory and never posts to the chat.
 */
export const NIGHTLY_MEMORY_REVIEW_NONCE_PREFIX = "nightly-memory-review";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The local hours a sweep may start a review in: from 03:00 up to 06:00. */
const REVIEW_START_HOUR = 3;
const REVIEW_END_HOUR = 6;
/** Longer than the window, shorter than a day: a time zone change cannot bring a second review. */
const MIN_REVIEW_GAP_MS = 20 * HOUR_MS;
// A failed review usually means the bot's model setup is broken; retrying nightly only repeats it.
const FAILED_REVIEW_BACKOFF_MS = 3 * DAY_MS;
/** Notes older than this are left as they are; they stay stored. */
const REVIEWED_NOTES_LOOKBACK_MS = 3 * DAY_MS;
const MAX_REVIEWED_NOTES = 3;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const MEMORY_REVIEW_TOOL_NAMES = new Set(["remember", "save_shared_memory"]);

const REVIEW_NONCE = { startsWith: `${NIGHTLY_MEMORY_REVIEW_NONCE_PREFIX}:` };
/** A review that did not fail or get cancelled reviewed every note written before it started. */
const COUNTED_REVIEW: Prisma.RunWhereInput = {
  clientNonce: REVIEW_NONCE,
  status: { notIn: ["failed", "cancelled"] },
};

type ReviewBot = {
  id: string;
  spaceId: string;
  userId: string;
  thread: { id: string } | null;
};

export type NightlyMemoryReviewSkip =
  | "not_found"
  | "archived"
  | "switched_off"
  | "not_eligible"
  | "not_member"
  | "no_model_access"
  | "nothing_new";

/**
 * The local date of the night a sweep at `now` reviews, or null outside the window. A missing
 * or unknown time zone reads as UTC. Keyed by the local date, a repeated hour when clocks go
 * back still names the same night.
 */
export function memoryReviewNight(now: Date, timezone: string | null | undefined): string | null {
  const local = wallClock(now, timezone ?? "UTC");
  const hour = Number(local.slice(11, 13));
  return hour >= REVIEW_START_HOUR && hour < REVIEW_END_HOUR ? local.slice(0, 10) : null;
}

/** The time the notes under review start after: the last review, or the lookback when later. */
export function notesReviewedSince(lastReviewAt: Date | null | undefined, now: Date): Date {
  const lookback = new Date(now.getTime() - REVIEWED_NOTES_LOOKBACK_MS);
  return lastReviewAt && lastReviewAt > lookback ? lastReviewAt : lookback;
}

function reviewEligibility(now: Date, options: { force?: boolean } = {}): Prisma.BotWhereInput {
  return {
    archivedAt: null,
    nightlyMemoryReview: true,
    space: { deletingAt: null },
    thread: { isNot: null },
    memoryDocuments: {
      some: {
        scope: "bot",
        path: { startsWith: DAILY_NOTES_PREFIX },
        updatedAt: { gt: new Date(now.getTime() - REVIEWED_NOTES_LOOKBACK_MS) },
      },
    },
    runs: {
      none: {
        OR: [
          // A background helper leaves its bot free, so it does not hold off the review.
          { status: { in: [...ACTIVE_RUN_STATUSES] }, ...computerUsingRuns() },
          { clientNonce: REVIEW_NONCE, status: { in: [...ACTIVE_RUN_STATUSES] } },
          ...(options.force
            ? []
            : [
                {
                  clientNonce: REVIEW_NONCE,
                  createdAt: { gt: new Date(now.getTime() - MIN_REVIEW_GAP_MS) },
                },
              ]),
          {
            clientNonce: REVIEW_NONCE,
            status: "failed",
            createdAt: { gt: new Date(now.getTime() - FAILED_REVIEW_BACKOFF_MS) },
          },
        ],
      },
    },
  };
}

/** Half-hourly cadence for the elected reconciler, so every bot gets several tries in its window. */
export function createNightlyMemoryReviewReconciler(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  billingEnabled?: boolean;
  now?: () => Date;
}): () => Promise<void> {
  let lastRun: number | undefined;
  let sweeping = false;
  return async () => {
    const now = deps.now?.() ?? new Date();
    if (sweeping || (lastRun !== undefined && now.getTime() - lastRun < SWEEP_INTERVAL_MS)) return;
    sweeping = true;
    // Runs beside the reconciler pass so a large sweep never delays run recovery.
    void (async () =>
      reconcileNightlyMemoryReviews({
        prisma: deps.prisma,
        jobs: deps.jobs,
        billingEnabled: await modelCreditBillingEnabled(deps),
        now,
        pageSize: 100,
      }))()
      .then(
        () => {
          lastRun = now.getTime();
        },
        (error) => getLogger().error("nightly memory review sweep", error),
      )
      .finally(() => {
        sweeping = false;
      });
  };
}

/** One sweep: every eligible bot whose owner's night is in the window gets its review. */
export async function reconcileNightlyMemoryReviews(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  now: Date;
  pageSize: number;
  billingEnabled?: boolean;
}): Promise<number> {
  const eligibleWhere = reviewEligibility(deps.now);
  let queued = 0;
  let cursor: string | undefined;
  for (;;) {
    const bots = await deps.prisma.bot.findMany({
      where: { ...eligibleWhere, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        thread: { select: { id: true } },
        memoryDocuments: {
          where: { scope: "bot", path: { startsWith: DAILY_NOTES_PREFIX } },
          select: { updatedAt: true },
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
        runs: {
          where: COUNTED_REVIEW,
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { id: "asc" },
      take: deps.pageSize,
    });
    if (bots.length === 0) break;
    cursor = bots[bots.length - 1]!.id;
    const owners = await deps.prisma.user.findMany({
      where: { id: { in: [...new Set(bots.map((bot) => bot.userId))] } },
      select: { id: true, timezone: true },
    });
    const timezones = new Map(owners.map((owner) => [owner.id, owner.timezone]));
    for (const bot of bots) {
      // The free checks first, so a bot with nothing new to review costs no queries.
      const night = memoryReviewNight(deps.now, timezones.get(bot.userId));
      if (!night || !bot.thread) continue;
      const newestNote = bot.memoryDocuments[0]?.updatedAt;
      if (!newestNote || newestNote <= notesReviewedSince(bot.runs[0]?.createdAt, deps.now))
        continue;
      if ((await reviewAccess(deps, bot)) !== null) continue;
      const runId = await queueNightlyMemoryReviewRun(deps, bot, {
        nonce: `${NIGHTLY_MEMORY_REVIEW_NONCE_PREFIX}:${bot.id}:${night}`,
        now: deps.now,
      });
      if (!runId) continue;
      queued += 1;
      await wakeRun(deps.jobs, runId);
    }
  }
  return queued;
}

/**
 * Queues one review for a bot now, for operators and tests: it skips only the 03:00 window and
 * the once-a-night limit. The switch, archive, membership, model access, the failure backoff,
 * the need for new notes and the run's tool limits all still hold.
 */
export async function queueNightlyMemoryReviewNow(
  deps: { prisma: PrismaClient; jobs: JobPublisher; billingEnabled?: boolean; now?: Date },
  botId: string,
): Promise<{ runId: string } | { skipped: NightlyMemoryReviewSkip }> {
  const now = deps.now ?? new Date();
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      archivedAt: true,
      nightlyMemoryReview: true,
      thread: { select: { id: true } },
    },
  });
  if (!bot) return { skipped: "not_found" };
  if (bot.archivedAt) return { skipped: "archived" };
  if (!bot.nightlyMemoryReview) return { skipped: "switched_off" };
  const eligible = await deps.prisma.bot.findFirst({
    where: { id: botId, ...reviewEligibility(now, { force: true }) },
    select: { id: true },
  });
  if (!eligible || !bot.thread) return { skipped: "not_eligible" };
  const billingEnabled = deps.billingEnabled ?? (await modelCreditBillingEnabled(deps));
  const denied = await reviewAccess({ ...deps, billingEnabled }, bot);
  if (denied) return { skipped: denied };
  const runId = await queueNightlyMemoryReviewRun(deps, bot, {
    nonce: `${NIGHTLY_MEMORY_REVIEW_NONCE_PREFIX}:${bot.id}:now-${now.getTime()}`,
    now,
    force: true,
  });
  if (!runId) return { skipped: "nothing_new" };
  await wakeRun(deps.jobs, runId);
  return { runId };
}

async function reviewAccess(
  deps: { prisma: PrismaClient; billingEnabled?: boolean },
  bot: ReviewBot,
): Promise<"not_member" | "no_model_access" | null> {
  const membership = await deps.prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: bot.spaceId, userId: bot.userId } },
    select: { id: true },
  });
  if (!membership) return "not_member";
  // The bot's person pays: a guest's run is decided by their own plan, not the space's.
  if (deps.billingEnabled && !(await memberHasModelAccess(deps.prisma, bot))) {
    return "no_model_access";
  }
  return null;
}

export function isNightlyMemoryReviewRun(input: {
  trigger: string;
  clientNonce?: string | null;
}): boolean {
  if (input.trigger !== "routine") return false;
  return Boolean(input.clientNonce?.trim().startsWith(`${NIGHTLY_MEMORY_REVIEW_NONCE_PREFIX}:`));
}

/** A review only saves memory: it is offered nothing else. */
export function filterNightlyMemoryReviewTools<T extends { name: string }>(
  tools: readonly T[],
  run: { trigger: string; clientNonce?: string | null },
): T[] {
  if (!isNightlyMemoryReviewRun(run)) return [...tools];
  return tools.filter((tool) => MEMORY_REVIEW_TOOL_NAMES.has(tool.name));
}

/**
 * Enforced at dispatch too: model tool declarations are not an authorization boundary. A review
 * never writes a daily note, so it cannot feed the notes it reviews.
 */
export function nightlyMemoryReviewToolRefusal(
  name: string,
  args: Record<string, unknown>,
  run: { trigger: string; clientNonce?: string | null },
): string | undefined {
  if (!isNightlyMemoryReviewRun(run)) return undefined;
  if (!MEMORY_REVIEW_TOOL_NAMES.has(name)) {
    return "The memory review can only save memory with remember or save_shared_memory.";
  }
  if (name === "remember" && args.daily === true) {
    return "The memory review cannot write daily notes. Leave out daily to save the fact to your memory.";
  }
  return undefined;
}

async function queueNightlyMemoryReviewRun(
  deps: { prisma: PrismaClient },
  bot: ReviewBot,
  options: { nonce: string; now: Date; force?: boolean },
): Promise<string | null> {
  const threadId = bot.thread?.id;
  if (!threadId) return null;
  try {
    return await deps.prisma.$transaction(async (tx) => {
      // Match the thread-before-bot lock order used by message creation. Recheck after the
      // lock so concurrent sweeps and a user starting work cannot race this claim.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      const eligible = await tx.bot.findFirst({
        where: {
          id: bot.id,
          ...reviewEligibility(options.now, { force: options.force }),
          space: { deletingAt: null, memberships: { some: { userId: bot.userId } } },
        },
        select: { id: true },
      });
      if (!eligible) return null;
      const existing = await tx.run.findUnique({
        where: { spaceId_clientNonce: { spaceId: bot.spaceId, clientNonce: options.nonce } },
        select: { id: true },
      });
      if (existing) return null;
      const lastReview = await tx.run.findFirst({
        where: { botId: bot.id, ...COUNTED_REVIEW },
        select: { createdAt: true },
        orderBy: { createdAt: "desc" },
      });
      const notes = await tx.memoryDocument.findMany({
        where: {
          spaceId: bot.spaceId,
          scope: "bot",
          botId: bot.id,
          path: { startsWith: DAILY_NOTES_PREFIX },
          updatedAt: { gt: notesReviewedSince(lastReview?.createdAt, options.now) },
        },
        select: { path: true, content: true },
        orderBy: [{ updatedAt: "desc" }, { path: "desc" }],
        take: MAX_REVIEWED_NOTES,
      });
      if (!notes.some((note) => note.content.trim())) return null;
      const task = await tx.task.create({
        data: {
          spaceId: bot.spaceId,
          botId: bot.id,
          threadId,
          userId: bot.userId,
          prompt: nightlyMemoryReviewPrompt(notes),
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          spaceId: bot.spaceId,
          botId: bot.id,
          threadId,
          taskId: task.id,
          userId: bot.userId,
          status: "queued",
          trigger: "routine",
          clientNonce: options.nonce,
        },
        select: { id: true },
      });
      return run.id;
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}
