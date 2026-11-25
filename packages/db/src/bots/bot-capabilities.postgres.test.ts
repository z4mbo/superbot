import { PRIMARY_BOT_SPAWN_KEY } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem } from "../database/row-security.js";
import { provisionMessagingIdentity } from "../messaging/messaging.js";
import { createThreadMessage } from "../threads/messages.js";
import type { BotCapabilityAudit } from "./bot-capabilities.js";
import {
  auditBotCapabilities,
  ensureBotCapabilities,
  repairedBotComputer,
} from "./bot-capabilities.js";
import { createRepos } from "./bot-repository.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

/** Every row a Space holds in the tables a bot's history, settings and work live in. */
const TABLES = [
  "bots",
  "threads",
  "messages",
  "events",
  "memory_documents",
  "routines",
  "taught_skills",
  "scratchpad_items",
  "tasks",
  "runs",
  "computers",
] as const;

describePostgres("bots made on older versions (PostgreSQL)", { timeout: 120_000 }, () => {
  const provider = "sendblue";
  const addresses = ["+15550007101", "+15550007102"];
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const spaces: Array<{ userId: string; spaceId: string; botId: string; threadId: string }> = [];

  const actor = (index = 0) => ({
    userId: spaces[index]!.userId,
    spaceId: spaces[index]!.spaceId,
    email: "owner@example.com",
    isDeploymentOwner: false,
  });

  async function snapshot(spaceId: string) {
    const tables: Record<string, Record<string, Record<string, unknown>>> = {};
    for (const table of TABLES) {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; row: Record<string, unknown> }>
      >(
        table === "messages"
          ? `SELECT id, to_jsonb(t) AS row FROM "messages" t
             WHERE "threadId" IN (SELECT id FROM "threads" WHERE "spaceId" = $1)`
          : `SELECT id, to_jsonb(t) AS row FROM "${table}" t WHERE "spaceId" = $1`,
        spaceId,
      );
      tables[table] = Object.fromEntries(rows.map(({ id, row }) => [id, row]));
    }
    return tables;
  }

  const audit = async (spaceId: string): Promise<BotCapabilityAudit | undefined> =>
    (await auditBotCapabilities(prisma)).find((space) => space.spaceId === spaceId);

  /** Leaves the Space's bots as an older version would have: no computer, no MEMORY.md, old flags. */
  async function makeOld(spaceId: string, botIds: string[], options: { dropThreadOf?: string }) {
    await prisma.$executeRaw`
      UPDATE "bots" SET "computerId" = NULL, "fleetManagement" = false,
        "crossSpaceCommunication" = false, "avatarSet" = 'organic', "lookShape" = NULL,
        "lookColor" = NULL
      WHERE "spaceId" = ${spaceId} AND "id" = ANY(${botIds})`;
    await prisma.memoryDocument.deleteMany({
      where: { spaceId, botId: { in: botIds }, path: "MEMORY.md" },
    });
    if (options.dropThreadOf) {
      await prisma.thread.deleteMany({ where: { botId: options.dropThreadOf } });
    }
  }

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    for (const address of addresses) {
      await prisma.messagingIdentity.deleteMany({ where: { provider, address } });
      spaces.push(await provisionMessagingIdentity(prisma, { provider, address }));
    }
  }, 120_000);

  afterAll(async () => {
    for (const space of spaces) {
      await prisma.messagingIdentity.deleteMany({
        where: { provider, address: { in: addresses } },
      });
      await prisma.organization.deleteMany({ where: { id: space.spaceId } });
      await prisma.user.deleteMany({ where: { id: space.userId } });
    }
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("gives every old bot what creation gives, keeps everything else, and repeats as a no-op", async () => {
    const space = spaces[0]!;
    const repos = createRepos(prisma);
    const chief = await repos.createBot(actor(), {
      name: "Chief",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      spawnKey: PRIMARY_BOT_SPAWN_KEY,
    });
    const writer = await repos.createBot(actor(), {
      name: "Scrittore",
      description: "Drafts the weekly post",
      instructions: "Write in Italian. Never publish without asking.",
      notifyOnFinish: false,
      color: "#FF5EB1::shape_2",
      disabledBuiltinTools: ["web_search"],
      dailyCheckIns: false,
    });
    // A bot the person named like the main one, which is not it.
    const namesake = await repos.createBot(actor(), {
      name: "Chief",
      description: "Mine",
      instructions: "Only answer about invoices.",
      notifyOnFinish: true,
    });
    await prisma.bot.update({
      where: { id: writer.id },
      data: { label: "Content lead", nightlyMemoryReview: false },
    });
    await createThreadMessage(prisma, {
      threadId: writer.threadId!,
      role: "user",
      blocks: [{ kind: "text", text: "Draft Monday's post" }],
    });
    await createThreadMessage(prisma, {
      threadId: writer.threadId!,
      role: "bot",
      blocks: [{ kind: "text", text: "Here is a draft." }],
    });
    await prisma.routine.create({
      data: {
        spaceId: space.spaceId,
        botId: writer.id,
        userId: space.userId,
        threadId: writer.threadId,
        name: "Monday draft",
        prompt: "Draft the post",
        crons: ["0 8 * * 1"],
        active: false,
      },
    });
    await prisma.memoryDocument.create({
      data: {
        spaceId: space.spaceId,
        userId: space.userId,
        botId: writer.id,
        scope: "bot",
        path: "daily/2026-11-20.md",
        content: "- Asked for a shorter intro.\n",
      },
    });
    const old = [space.botId, chief.id, writer.id, namesake.id];
    await makeOld(space.spaceId, old, { dropThreadOf: namesake.id });

    const before = await snapshot(space.spaceId);
    expect((await audit(space.spaceId))?.missing).toEqual({
      thread: 1,
      memoryIndex: 4,
      computer: 4,
    });

    // Bot by bot: the install-wide pass is exercised by the audit command's test, which it would
    // otherwise race.
    expect((await ensureBotCapabilities(prisma, writer.id)).sort()).toEqual([
      "computer",
      "memoryIndex",
    ]);
    expect((await ensureBotCapabilities(prisma, namesake.id)).sort()).toEqual([
      "computer",
      "memoryIndex",
      "thread",
    ]);
    for (const id of [space.botId, chief.id]) await ensureBotCapabilities(prisma, id);

    const after = await snapshot(space.spaceId);
    const report = await audit(space.spaceId);
    expect(report?.missing).toEqual({ thread: 0, memoryIndex: 0, computer: 0 });
    // Settings that may have been turned off on purpose stay as stored.
    expect(report?.leftAsStored).toEqual({ fleetManagementOff: 4, crossSpaceCommunicationOff: 4 });

    // Every bot row is byte-identical apart from the computer it now has, and the counter a
    // database trigger moves with it to revoke old screen links; updatedAt included, so the
    // roster keeps its order.
    const team = Object.values(after.computers!);
    expect(team).toHaveLength(1);
    expect(team[0]).toMatchObject({ scope: "team" });
    for (const id of old) {
      const was = before.bots![id]!;
      expect(after.bots![id]).toEqual({
        ...was,
        computerId: team[0]!.id,
        screenGeneration: (was.screenGeneration as number) + 1,
      });
    }
    // Nothing else changed or went away; only the missing chat and indexes were added.
    for (const table of TABLES.filter((name) => name !== "bots")) {
      for (const [id, row] of Object.entries(before[table]!)) {
        expect(after[table]![id], `${table} ${id}`).toEqual(row);
      }
    }
    const added = (table: (typeof TABLES)[number]) =>
      Object.keys(after[table]!).filter((id) => !before[table]![id]);
    expect(added("threads").map((id) => after.threads![id]!.botId)).toEqual([namesake.id]);
    expect(
      added("memory_documents")
        .map((id) => after.memory_documents![id]!)
        .map((document) => [document.botId, document.path])
        .sort(),
    ).toEqual(old.map((id) => [id, "MEMORY.md"]).sort());
    // No run, task, message or event started for any of them.
    for (const table of ["runs", "tasks", "messages", "events", "routines"] as const) {
      expect(added(table), table).toEqual([]);
    }
    const index = await prisma.memoryDocument.findFirst({
      where: { botId: writer.id, path: "MEMORY.md" },
    });
    expect(index?.content).toBe("# Scrittore\n\n");

    // A second pass finds nothing and changes nothing.
    for (const id of old) expect(await ensureBotCapabilities(prisma, id)).toEqual([]);
    expect(await snapshot(space.spaceId)).toEqual(after);
  });

  it("adds each missing piece once when several processes repair at the same time", async () => {
    const space = spaces[1]!;
    const repos = createRepos(prisma);
    const bots = [space.botId];
    for (const name of ["Research", "Ops", "Finance"]) {
      bots.push(
        (
          await repos.createBot(actor(1), {
            name,
            description: "",
            instructions: "",
            notifyOnFinish: true,
          })
        ).id,
      );
    }
    // A deleted computer leaves every bot that used it unlinked.
    await prisma.computer.deleteMany({ where: { spaceId: space.spaceId } });
    await makeOld(space.spaceId, bots, { dropThreadOf: bots[3] });

    await Promise.all([
      ...bots.flatMap((id) => [1, 2, 3].map(() => ensureBotCapabilities(prisma, id))),
    ]);

    const computers = await prisma.computer.findMany({ where: { spaceId: space.spaceId } });
    expect(computers).toHaveLength(1);
    const rows = await prisma.bot.findMany({
      where: { id: { in: bots } },
      select: { computerId: true, thread: { select: { id: true } } },
    });
    expect(rows.every((bot) => bot.computerId === computers[0]!.id && bot.thread)).toBe(true);
    // What a run calls when its bot has no computer: it gets the one now linked.
    expect((await repairedBotComputer(prisma, bots[0]!))?.id).toBe(computers[0]!.id);
    expect(
      await prisma.memoryDocument.count({ where: { botId: { in: bots }, path: "MEMORY.md" } }),
    ).toBe(bots.length);
    expect(await prisma.thread.count({ where: { botId: { in: bots } } })).toBe(bots.length);
    expect((await audit(space.spaceId))?.missing).toEqual({
      thread: 0,
      memoryIndex: 0,
      computer: 0,
    });
  });
});
