import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  formatPurchaseAmount,
  isPaymentAskBlock,
  isPurchaseCardBlock,
  purchaseCardView,
  walletPurchaseCardState,
} from "./purchase-card.js";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
type PurchaseBlock = Extract<MessageBlock, { kind: "purchase" }>;

function paymentAsk(overrides: Partial<AskBlock> = {}): AskBlock {
  return {
    kind: "ask",
    approvalEffectId: "effect-1",
    text: "Pay on shop.example.test?",
    receipt: { button: "Pay $113", amount: "$113", amountSource: "page", items: [] },
    payment: { merchant: "shop.example.test", method: "Visa ·· 4242" },
    status: "pending",
    actions: [
      { id: "allow", label: "Pay" },
      { id: "deny", label: "Cancel" },
    ],
    ...overrides,
  } as AskBlock;
}

function walletPurchase(overrides: Partial<PurchaseBlock> = {}): PurchaseBlock {
  return {
    kind: "purchase",
    purchaseId: "purchase-1",
    merchant: "Fixture Shop",
    amount: "$23.40",
    state: "pending",
    wallet: "Fixture Wallet",
    approveUrl: "https://wallet.example.test/approve/1",
    ...overrides,
  };
}

describe("isPaymentAskBlock", () => {
  it("is a payment approval the gate posted, and no other approval", () => {
    const ask = paymentAsk();
    if (!isPaymentAskBlock(ask)) throw new Error("expected a payment card");
    expect(isPurchaseCardBlock(ask)).toBe(true);
    const { payment: _payment, ...plain } = ask;
    expect(isPaymentAskBlock(plain as AskBlock)).toBe(false);
    // A block that only claims to be a payment has no approval behind it.
    expect(isPaymentAskBlock(paymentAsk({ approvalEffectId: undefined }))).toBe(false);
    expect(isPurchaseCardBlock(walletPurchase())).toBe(true);
    expect(isPurchaseCardBlock({ kind: "text", text: "Pay on shop.example.test?" })).toBe(false);
  });
});

describe("purchaseCardView", () => {
  function view(block: AskBlock | PurchaseBlock) {
    if (!isPurchaseCardBlock(block)) throw new Error("expected a purchase card");
    return purchaseCardView(block);
  }

  it("shows a page purchase's merchant, order and method while it waits", () => {
    expect(view(paymentAsk())).toEqual({
      merchant: "shop.example.test",
      receipt: { button: "Pay $113", amount: "$113", amountSource: "page", items: [] },
      method: "Visa ·· 4242",
      state: "pending",
    });
  });

  it("follows a page purchase from the answer to how the press ended", () => {
    const answered = { status: "answered" as const };
    expect(view(paymentAsk({ ...answered, answer: "allow" })).state).toBe("approved");
    expect(view(paymentAsk({ ...answered, answer: "deny" })).state).toBe("canceled");
    expect(view(paymentAsk({ ...answered, answer: "deny", expired: true })).state).toBe("expired");
    for (const outcome of ["paid", "failed"] as const)
      expect(
        view(
          paymentAsk({
            ...answered,
            answer: "allow",
            payment: { merchant: "shop.example.test", outcome },
          }),
        ).state,
      ).toBe(outcome);
  });

  it("offers the wallet's approval only while its owner can still decide", () => {
    expect(view(walletPurchase())).toEqual({
      merchant: "Fixture Shop",
      amount: "$23.40",
      state: "pending",
      wallet: { name: "Fixture Wallet", approveUrl: "https://wallet.example.test/approve/1" },
    });
    expect(view(walletPurchase({ state: "paid", method: "Visa ·· 4242" }))).toEqual({
      merchant: "Fixture Shop",
      amount: "$23.40",
      method: "Visa ·· 4242",
      state: "paid",
      wallet: { name: "Fixture Wallet" },
    });
  });
});

describe("walletPurchaseCardState", () => {
  it("maps every wallet status to what its card says", () => {
    expect(
      Object.fromEntries(
        [
          "pending_approval",
          "needs_action",
          "approved",
          "completed",
          "expired",
          "failed",
          "denied",
          "canceled",
        ].map((status) => [status, walletPurchaseCardState(status)]),
      ),
    ).toEqual({
      pending_approval: "pending",
      needs_action: "pending",
      approved: "approved",
      completed: "paid",
      expired: "expired",
      failed: "failed",
      denied: "canceled",
      canceled: "canceled",
    });
  });

  it("never reads a status it does not know as paid or approved", () => {
    expect(walletPurchaseCardState("something_new")).toBe("canceled");
  });
});

describe("formatPurchaseAmount", () => {
  it("formats minor units in the currency's own decimals", () => {
    expect(formatPurchaseAmount(2340, "usd")).toBe("$23.40");
    expect(formatPurchaseAmount(1000, "jpy")).toBe("¥1,000");
    // Three decimals; the space after the code is whichever one the runtime's locale data uses.
    expect(formatPurchaseAmount(1234, "kwd")).toMatch(/^KWD\s1\.234$/);
  });

  it("falls back to the bare amount for a code that is no currency", () => {
    expect(formatPurchaseAmount(500, "not-a-currency")).toBe("500 NOT-A-CURRENCY");
  });
});
