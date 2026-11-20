import type { Prisma } from "../database/client.js";
import { IsolationError } from "../database/scope.js";

export async function lockBotConversation(
  tx: Prisma.TransactionClient,
  scope: { spaceId: string; botId: string; threadId: string },
) {
  const [thread] = await tx.$queryRaw<
    Array<{
      conversationPinnedAt: Date | null;
      conversationArchivedAt: Date | null;
    }>
  >`
    SELECT "conversationPinnedAt", "conversationArchivedAt"
    FROM threads
    WHERE id = ${scope.threadId}
      AND "spaceId" = ${scope.spaceId}
      AND "conversationBotId" = ${scope.botId}
    FOR NO KEY UPDATE
  `;
  if (!thread) throw new IsolationError();
  return thread;
}

export async function assertOpenBotConversation(
  tx: Prisma.TransactionClient,
  scope: Parameters<typeof lockBotConversation>[1],
) {
  const thread = await lockBotConversation(tx, scope);
  if (thread.conversationArchivedAt) throw new IsolationError();
}
