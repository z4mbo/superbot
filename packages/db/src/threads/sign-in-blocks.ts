import type { MessageBlock, SignInBlock } from "@rakazo/contracts";
import { SignInBlockSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "../database/client.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "../database/transaction-retry.js";
import { contentEncryptionOf } from "../encryption/content-encryption.js";
import { appendEventInTransaction } from "./events.js";
import { changeMessageBlocks, storedMessageBlocks } from "./message-blocks.js";

type SignInCardRef = { spaceId: string; threadId: string; messageId: string };

function signInBlock(blocks: readonly MessageBlock[]): SignInBlock | undefined {
  const parsed = SignInBlockSchema.safeParse(blocks.find((entry) => entry.kind === "sign_in"));
  return parsed.success ? parsed.data : undefined;
}

/**
 * Change a bot message's sign-in card. `change` gets the card as stored and returns the card to
 * write, or undefined to leave it. Returns the card as it now is, and the event to notify when it
 * changed, so the chat redraws it from the row.
 */
export async function changeSignInBlock(
  prisma: PrismaClient,
  ref: SignInCardRef,
  change: (block: SignInBlock) => SignInBlock | undefined,
): Promise<{ block?: SignInBlock; seq?: number }> {
  await contentEncryptionOf(prisma)?.ring.all(ref.spaceId);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Thread row first, as every answer and run write takes it.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${ref.threadId} FOR UPDATE`;
    const message = await tx.message.findFirst({
      where: { id: ref.messageId, threadId: ref.threadId, role: "bot" },
      select: { id: true, blocks: true, botId: true, runId: true },
    });
    const block = message && signInBlock(storedMessageBlocks(message));
    if (!message || !block) return {};
    const next = change(block);
    if (!next) return { block };
    const changed = changeMessageBlocks(message, (entry) => (entry.kind === "sign_in" ? next : entry));
    if (!changed || !message.botId) return { block };
    await tx.message.update({ where: { id: message.id }, data: { blocks: changed.stored } });
    const event = await appendEventInTransaction(tx, {
      spaceId: ref.spaceId,
      threadId: ref.threadId,
      botId: message.botId,
      runId: message.runId ?? undefined,
      // The card shows what became of the request whatever became of its run.
      allowCancelledRun: true,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks: changed.blocks },
    });
    return { block: next, seq: event.seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}
