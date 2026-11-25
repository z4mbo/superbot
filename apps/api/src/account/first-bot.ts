import type { Actor, Bot, ComputerMode } from "@rakazo/contracts";
import { BOT_COLOR_LIST, CHIEF_BOT } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

/** The name the first bot was created with before every Space had a main bot. */
export const LEGACY_CHIEF_NAME = "Chief";

/** What creates the main bot: idempotent on its spawn key, as `createBot` is. */
export type ChiefBotCreate = {
  name: string;
  description: string;
  instructions: string;
  notifyOnFinish: boolean;
  color?: string;
  lookShape?: string;
  lookColor?: string;
  computerMode?: ComputerMode;
  spawnKey?: string;
};

/**
 * The main bot as it is first made: the product's name and mark. It joins the Space's shared
 * computer, so making it never takes one of the person's own computers.
 */
export function chiefBotInput(): ChiefBotCreate {
  return {
    name: CHIEF_BOT.name,
    description: "",
    instructions: "",
    notifyOnFinish: true,
    // Clients that only read the colour show the mark's ink: white is the palette's plain ink.
    color: BOT_COLOR_LIST.find((color) => color.id === "white")?.hex,
    lookShape: CHIEF_BOT.lookShape,
    lookColor: CHIEF_BOT.lookColor,
    computerMode: "team",
    spawnKey: CHIEF_BOT.spawnKey,
  };
}

/**
 * The first bot is the Space's main bot. The key is also the one earlier web clients created it
 * with, so their bot is found, never duplicated.
 */
export const FIRST_BOT_SPAWN_KEY = CHIEF_BOT.spawnKey;

export type FirstBotDeps = {
  prisma: PrismaClient;
  /** Idempotent on spawnKey: a concurrent create of the same key returns the bot that won. */
  createBot: (actor: Actor, input: ChiefBotCreate) => Promise<Bot>;
  /** Starts a new bot's intro run, which asks what it is for when a model is set up. */
  introduce: (actor: Actor, bot: Bot) => Promise<void>;
  /** Posts the focus choice while the thread is still idle and no intro run asks instead. */
  promptFocus: (actor: Actor, botId: string) => Promise<void>;
};

/**
 * The actor's Space's first-run bot, which is its main bot. Reuses the one already there (or a
 * Chief made before the spawn key existed); otherwise creates and greets one only for a person
 * none of whose own Spaces has ever held a chat. Bots, groups and deleted bots all count. Any
 * other Space gets its main bot, ungreeted, from `ensureChiefBot` when its roster is read.
 */
export async function ensureFirstBot(
  deps: FirstBotDeps,
  actor: Actor,
): Promise<{ botId: string | null }> {
  const botId =
    (await existingFirstBot(deps.prisma, actor)) ??
    (await createFirstBot(deps, actor)) ??
    // Another tab or device may have made Chief between the two reads, so its history is Chief.
    (await existingFirstBot(deps.prisma, actor));
  return { botId };
}

async function existingFirstBot(prisma: PrismaClient, actor: Actor): Promise<string | null> {
  const candidates = await prisma.bot.findMany({
    where: {
      spaceId: actor.spaceId,
      archivedAt: null,
      OR: [{ spawnKey: FIRST_BOT_SPAWN_KEY }, { name: LEGACY_CHIEF_NAME }],
    },
    select: { id: true, spawnKey: true },
    orderBy: { createdAt: "asc" },
  });
  // A Chief made before the spawn key existed is matched by name.
  const found =
    candidates.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY) ?? candidates.at(0) ?? null;
  return found?.id ?? null;
}

async function createFirstBot(deps: FirstBotDeps, actor: Actor): Promise<string | null> {
  if (await hasChatHistory(deps.prisma, actor)) return null;
  const bot = await deps.createBot(actor, chiefBotInput());
  // Each runs at most once per thread, and in this order: the focus card waits for an intro run
  // that is already committed, so a concurrent call cannot leave both openers. A Chief that is
  // only found is left as it is, since whoever created it greets it.
  await bestEffort("first bot intro run", deps.introduce(actor, bot));
  // A failed card leaves Chief usable; the person can type to it.
  await bestEffort("first bot focus prompt", deps.promptFocus(actor, bot.id));
  return bot.id;
}

/**
 * Whether the person has chatted before. Chief welcomes a new account, not a new Space: a chat in
 * any Space the person made means they have been here before, so a Space or organization they add
 * later starts empty. Spaces they were invited to do not count, so a new invitee still gets their
 * own Chief. A request sees only its own Space, so this one read looks past it, and only at
 * whether the person's own Spaces hold anything: ids, never content.
 */
export function hasChatHistory(prisma: PrismaClient, actor: Actor): Promise<boolean> {
  return runAsSystem("first bot checks the person's own Spaces for chats", async () => {
    const created = await prisma.space.findMany({
      // Still a member: a Space handed over when they left an organization is no longer theirs to
      // look into, even as a yes or no.
      where: { createdByUserId: actor.userId, memberships: { some: { userId: actor.userId } } },
      select: { id: true },
    });
    const where = { spaceId: { in: [actor.spaceId, ...created.map((space) => space.id)] } };
    const select = { id: true } as const;
    const found = await Promise.all([
      prisma.bot.findFirst({ where, select }),
      prisma.chatGroup.findFirst({ where, select }),
      prisma.botDeletion.findFirst({ where, select }),
    ]);
    return found.some(Boolean);
  });
}
