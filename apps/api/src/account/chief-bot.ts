import type { Actor, Bot } from "@rakazo/contracts";
import { CHIEF_BOT } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { ComputerLimitError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ChiefBotCreate } from "./first-bot.js";
import { chiefBotInput, hasChatHistory, LEGACY_CHIEF_NAME } from "./first-bot.js";

export type ChiefBotDeps = {
  prisma: PrismaClient;
  createBot: (actor: Actor, input: ChiefBotCreate) => Promise<Bot>;
  /** Tells every open roster of the Space to read again. */
  publishRosterChange?: (change: { spaceIds: string[] }) => Promise<void>;
};

/**
 * Gives the actor's Space its main bot, once. It runs when a member's roster is read: the first
 * read of a Space that never had one makes it, and the Space is then marked so a main bot its
 * members later archive or delete is never made again.
 *
 * - A Space whose main bot exists keeps it. If it still has the first-run name or no look of its
 *   own, it takes the product's name and mark; one its members renamed or restyled stays as is.
 * - Only the main bot's spawn key counts. A bot that is merely named like it is someone's own and
 *   is never adopted, renamed or restyled.
 * - A Space whose main bot was archived, or that deleted a bot of the first-run name before the
 *   key was recorded, is marked without a new one.
 * - A person who has never chatted is left to onboarding, which makes the bot and greets them.
 *
 * Two members opening the Space at once both reach `createBot`, whose unique spawn key per Space
 * lets one create and hands the other the same bot.
 */
export async function ensureChiefBot(
  deps: ChiefBotDeps,
  actor: Actor,
): Promise<{ botId: string | null }> {
  const { prisma } = deps;
  const space = await prisma.space.findUnique({
    where: { id: actor.spaceId },
    select: { chiefBotAt: true, deletingAt: true },
  });
  if (!space || space.chiefBotAt || space.deletingAt) return { botId: null };
  const existing = await prisma.bot.findUnique({
    where: { spaceId_spawnKey: { spaceId: actor.spaceId, spawnKey: CHIEF_BOT.spawnKey } },
    select: { id: true, archivedAt: true },
  });
  let botId: string | null = null;
  let changed = false;
  if (existing && !existing.archivedAt) {
    botId = existing.id;
    changed = await adopt(prisma, existing.id);
  } else if (!existing && !(await deletedFirstRunBot(prisma, actor.spaceId))) {
    if (!(await hasChatHistory(prisma, actor))) return { botId: null };
    try {
      botId = (await deps.createBot(actor, chiefBotInput())).id;
    } catch (error) {
      // The person holds all the computers they may; the Space gets its bot once one is free.
      if (!(error instanceof ComputerLimitError)) throw error;
      getLogger().info("main bot waits for a free computer", { spaceId: actor.spaceId });
      return { botId: null };
    }
    changed = true;
  }
  await prisma.space.updateMany({
    where: { id: actor.spaceId, chiefBotAt: null },
    data: { chiefBotAt: new Date() },
  });
  if (changed) await deps.publishRosterChange?.({ spaceIds: [actor.spaceId] });
  return { botId };
}

/** Gives an untouched main bot the product's name and mark; true when anything changed. */
async function adopt(prisma: PrismaClient, botId: string): Promise<boolean> {
  const [named, styled] = await Promise.all([
    prisma.bot.updateMany({
      where: { id: botId, name: LEGACY_CHIEF_NAME },
      data: { name: CHIEF_BOT.name },
    }),
    prisma.bot.updateMany({
      where: { id: botId, lookShape: null, lookColor: null },
      data: { lookShape: CHIEF_BOT.lookShape, lookColor: CHIEF_BOT.lookColor },
    }),
  ]);
  return named.count + styled.count > 0;
}

/**
 * Whether the Space deleted a bot of the first-run name. Deletions keep no spawn key, so this is
 * the trace a removed main bot leaves; a Space with one is not given another.
 */
async function deletedFirstRunBot(prisma: PrismaClient, spaceId: string): Promise<boolean> {
  const found = await prisma.botDeletion.findFirst({
    where: { spaceId, name: { in: [LEGACY_CHIEF_NAME, CHIEF_BOT.name] } },
    select: { id: true },
  });
  return found !== null;
}
