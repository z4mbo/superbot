import type { Actor, AppendLocalHistoryInput } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  loadMessageAuthor,
  SpaceDeletionInProgressError,
  spaceTakesWork,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@rakazo/db";
import type { RouterDeps } from "../router.js";
import { lockAndLoadGroupMembers, resolveThreadTarget } from "./thread-target.js";

export async function appendLocalHistory(
  deps: Pick<RouterDeps, "prisma" | "events">,
  actor: Actor,
  input: AppendLocalHistoryInput,
) {
  const { prisma, events } = deps;
  const target = await resolveThreadTarget(prisma, actor, input);
  const entries = [{ role: "user" as const, text: input.text }];
  const messages =
    input.reply === undefined ? entries : [...entries, { role: "bot" as const, text: input.reply }];

  const { messageIds, cursor } = await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      if (!(await spaceTakesWork(tx, actor.spaceId))) throw new SpaceDeletionInProgressError();
      if (target.kind === "group") await lockAndLoadGroupMembers(tx, actor, target);

      const [thread] = await tx.$queryRaw<Array<{ nextEventSeq: number }>>`
        SELECT "nextEventSeq"
        FROM threads
        WHERE id = ${target.threadId} AND "spaceId" = ${actor.spaceId}
        FOR NO KEY UPDATE
      `;
      if (!thread) throw new IsolationError();

      const [active, member] = await Promise.all([
        tx.thread.findFirst({
          where: {
            id: target.threadId,
            ...(target.kind === "group"
              ? { group: { archivedAt: null } }
              : {
                  OR: [
                    { bot: { id: target.botId, archivedAt: null } },
                    {
                      conversationBot: { id: target.botId, archivedAt: null },
                      conversationArchivedAt: null,
                    },
                  ],
                }),
          },
          select: { id: true },
        }),
        tx.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
          select: { userId: true },
        }),
      ]);
      if (!active || !member) throw new IsolationError();

      const scope = {
        threadId: target.threadId,
        authorUserId: actor.userId,
        localOperationId: input.operationId,
      };
      const saved = await tx.message.findMany({ where: scope, orderBy: { seq: "asc" } });
      if (saved.length > 0) {
        const matches =
          saved.length === messages.length &&
          saved.every((row, index) => {
            const [block] = storedMessageBlocks(row);
            return (
              row.role === messages[index]?.role &&
              block?.kind === "text" &&
              block.text === messages[index]?.text
            );
          });
        if (!matches) throw new ClientError("CONFLICT", "Local history operation already used");
        return { messageIds: saved.map((message) => message.id), cursor: thread.nextEventSeq - 1 };
      }

      const author = await loadMessageAuthor(tx, actor.userId);
      const messageIds: string[] = [];
      let cursor = thread.nextEventSeq - 1;
      for (const { role, text } of messages) {
        const blocks = [{ kind: "text" as const, text }];
        const message = await createThreadMessageInTransaction(tx, { ...scope, role, blocks });
        const event = await appendEventInTransaction(tx, {
          spaceId: actor.spaceId,
          threadId: target.threadId,
          botId: target.kind === "bot" ? target.botId : target.threadId,
          type: "thread.message.created",
          payload: {
            messageId: message.id,
            seq: message.seq,
            role,
            blocks,
            author,
            origin: "local_cli",
          },
        });
        cursor = event.seq;
        messageIds.push(message.id);
      }
      if (target.kind === "group") await touchGroupUpdatedAt(tx, target.groupId);
      return { messageIds, cursor };
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  await events.notify(target.threadId, cursor);
  return { messageIds };
}
