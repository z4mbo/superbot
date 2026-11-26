// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { MessageBlock } from "@rakazo/contracts";
import type { PaymentAskBlock } from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useLinkFavicon: () => ({ icon: null, unusable: () => undefined }),
}));
const { rpc } = vi.hoisted(() => ({
  rpc: {
    paymentWallet: {
      cancelPurchase: vi.fn(async (_input: { id: string }) => ({ state: "canceled" })),
    },
  },
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc,
  rpcForSpace: () => rpc,
  createSpaceRpc: () => rpc,
  selectedSpaceId: () => null,
}));
vi.mock("../vault/use-vault-contacts", () => ({ useVaultContacts: () => [] }));

import type { PurchaseCardProps } from "./PurchaseCard";
import { PurchaseCard } from "./PurchaseCard";

type PurchaseBlock = Extract<MessageBlock, { kind: "purchase" }>;

// Fixture card data: a test number the card must never show, and the reference it may.
const PAN = "4242424242424242";
const CVC = "123";
const METHOD = "Visa ·· 4242";

const orderCard: PaymentAskBlock = {
  kind: "ask",
  approvalEffectId: "effect-1",
  text: "Pay on shop.example.test?",
  detail: 'Button: "Pay $113"\nTotal on the page: $113',
  receipt: { button: "Pay $113", items: [], amount: "$113", amountSource: "button" },
  payment: { merchant: "shop.example.test", method: METHOD },
  status: "pending",
  actions: [
    { id: "allow", label: "Pay" },
    { id: "deny", label: "Cancel" },
  ],
};

const walletCard: PurchaseBlock = {
  kind: "purchase",
  purchaseId: "purchase-1",
  merchant: "Fixture Shop",
  amount: "$23.40",
  state: "pending",
  wallet: "Fixture Wallet",
  approveUrl: "https://wallet.example.test/approve/purchase-1",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rpc.paymentWallet.cancelPurchase.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(props: PurchaseCardProps) {
  const client = new QueryClient();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PurchaseCard {...props} />
      </QueryClientProvider>,
    ),
  );
}

function buttons() {
  return [...container.querySelectorAll("button")].map((button) => button.textContent);
}

async function press(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`No ${label} button among ${buttons().join(", ")}`);
  await act(async () => button.click());
}

it("offers Pay and Cancel on an order card, and nothing that would skip the next payment", async () => {
  await render({ block: orderCard, canAnswer: true, onAnswer: async () => undefined });
  expect(buttons()).toEqual(["Pay", "Cancel"]);
  expect(container.textContent).toContain("shop.example.test");
  expect(container.textContent).toContain("$113");
  expect(container.textContent).not.toMatch(/always/i);
  // The payment method is named by reference: never a full number or a security code.
  expect(container.textContent).toContain(METHOD);
  expect(container.innerHTML).not.toContain(PAN);
  expect(container.innerHTML).not.toContain(CVC);
});

it("sends Pay as the approval and shows it approved while the chat catches up", async () => {
  const sent = deferred<void>();
  const onAnswer = vi.fn(() => sent.promise);
  await render({ block: orderCard, canAnswer: true, onAnswer });
  await press("Pay");
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith("allow");
  // Held while it is sent: a second press cannot pay twice.
  expect(buttons()).toEqual(["Paying…", "Cancel"]);
  expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  await act(async () => sent.resolve());
  expect(buttons()).toEqual([]);
  expect(container.querySelector('[data-testid="purchase-state"]')?.textContent).toBe("Approved");
});

it("sends Cancel as a denial", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render({ block: orderCard, canAnswer: true, onAnswer });
  await press("Cancel");
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith("deny");
  expect(container.querySelector('[data-testid="purchase-state"]')?.textContent).toBe("Cancelled");
});

it("keeps the buttons and says why when the answer could not be sent", async () => {
  await render({
    block: orderCard,
    canAnswer: true,
    onAnswer: async () => {
      throw new Error("offline");
    },
  });
  await press("Pay");
  expect(buttons()).toEqual(["Pay", "Cancel"]);
  expect(container.querySelector(".text-destructive")).not.toBeNull();
});

it("shows how an answered order card ended, with no buttons", async () => {
  const answered = { ...orderCard, status: "answered" as const, answer: "allow" };
  for (const [outcome, label] of [
    ["paid", "Paid"],
    ["failed", "Failed"],
  ] as const) {
    await render({
      block: { ...answered, payment: { ...orderCard.payment, outcome } },
      canAnswer: false,
      onAnswer: async () => undefined,
    });
    expect(buttons()).toEqual([]);
    expect(container.querySelector('[data-testid="purchase-state"]')?.textContent).toBe(label);
  }
});

it("offers nothing on a pending order card someone else has to answer", async () => {
  await render({ block: orderCard, canAnswer: false, onAnswer: async () => undefined });
  expect(buttons()).toEqual([]);
  expect(container.textContent).toContain("No longer active");
});

it("opens the wallet to approve a wallet purchase and cancels it from the chat", async () => {
  const open = vi.fn();
  vi.stubGlobal("open", open);
  await render({ block: walletCard });
  expect(buttons()).toEqual(["Approve in Fixture Wallet", "Cancel"]);
  expect(container.textContent).toContain("Fixture Shop");
  expect(container.textContent).toContain("$23.40");
  await press("Approve in Fixture Wallet");
  expect(open).toHaveBeenCalledExactlyOnceWith(
    walletCard.approveUrl,
    "_blank",
    "noopener,noreferrer",
  );
  await press("Cancel");
  expect(rpc.paymentWallet.cancelPurchase).toHaveBeenCalledExactlyOnceWith({ id: "purchase-1" });
  expect(container.querySelector('[data-testid="purchase-state"]')?.textContent).toBe("Cancelled");
});

it("shows a settled wallet purchase with the card it paid with, by reference only", async () => {
  await render({
    block: { ...walletCard, state: "paid", approveUrl: undefined, method: METHOD },
  });
  expect(buttons()).toEqual([]);
  expect(container.querySelector('[data-testid="purchase-state"]')?.textContent).toBe("Paid");
  expect(container.textContent).toContain(METHOD);
  expect(container.innerHTML).not.toContain(PAN);
});
