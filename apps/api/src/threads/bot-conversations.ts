import type { Actor, RpcInput } from "@rakazo/contracts";
import { BOT_CONVERSATION_PREVIEW_LIMIT } from "@rakazo/contracts";
import { truncatePlainText } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  botThreadPreviews,
  createRepos,
  IsolationError,
  lockBotConversation,
  SpaceDeletionInProgressError,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";

const conversationSelect = {
  id: true,
  createdAt: true,
  conversationTitle: true,
  conversationPinnedAt: true,
  conversationArchivedAt: true,
} as const;

type ConversationRow = Prisma.ThreadGetPayload<{ select: typeof conversationSelect }>;

function conversation(botId: string, thread: ConversationRow, preview?: string) {
  return {
    botId,
    threadId: thread.id,
    createdAt: thread.createdAt.toISOString(),
    title: thread.conversationTitle,
    pinnedAt: thread.conversationPinnedAt?.toISOString() ?? null,
    archivedAt: thread.conversationArchivedAt?.toISOString() ?? null,
    preview: preview ? truncatePlainText(preview, BOT_CONVERSATION_PREVIEW_LIMIT) : null,
  };
}

export async function createBotConversation(prisma: PrismaClient, actor: Actor, botId: string) {
  return prisma.$transaction(async (tx) => {
    if (!(await spaceTakesWork(tx, actor.spaceId))) throw new SpaceDeletionInProgressError();
    const bot = await tx.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, archivedAt: null },
      select: { id: true },
    });
    if (!bot) throw new IsolationError();
    const thread = await tx.thread.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, conversationBotId: botId },
      select: conversationSelect,
    });
    return conversation(botId, thread);
  });
}

export async function listBotConversations(prisma: PrismaClient, actor: Actor, botId: string) {
  await createRepos(prisma).getBot(actor, botId, { includeArchived: true });
  const threads = await prisma.thread.findMany({
    where: { spaceId: actor.spaceId, conversationBotId: botId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: conversationSelect,
  });
  const { previews } = await botThreadPreviews(
    prisma,
    threads.map(({ id }) => id),
  );
  return threads.map((thread) => conversation(botId, thread, previews.get(thread.id)));
}

export async function updateBotConversation(
  prisma: PrismaClient,
  actor: Actor,
  input: RpcInput<"threads/updateBotConversation">,
) {
  await createRepos(prisma).getBot(actor, input.botId);
  const thread = await prisma.$transaction(async (tx) => {
    if (!(await spaceTakesWork(tx, actor.spaceId))) throw new SpaceDeletionInProgressError();
    const current = await lockBotConversation(tx, { ...input, spaceId: actor.spaceId });
    const now = new Date();
    return tx.thread.update({
      where: { id: input.threadId },
      data: {
        conversationTitle: input.title,
        conversationPinnedAt:
          input.pinned === undefined
            ? undefined
            : input.pinned
              ? (current.conversationPinnedAt ?? now)
              : null,
        conversationArchivedAt:
          input.archived === undefined
            ? undefined
            : input.archived
              ? (current.conversationArchivedAt ?? now)
              : null,
      },
      select: conversationSelect,
    });
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  const { previews } = await botThreadPreviews(prisma, [thread.id]);
  return conversation(input.botId, thread, previews.get(thread.id));
}
