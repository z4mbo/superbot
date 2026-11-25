import { initialBotMemory, MEMORY_INDEX_PATH } from "@rakazo/contracts";
import { retry } from "@rakazo/core";
import {
  ComputerLimitError,
  ensureComputerRecord,
  newComputerKind,
  teamComputerUserId,
} from "../computers/computers.js";
import type { Prisma, PrismaClient } from "../database/client.js";
import { isUniqueViolation } from "../database/prisma-errors.js";
import { withTransactionRetry } from "../database/transaction-retry.js";

/**
 * What a bot's creation gives it that a bot made on an older version may lack: its own chat, the
 * MEMORY.md index its memory hangs off, and a computer to run on. Everything else a new bot has
 * is a column default or is read from defaults when used, so an old bot has it already.
 */
export const BOT_CAPABILITIES = ["thread", "memoryIndex", "computer"] as const;
export type BotCapability = (typeof BOT_CAPABILITIES)[number];

const MISSING: Record<BotCapability, Prisma.BotWhereInput> = {
  thread: { thread: { is: null } },
  memoryIndex: { memoryDocuments: { none: { scope: "bot", path: MEMORY_INDEX_PATH } } },
  computer: { computerId: null },
};

/** Live bots, in Spaces that are not being deleted, that lack something creation gives. */
export function botsMissingCapabilities(): Prisma.BotWhereInput {
  return {
    archivedAt: null,
    space: { deletingAt: null },
    OR: BOT_CAPABILITIES.map((capability) => MISSING[capability]),
  };
}

/**
 * Gives a bot what creation would have, and nothing else: it never changes a field the bot
 * already has, so names, settings, looks, memory and history stay as they are. Safe to repeat
 * and to run at once in several processes. A bot without a computer joins its Space's Team
 * Computer, as a new bot does by default, so no private computer is added for it. Returns what
 * it added; a computer the account's limit refuses is left missing.
 */
export async function ensureBotCapabilities(
  prisma: PrismaClient,
  botId: string,
): Promise<BotCapability[]> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      name: true,
      computerId: true,
      thread: { select: { id: true } },
      memoryDocuments: {
        where: { scope: "bot", path: MEMORY_INDEX_PATH },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!bot) return [];
  const added: BotCapability[] = [];
  if (!bot.thread) {
    // One chat per bot is unique, so a concurrent repair adds nothing here.
    const { count } = await prisma.thread.createMany({
      data: [{ spaceId: bot.spaceId, botId: bot.id, userId: bot.userId }],
      skipDuplicates: true,
    });
    if (count) added.push("thread");
  }
  if (bot.memoryDocuments.length === 0) {
    const { count } = await prisma.memoryDocument.createMany({
      data: [
        {
          spaceId: bot.spaceId,
          userId: bot.userId,
          botId: bot.id,
          scope: "bot",
          path: MEMORY_INDEX_PATH,
          content: initialBotMemory(bot.name),
        },
      ],
      skipDuplicates: true,
    });
    if (count) added.push("memoryIndex");
  }
  if (!bot.computerId) {
    const kind = await newComputerKind(prisma);
    try {
      // A concurrent repair may create the same Team Computer first; the next try finds it.
      const linked = await retry(
        () =>
          withTransactionRetry(() =>
            prisma.$transaction(async (tx) => {
              const computer = await ensureComputerRecord(tx, {
                mode: "team",
                spaceId: bot.spaceId,
                userId: await teamComputerUserId(tx, bot),
                kind,
              });
              // Only while still unlinked, so a computer someone picked meanwhile stays. Raw, so
              // updatedAt, which orders the roster, keeps its value.
              return tx.$executeRaw`
            UPDATE "bots" SET "computerId" = ${computer.id}
            WHERE "id" = ${bot.id} AND "computerId" IS NULL`;
            }),
          ),
        { attempts: 3, retryable: isUniqueViolation, delayMs: 0 },
      );
      if (linked) added.push("computer");
    } catch (error) {
      if (!(error instanceof ComputerLimitError)) throw error;
    }
  }
  return added;
}

/** Bot counts for one Space: how many lack each capability, and settings left as stored. */
export type BotCapabilityAudit = {
  spaceId: string;
  bots: number;
  missing: Record<BotCapability, number>;
  /**
   * Off on bots that may never have had them: these columns were added off and only later
   * defaulted on, and nothing recorded whether a person turned one off since. Left as stored.
   */
  leftAsStored: { fleetManagementOff: number; crossSpaceCommunicationOff: number };
};

/** Read-only counts per Space for live bots; ids and numbers only. */
export async function auditBotCapabilities(prisma: PrismaClient): Promise<BotCapabilityAudit[]> {
  const live: Prisma.BotWhereInput = { archivedAt: null, space: { deletingAt: null } };
  const countBySpace = async (where: Prisma.BotWhereInput) => {
    const rows = await prisma.bot.groupBy({
      by: ["spaceId"],
      where: { AND: [live, where] },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.spaceId, row._count._all]));
  };
  const [bots, thread, memoryIndex, computer, fleetOff, crossSpaceOff] = await Promise.all([
    countBySpace({}),
    countBySpace(MISSING.thread),
    countBySpace(MISSING.memoryIndex),
    countBySpace(MISSING.computer),
    countBySpace({ fleetManagement: false }),
    countBySpace({ crossSpaceCommunication: false }),
  ]);
  return [...bots.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([spaceId, count]) => ({
      spaceId,
      bots: count,
      missing: {
        thread: thread.get(spaceId) ?? 0,
        memoryIndex: memoryIndex.get(spaceId) ?? 0,
        computer: computer.get(spaceId) ?? 0,
      },
      leftAsStored: {
        fleetManagementOff: fleetOff.get(spaceId) ?? 0,
        crossSpaceCommunicationOff: crossSpaceOff.get(spaceId) ?? 0,
      },
    }));
}

/**
 * One bounded pass over bots that lack a capability, oldest id first from `after`. Returns the
 * last bot looked at, to continue from, or null once none are left, and the Spaces it changed.
 */
export async function repairBotCapabilities(
  prisma: PrismaClient,
  options: { after?: string; take: number },
): Promise<{ next: string | null; changedSpaceIds: string[] }> {
  const bots = await prisma.bot.findMany({
    where: {
      AND: [botsMissingCapabilities(), options.after ? { id: { gt: options.after } } : {}],
    },
    select: { id: true, spaceId: true },
    orderBy: { id: "asc" },
    take: options.take,
  });
  const changed = new Set<string>();
  for (const bot of bots) {
    if ((await ensureBotCapabilities(prisma, bot.id)).length) changed.add(bot.spaceId);
  }
  return {
    next: bots.length === options.take ? (bots.at(-1)?.id ?? null) : null,
    changedSpaceIds: [...changed],
  };
}
