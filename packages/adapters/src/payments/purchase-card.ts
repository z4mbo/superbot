import type { PurchaseCardSummary, PurchaseStatus } from "@rakazo/adapter-kit";
import type { MessageBlock, PurchaseCardState } from "@rakazo/contracts";
import { cardTitle } from "@rakazo/contracts";
import { ClientError, formatPurchaseAmount, walletPurchaseCardState } from "@rakazo/core";
import type {
  AuditEventInput,
  PrismaClient,
  Purchase,
  PurchaseAuditAction,
  RunLease,
  ThreadEvents,
} from "@rakazo/db";
import {
  appendEventInTransaction,
  changeMessageBlocks,
  createThreadMessageInTransaction,
  recordPurchaseEvent,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

type PurchaseBlock = Extract<MessageBlock, { kind: "purchase" }>;

/** What the cards read and write; `events` signals the chat once a card changed. */
export type PurchaseCardDeps = {
  prisma: PrismaClient;
  events?: Pick<ThreadEvents, "notify">;
};

const OUTCOME_ACTIONS: Partial<Record<PurchaseCardState, PurchaseAuditAction>> = {
  approved: "purchase.approved",
  paid: "purchase.paid",
  canceled: "purchase.canceled",
  expired: "purchase.expired",
  failed: "purchase.failed",
};

/** A card the wallet issued, by reference only. */
export function walletCardMethod(card: PurchaseCardSummary | undefined): string | undefined {
  return card ? cardTitle(card) : undefined;
}

/** The chat card for a wallet purchase, from the stored purchase. */
export function walletPurchaseBlock(
  purchase: Pick<
    Purchase,
    "id" | "merchantName" | "amount" | "currency" | "status" | "approvalUrl"
  >,
  wallet: string,
  method?: string,
): PurchaseBlock {
  const state = walletPurchaseCardState(purchase.status);
  return {
    kind: "purchase",
    purchaseId: purchase.id,
    merchant: purchase.merchantName.slice(0, 200),
    amount: formatPurchaseAmount(purchase.amount, purchase.currency),
    state,
    wallet: wallet.slice(0, 80),
    ...(purchase.approvalUrl && state === "pending" ? { approveUrl: purchase.approvalUrl } : {}),
    ...(method ? { method } : {}),
  };
}

/**
 * Post the card for a purchase the bot just asked the wallet for, once. The card is the user's way
 * to follow the purchase and cancel it from the chat; it changes as the purchase does.
 */
export async function postWalletPurchaseCard(
  deps: PurchaseCardDeps,
  run: { id: string; threadId: string; botId: string; spaceId: string; lease?: RunLease },
  purchaseId: string,
  wallet: string,
): Promise<void> {
  const posted = await deps.prisma.$transaction(async (tx) => {
    // Thread first, then the purchase: the order the poller takes them in.
    await tx.thread.update({
      where: { id: run.threadId, spaceId: run.spaceId },
      data: { nextMessageSeq: { increment: 0 } },
    });
    await tx.$queryRaw`SELECT id FROM purchases WHERE id = ${purchaseId} FOR UPDATE`;
    const purchase = await tx.purchase.findFirst({
      where: { id: purchaseId, spaceId: run.spaceId, threadId: run.threadId, messageId: null },
    });
    if (!purchase) return null;
    const blocks = [walletPurchaseBlock(purchase, wallet)];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      role: "bot",
      blocks,
      lease: run.lease,
    });
    // Raw, so the purchase's updatedAt stays as the poller last read it and its fence still holds.
    await tx.$executeRaw`UPDATE purchases SET "messageId" = ${message.id} WHERE id = ${purchaseId}`;
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      lease: run.lease,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { seq: event.seq, purchase };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!posted) return;
  await notify(deps, run.threadId, posted.seq);
  await recordPurchaseEvent({
    action: "purchase.approval_shown",
    actor: { type: "system", label: wallet },
    spaceId: run.spaceId,
    runId: run.id,
    threadId: run.threadId,
    source: "wallet",
    target: { type: "purchase", id: purchaseId },
    merchant: posted.purchase.merchantName,
    amount: formatPurchaseAmount(posted.purchase.amount, posted.purchase.currency),
  });
}

/**
 * Bring a wallet purchase's card in line with the stored purchase, and record the change in the
 * audit log. `method` is the card the wallet issued, once it did; `actor` is who changed it, the
 * wallet's owner by default.
 */
export async function syncWalletPurchaseCard(
  deps: PurchaseCardDeps,
  purchaseId: string,
  options: { method?: string; actor?: AuditEventInput["actor"] } = {},
): Promise<PurchaseCardState | undefined> {
  const synced = await deps.prisma.$transaction(async (tx) => {
    const purchase = await tx.purchase.findUnique({ where: { id: purchaseId } });
    if (!purchase?.messageId) return null;
    const message = await tx.message.findFirst({
      where: { id: purchase.messageId, threadId: purchase.threadId },
      select: { id: true, blocks: true },
    });
    if (!message) return null;
    let before: PurchaseBlock | undefined;
    let after: PurchaseBlock | undefined;
    const next = changeMessageBlocks(message, (block) => {
      if (block.kind !== "purchase" || block.purchaseId !== purchase.id) return block;
      const updated = walletPurchaseBlock(purchase, block.wallet, options.method ?? block.method);
      if (JSON.stringify(updated) === JSON.stringify(block)) return block;
      before = block;
      after = updated;
      return updated;
    });
    if (!next || !before || !after) return null;
    await tx.message.update({ where: { id: message.id }, data: { blocks: next.stored } });
    const event = await appendEventInTransaction(tx, {
      spaceId: purchase.spaceId,
      threadId: purchase.threadId,
      botId: purchase.botId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks: next.blocks },
    });
    return { seq: event.seq, purchase, before, after };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!synced) return undefined;
  const { purchase, before, after } = synced;
  await notify(deps, purchase.threadId, synced.seq);
  const action = before.state === after.state ? undefined : OUTCOME_ACTIONS[after.state];
  if (action)
    await recordPurchaseEvent({
      action,
      // The wallet's owner decides on the wallet's side; an expiry or failure is nobody's choice.
      actor:
        options.actor ??
        (after.state === "approved" || after.state === "canceled"
          ? { type: "user", id: purchase.userId }
          : { type: "system", label: after.wallet }),
      spaceId: purchase.spaceId,
      threadId: purchase.threadId,
      source: "wallet",
      target: { type: "purchase", id: purchase.id },
      merchant: purchase.merchantName,
      amount: after.amount,
      last4: after.method?.slice(-4),
    });
  return after.state;
}

/** The purchase is not this person's, or no longer exists. */
export class PurchaseNotFoundError extends ClientError {
  constructor() {
    super("NOT_FOUND", "This purchase was not found.");
  }
}

/** Statuses a person can still cancel from the chat: nothing has been paid yet. */
const CANCELABLE: ReadonlySet<string> = new Set<PurchaseStatus>([
  "pending_approval",
  "needs_action",
  "approved",
]);

/**
 * Cancel a wallet purchase from its card. Once canceled here the bot never gets its card or token,
 * whatever the wallet later says, and is woken to hear it was canceled.
 */
export async function cancelWalletPurchase(
  deps: PurchaseCardDeps,
  settle: (purchase: Purchase) => Promise<void>,
  actor: { userId: string; spaceId: string },
  purchaseId: string,
): Promise<PurchaseCardState> {
  // A poll can change the purchase between the read and the write; each try reads it again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const purchase = await deps.prisma.purchase.findFirst({
      where: { id: purchaseId, spaceId: actor.spaceId, userId: actor.userId },
    });
    if (!purchase) throw new PurchaseNotFoundError();
    if (!CANCELABLE.has(purchase.status)) break;
    await settle(purchase);
  }
  const state = await syncWalletPurchaseCard(deps, purchaseId, {
    actor: { type: "user", id: actor.userId },
  });
  if (state) return state;
  const current = await deps.prisma.purchase.findFirst({
    where: { id: purchaseId, spaceId: actor.spaceId, userId: actor.userId },
    select: { status: true },
  });
  if (!current) throw new PurchaseNotFoundError();
  return walletPurchaseCardState(current.status);
}

/**
 * After an approved pay press ran, its order card says whether it went through, and the audit log
 * records it. Only a card whose user pressed Pay is changed, once.
 */
export async function settlePagePurchaseCard(
  deps: PurchaseCardDeps,
  run: { id: string; threadId: string; spaceId: string; lease?: RunLease },
  bot: { id: string; name: string },
  effectId: string,
  outcome: "paid" | "failed",
): Promise<void> {
  const settled = await deps.prisma.$transaction(async (tx) => {
    const messages = await tx.message.findMany({
      where: { threadId: run.threadId, runId: run.id, role: "bot" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, blocks: true },
    });
    for (const message of messages) {
      let paid: Extract<MessageBlock, { kind: "ask" }> | undefined;
      const next = changeMessageBlocks(message, (block) => {
        if (
          block.kind !== "ask" ||
          block.approvalEffectId !== effectId ||
          !block.payment ||
          block.payment.outcome ||
          block.status !== "answered" ||
          block.answer !== "allow"
        )
          return block;
        paid = block;
        return { ...block, payment: { ...block.payment, outcome } };
      });
      if (!next || !paid) continue;
      await tx.message.update({ where: { id: message.id }, data: { blocks: next.stored } });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: bot.id,
        runId: run.id,
        lease: run.lease,
        type: "thread.message.updated",
        payload: { messageId: message.id, role: "bot", blocks: next.blocks },
      });
      return { seq: event.seq, card: paid as Extract<MessageBlock, { kind: "ask" }> };
    }
    return null;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!settled) return;
  await notify(deps, run.threadId, settled.seq);
  const { payment, receipt } = settled.card;
  await recordPurchaseEvent({
    action: outcome === "paid" ? "purchase.paid" : "purchase.failed",
    actor: { type: "bot", id: bot.id, label: bot.name },
    spaceId: run.spaceId,
    runId: run.id,
    threadId: run.threadId,
    source: "page",
    target: { type: "external_effect", id: effectId },
    merchant: payment?.merchant ?? "",
    amount: receipt?.amount,
    last4: payment?.method?.match(/(\d{4})$/)?.[1],
  });
}

// The change is saved; a missed signal only delays it to the chat's next read.
async function notify(deps: PurchaseCardDeps, threadId: string, seq: number) {
  if (deps.events) await bestEffort("purchase card notify", deps.events.notify(threadId, seq));
}
