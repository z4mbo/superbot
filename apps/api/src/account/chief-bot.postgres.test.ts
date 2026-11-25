import { randomBytes, randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { CHIEF_BOT, isChiefBot } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  bootstrapUserSpace,
  createDb,
  createRepos,
  createSpaceForMember,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";
import { ensureChiefBot } from "./chief-bot.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

describePostgres("the main bot of every Space (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  let sequence = 0;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let repos: ReturnType<typeof createRepos>;
  const input = { description: "", instructions: "", notifyOnFinish: true };

  beforeAll(() => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    repos = createRepos(prisma);
  });
  afterAll(async () => {
    await db?.pool.end();
  });

  async function signup(): Promise<Actor> {
    const userId = `chief-${++sequence}-${suffix}`;
    const email = `${userId}@rakazo.test`;
    await system.user.create({ data: { id: userId, name: userId, email, emailVerified: false } });
    const { spaceId } = await bootstrapUserSpace(system, { id: userId });
    return { userId, spaceId, email, isDeploymentOwner: false };
  }

  /** A second person in the same organization, added to the actor's Space. */
  async function addMember(owner: Actor): Promise<Actor> {
    const userId = `chief-${++sequence}-${suffix}`;
    const email = `${userId}@rakazo.test`;
    await system.user.create({ data: { id: userId, name: userId, email, emailVerified: false } });
    const space = await system.space.findUniqueOrThrow({ where: { id: owner.spaceId } });
    const createdAt = new Date();
    await system.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId,
        role: "member",
        createdAt,
      },
    });
    // Joining the organization already adds them to its default Space.
    await system.spaceMember.createMany({
      data: [
        {
          id: randomUUID(),
          spaceId: owner.spaceId,
          organizationId: space.organizationId,
          userId,
          createdAt,
        },
      ],
      skipDuplicates: true,
    });
    return { userId, spaceId: owner.spaceId, email, isDeploymentOwner: false };
  }

  function createBot(actor: Actor, name: string, extra: Record<string, unknown> = {}) {
    return runAsTenant(actor, () => repos.createBot(actor, { ...input, name, ...extra }));
  }

  function ensure(actor: Actor, publishRosterChange = vi.fn(async () => undefined)) {
    return runAsTenant(actor, () =>
      ensureChiefBot({ prisma, createBot: repos.createBot, publishRosterChange }, actor),
    );
  }

  function botsIn(spaceId: string) {
    return system.bot.findMany({ where: { spaceId }, orderBy: { createdAt: "asc" } });
  }

  const chiefsIn = async (spaceId: string) => (await botsIn(spaceId)).filter(isChiefBot);

  it("leaves a person who has never chatted to onboarding, which greets them", async () => {
    const actor = await signup();
    await expect(ensure(actor)).resolves.toEqual({ botId: null });
    expect(await botsIn(actor.spaceId)).toEqual([]);
    const space = await system.space.findUniqueOrThrow({ where: { id: actor.spaceId } });
    expect(space.chiefBotAt).toBeNull();
  });

  it("backfills a Space without one, signals after the write, and leaves a bot named like it alone", async () => {
    const actor = await signup();
    const custom = await createBot(actor, "Chief", { lookShape: "cloud", lookColor: "orange" });
    const published = vi.fn(async (change: { spaceIds: string[] }) => {
      // Open rosters read again only after the bot is there to be read.
      expect(await chiefsIn(change.spaceIds[0]!)).toHaveLength(1);
    });
    const { botId } = await ensure(actor, published);
    expect(published).toHaveBeenCalledWith({ spaceIds: [actor.spaceId] });

    const [chief] = await chiefsIn(actor.spaceId);
    expect(chief).toMatchObject({
      id: botId,
      name: CHIEF_BOT.name,
      lookShape: CHIEF_BOT.lookShape,
      lookColor: CHIEF_BOT.lookColor,
      spawnKey: CHIEF_BOT.spawnKey,
      archivedAt: null,
    });
    // The person's own bot keeps its name, look and place.
    const own = await system.bot.findUniqueOrThrow({ where: { id: custom.id } });
    expect(own).toMatchObject({ name: "Chief", lookShape: "cloud", lookColor: "orange" });
    expect(own.spawnKey).toBeNull();
    expect(own.pinned).toBe(false);

    const space = await system.space.findUniqueOrThrow({ where: { id: actor.spaceId } });
    expect(space.chiefBotAt).toBeInstanceOf(Date);
    // Done once: a later read makes nothing and signals nothing.
    const again = vi.fn(async () => undefined);
    await expect(ensure(actor, again)).resolves.toEqual({ botId: null });
    expect(again).not.toHaveBeenCalled();
    expect(await botsIn(actor.spaceId)).toHaveLength(2);
  });

  it("makes exactly one main bot when members open the Space at the same time", async () => {
    const owner = await signup();
    await createBot(owner, "Research Helper");
    const member = await addMember(owner);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => ensure(index % 2 ? member : owner)),
    );
    const chiefs = await chiefsIn(owner.spaceId);
    expect(chiefs).toHaveLength(1);
    for (const result of results) expect([chiefs[0]!.id, null]).toContain(result.botId);
  });

  it("reuses the first-run bot, giving it the product's name and mark only while untouched", async () => {
    const untouched = await signup();
    const first = await createBot(untouched, "Chief", {
      spawnKey: CHIEF_BOT.spawnKey,
      color: "#F97316",
    });
    await expect(ensure(untouched)).resolves.toEqual({ botId: first.id });
    expect(await chiefsIn(untouched.spaceId)).toEqual([
      expect.objectContaining({
        id: first.id,
        name: CHIEF_BOT.name,
        lookShape: CHIEF_BOT.lookShape,
        lookColor: CHIEF_BOT.lookColor,
      }),
    ]);

    const renamed = await signup();
    const own = await createBot(renamed, "Boss", {
      spawnKey: CHIEF_BOT.spawnKey,
      lookShape: "heart",
      lookColor: "red",
    });
    const published = vi.fn(async () => undefined);
    await expect(ensure(renamed, published)).resolves.toEqual({ botId: own.id });
    expect(await chiefsIn(renamed.spaceId)).toEqual([
      expect.objectContaining({ id: own.id, name: "Boss", lookShape: "heart", lookColor: "red" }),
    ]);
    expect(published).not.toHaveBeenCalled();
  });

  it("does not bring back a main bot that was archived or deleted", async () => {
    const archived = await signup();
    const chief = await createBot(archived, "Chief", { spawnKey: CHIEF_BOT.spawnKey });
    await system.bot.update({ where: { id: chief.id }, data: { archivedAt: new Date() } });
    await expect(ensure(archived)).resolves.toEqual({ botId: null });
    expect(await botsIn(archived.spaceId)).toHaveLength(1);
    const marked = await system.space.findUniqueOrThrow({ where: { id: archived.spaceId } });
    expect(marked.chiefBotAt).toBeInstanceOf(Date);

    const deleted = await signup();
    await createBot(deleted, "Research Helper");
    await system.botDeletion.create({
      data: {
        id: randomUUID(),
        spaceId: deleted.spaceId,
        name: "Chief",
        deletedByUserId: deleted.userId,
        memoriesPreserved: false,
      },
    });
    await expect(ensure(deleted)).resolves.toEqual({ botId: null });
    expect(await chiefsIn(deleted.spaceId)).toEqual([]);
  });

  it("gives a new Space its main bot on its first roster read, listed for every member", async () => {
    const owner = await signup();
    await createBot(owner, "Research Helper");
    const created = await runAsSystem("test fixture", () =>
      createSpaceForMember(prisma, {
        currentSpaceId: owner.spaceId,
        userId: owner.userId,
        name: "Projects",
      }),
    );
    const inSpace: Actor = { ...owner, spaceId: created.id };
    const member = await addMember(inSpace);
    const publishRosterChange = vi.fn(async () => undefined);
    const deps = {
      prisma,
      env: {},
      events: { publishRosterChange },
      jobs: { cancel: vi.fn(), enqueue: vi.fn() },
    } as unknown as RouterDeps;
    const client = (actor: Actor) => createRouterClient(createRouter(deps), { context: { actor } });

    // The owner has chatted before, so their first read of the Space makes it; the member,
    // new here, then sees the same bot.
    const ownerView = await client(inSpace).spaces.list();
    const memberView = await client(member).spaces.list();
    const chiefs = await chiefsIn(created.id);
    expect(chiefs).toHaveLength(1);
    for (const view of [ownerView, memberView]) {
      const listed = view.spaces.find((space) => space.id === created.id)?.bots ?? [];
      expect(listed.filter(isChiefBot).map((bot) => bot.id)).toEqual([chiefs[0]!.id]);
    }
    expect(publishRosterChange).toHaveBeenCalledWith({ spaceIds: [created.id] });
  });
});
