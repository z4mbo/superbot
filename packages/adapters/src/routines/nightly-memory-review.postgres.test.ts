import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  queueNightlyMemoryReviewNow,
  reconcileNightlyMemoryReviews,
} from "./nightly-memory-review.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("nightly memory review (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const identities: Array<{ userId: string; spaceId: string; address: string }> = [];

  beforeAll(() => {
    db = createDb(url!);
    system = asSystem(db.prisma);
  });

  afterAll(async () => {
    for (const identity of identities) {
      await system.messagingIdentity.deleteMany({ where: { address: identity.address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  function jobs() {
    const enqueue = vi.fn(async () => undefined);
    return {
      enqueue,
      enqueueIn: vi.fn(),
      enqueueManyIn: vi.fn(),
      cancelIn: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
    } as unknown as JobPublisher & { enqueue: typeof enqueue };
  }

  async function bot(options: { timezone?: string } = {}) {
    const address = `memory-review-${randomUUID()}@rakazo.test`;
    const identity = await runAsSystem("memory review fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    identities.push({ ...identity, address });
    if (options.timezone)
      await system.user.update({
        where: { id: identity.userId },
        data: { timezone: options.timezone },
      });
    return identity;
  }

  async function note(
    identity: { userId: string; spaceId: string; botId: string },
    path: string,
    updatedAt: Date,
    content = "- Ana prefers calls to email.",
  ) {
    const where = {
      spaceId: identity.spaceId,
      scope: "bot",
      botId: identity.botId,
      path,
    };
    const existing = await system.memoryDocument.findFirst({ where, select: { id: true } });
    const document = existing
      ? await system.memoryDocument.update({ where: { id: existing.id }, data: { content } })
      : await system.memoryDocument.create({
          data: { ...where, userId: identity.userId, content },
        });
    await system.$executeRaw`UPDATE memory_documents SET "updatedAt" = ${updatedAt} WHERE id = ${document.id}`;
  }

  const reviews = (botId: string) =>
    system.run.findMany({
      where: { botId, clientNonce: { startsWith: "nightly-memory-review:" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, clientNonce: true, trigger: true, status: true, createdAt: true },
    });

  async function sweep(at: string) {
    return reconcileNightlyMemoryReviews({
      prisma: system,
      jobs: jobs(),
      now: new Date(at),
      pageSize: 50,
    });
  }

  /** What a finished review leaves: a completed run created at `at`. */
  async function settle(botId: string, status: "completed" | "failed", at: string) {
    const runs = await reviews(botId);
    const last = runs[runs.length - 1]!;
    await system.run.update({ where: { id: last.id }, data: { status, createdAt: new Date(at) } });
  }

  it("reviews once a night at 03:00 UTC for an owner with no time zone", async () => {
    const identity = await bot();
    await note(identity, "daily/2026-11-23.md", new Date("2026-11-23T18:00:00Z"));
    await sweep("2026-11-24T02:40:00Z");
    expect(await reviews(identity.botId)).toEqual([]);
    await sweep("2026-11-24T03:10:00Z");
    const [run] = await reviews(identity.botId);
    expect(run).toMatchObject({
      clientNonce: `nightly-memory-review:${identity.botId}:2026-11-24`,
      trigger: "routine",
      status: "queued",
    });
    const { task } = await system.run.findUniqueOrThrow({
      where: { id: run!.id },
      select: { task: { select: { prompt: true } } },
    });
    expect(task.prompt).toContain("Ana prefers calls to email.");
    // Even once it finished, a later sweep that night queues nothing.
    await settle(identity.botId, "completed", "2026-11-24T03:10:00Z");
    await note(identity, "daily/2026-11-24.md", new Date("2026-11-24T03:20:00Z"));
    await sweep("2026-11-24T04:40:00Z");
    expect(await reviews(identity.botId)).toHaveLength(1);
    // The next night reviews the note written since.
    await sweep("2026-11-25T03:05:00Z");
    expect(await reviews(identity.botId)).toHaveLength(2);
  });

  it("follows the owner's time zone", async () => {
    const identity = await bot({ timezone: "Asia/Tokyo" });
    await note(identity, "daily/2026-11-24.md", new Date("2026-11-24T10:00:00Z"));
    await sweep("2026-11-24T03:10:00Z");
    expect(await reviews(identity.botId)).toEqual([]);
    // 03:10 in Tokyo on the 25th.
    await sweep("2026-11-24T18:10:00Z");
    expect((await reviews(identity.botId)).map((run) => run.clientNonce)).toEqual([
      `nightly-memory-review:${identity.botId}:2026-11-25`,
    ]);
  });

  it("skips a bot with the switch off", async () => {
    const identity = await bot();
    await system.bot.update({
      where: { id: identity.botId },
      data: { nightlyMemoryReview: false },
    });
    await note(identity, "daily/2026-11-23.md", new Date("2026-11-23T18:00:00Z"));
    await sweep("2026-11-24T03:10:00Z");
    expect(await reviews(identity.botId)).toEqual([]);
    expect(
      await queueNightlyMemoryReviewNow(
        { prisma: system, jobs: jobs(), billingEnabled: false },
        identity.botId,
      ),
    ).toEqual({ skipped: "switched_off" });
  });

  it("queues nothing without a note written since the last review", async () => {
    const identity = await bot();
    await note(identity, "daily/2026-11-22.md", new Date("2026-11-22T18:00:00Z"));
    await sweep("2026-11-23T03:10:00Z");
    await settle(identity.botId, "completed", "2026-11-23T03:10:00Z");
    // No new note: the next night's sweep costs no run.
    await sweep("2026-11-24T03:10:00Z");
    expect(await reviews(identity.botId)).toHaveLength(1);
  });

  it("backs off for three days after a failed review", async () => {
    const identity = await bot();
    await note(identity, "daily/2026-11-23.md", new Date("2026-11-23T18:00:00Z"));
    await sweep("2026-11-24T03:10:00Z");
    await settle(identity.botId, "failed", "2026-11-24T03:10:00Z");
    await sweep("2026-11-25T03:10:00Z");
    await sweep("2026-11-26T03:10:00Z");
    expect(await reviews(identity.botId)).toHaveLength(1);
    await note(identity, "daily/2026-11-26.md", new Date("2026-11-26T18:00:00Z"));
    // A failed review reviewed nothing, so the notes since the last good one still count.
    await sweep("2026-11-27T03:20:00Z");
    expect((await reviews(identity.botId)).map((run) => run.clientNonce)).toEqual([
      `nightly-memory-review:${identity.botId}:2026-11-24`,
      `nightly-memory-review:${identity.botId}:2026-11-27`,
    ]);
  });

  it("forces a review now for one bot, but not a second one alongside it", async () => {
    const identity = await bot();
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    await note(identity, `daily/${recent.toISOString().slice(0, 10)}.md`, recent);
    const publisher = jobs();
    const outcome = await queueNightlyMemoryReviewNow(
      { prisma: system, jobs: publisher, billingEnabled: false },
      identity.botId,
    );
    expect(outcome).toMatchObject({ runId: expect.any(String) });
    expect(publisher.enqueue).toHaveBeenCalledTimes(1);
    expect(
      await queueNightlyMemoryReviewNow(
        { prisma: system, jobs: jobs(), billingEnabled: false },
        identity.botId,
      ),
    ).toEqual({ skipped: "not_eligible" });
    await system.bot.update({ where: { id: identity.botId }, data: { archivedAt: new Date() } });
    expect(
      await queueNightlyMemoryReviewNow(
        { prisma: system, jobs: jobs(), billingEnabled: false },
        identity.botId,
      ),
    ).toEqual({ skipped: "archived" });
  });
});
