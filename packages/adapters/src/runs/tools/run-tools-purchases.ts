import { bestEffort } from "@rakazo/logging";
import { executePaidRequest } from "../../payments/paid-request.js";
import { postWalletPurchaseCard } from "../../payments/purchase-card.js";
import { executePurchaseTool, PENDING_PURCHASE_STATUSES } from "../../payments/purchase-service.js";
import type { RunContext } from "../assembly/run-context.js";
import { addRunSecrets } from "../assembly/run-context.js";
import { runLeaseFor } from "../assembly/run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

// The effect key is stable across replays, so a retried request reuses its purchase.
const purchaseContext = (ctx: RunContext, call: ToolCall) => ({
  ...ctx.context,
  operationId: call.effectKey,
  botId: ctx.bot.id,
});

/**
 * A purchase this call asked the wallet for gets its card in the chat while its owner decides, so
 * they can follow it and cancel it there. A replay finds the card already posted.
 */
async function showPurchaseCard(ctx: RunContext, call: ToolCall) {
  const wallet = ctx.deps.paymentWallet;
  if (!wallet) return;
  const purchase = await ctx.deps.prisma.purchase.findUnique({
    where: { operationKey: call.effectKey },
    select: { id: true, status: true, messageId: true, spaceId: true },
  });
  if (
    !purchase ||
    purchase.messageId ||
    purchase.spaceId !== ctx.run.spaceId ||
    !PENDING_PURCHASE_STATUSES.has(purchase.status)
  )
    return;
  await bestEffort(
    "purchase card",
    postWalletPurchaseCard(
      ctx.deps,
      {
        id: ctx.runId,
        threadId: ctx.thread.id,
        botId: ctx.bot.id,
        spaceId: ctx.run.spaceId,
        lease: runLeaseFor(ctx.deps, ctx.runId),
      },
      purchase.id,
      wallet.displayName,
    ),
  );
}

async function purchaseTool(ctx: RunContext, call: ToolCall) {
  const result = await executePurchaseTool(
    ctx.deps,
    purchaseContext(ctx, call),
    ctx.run,
    call.name,
    call.args,
  );
  if (call.name === "request_purchase") await showPurchaseCard(ctx, call);
  return call.finish(result);
}

/** Purchases from the user's connected wallet. */
export const purchaseTools: ToolHandlers = {
  request_purchase: purchaseTool,
  purchase_status: purchaseTool,
  async paid_request(ctx, call) {
    const { result, redactions } = await executePaidRequest(
      ctx.deps,
      purchaseContext(ctx, call),
      ctx.run,
      call.args,
    );
    addRunSecrets(ctx, redactions);
    await showPurchaseCard(ctx, call);
    return call.finish(result);
  },
};
