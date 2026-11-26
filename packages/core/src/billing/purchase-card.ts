import type { AskReceipt, MessageBlock, PurchaseCardState } from "@rakazo/contracts";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
type PurchaseBlock = Extract<MessageBlock, { kind: "purchase" }>;

/** A payment approval the gate posted: an order card the user pays or cancels. */
export type PaymentAskBlock = AskBlock & { payment: NonNullable<AskBlock["payment"]> };

export function isPaymentAskBlock(block: MessageBlock): block is PaymentAskBlock {
  return block.kind === "ask" && Boolean(block.payment) && Boolean(block.approvalEffectId);
}

/** Any block drawn as a purchase card: a page purchase's order card or a wallet purchase. */
export function isPurchaseCardBlock(block: MessageBlock): block is PaymentAskBlock | PurchaseBlock {
  return block.kind === "purchase" || isPaymentAskBlock(block);
}

/**
 * What a purchase card shows, the same for a page purchase the user approves in chat and a wallet
 * purchase its owner approves in the wallet. Everything here comes from the stored block, so a
 * reload shows the same card.
 */
export type PurchaseCardView = {
  merchant: string;
  /** A page purchase's order as the page shows it. */
  receipt?: AskReceipt;
  /** A wallet purchase's amount, as the bot asked the wallet for it. */
  amount?: string;
  /** The payment method by reference only: a card's title, or its brand and last four digits. */
  method?: string;
  state: PurchaseCardState;
  /** A wallet purchase: the wallet's name and where its owner approves it. */
  wallet?: { name: string; approveUrl?: string };
};

export function purchaseCardView(block: PaymentAskBlock | PurchaseBlock): PurchaseCardView {
  if (block.kind === "purchase")
    return {
      merchant: block.merchant,
      amount: block.amount,
      ...(block.method ? { method: block.method } : {}),
      state: block.state,
      wallet: {
        name: block.wallet,
        // Only while the owner can still decide on the wallet's side.
        ...(block.approveUrl && block.state === "pending" ? { approveUrl: block.approveUrl } : {}),
      },
    };
  return {
    merchant: block.payment.merchant,
    ...(block.receipt ? { receipt: block.receipt } : {}),
    ...(block.payment.method ? { method: block.payment.method } : {}),
    state: paymentAskState(block),
  };
}

function paymentAskState(block: PaymentAskBlock): PurchaseCardState {
  if (block.status !== "answered") return "pending";
  if (block.expired) return "expired";
  if (block.answer !== "allow") return "canceled";
  return block.payment.outcome ?? "approved";
}

/** A wallet's purchase status as its card shows it. */
export function walletPurchaseCardState(status: string): PurchaseCardState {
  switch (status) {
    case "pending_approval":
    case "needs_action":
      return "pending";
    case "approved":
      return "approved";
    case "completed":
      return "paid";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    default:
      // Denied in the wallet, or canceled from the chat: either way nothing is paid.
      return "canceled";
  }
}

/** A wallet purchase's amount, from the minor units wallets take, in the currency's own format. */
export function formatPurchaseAmount(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const format = new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amount / 10 ** digits);
  } catch {
    return `${amount} ${code}`;
  }
}
