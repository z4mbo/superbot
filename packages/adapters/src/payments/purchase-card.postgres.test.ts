import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient, Purchase } from "@rakazo/db";
import { asSystem, createDb, installAuditEventStore, storedMessageBlocks } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelWalletPurchase,
  PurchaseNotFoundError,
  postWalletPurchaseCard,
  settlePagePurchaseCard,
  syncWalletPurchaseCard,
  walletCardMethod,
} from "./purchase-card.js";

// Fixture card data: a test number and code no card, event or audit row may ever hold.
const PAN = "4242424242424242";
const CVC = "123";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

dbTests("purchase cards in chat", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const organizations: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    installAuditEventStore(prisma);
  });

  afterAll(async () => {
    installAuditEventStore(undefined);
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
    await prisma.user.deleteMany({ where: { id: { in: organizations } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function setup(status = "pending_approval") {
    const id = randomUUID();
    organizations.push(id);
    await prisma.user.create({
      data: { id, name: "Purchase fixture", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Purchase fixture", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const computer = await prisma.computer.create({
      data: { spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake", state: "running" },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Shopper", color: "test", computerId: computer.id },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Buy the groceries in the cart.",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
    const purchase = await prisma.purchase.create({
      data: {
        operationKey: `op-${id}`,
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        threadGeneration: 0,
        provider: "fake",
        remoteId: `remote-${id}`,
        merchantName: "Fixture Shop",
        merchantUrl: "https://shop.example.test/checkout",
        amount: 2340,
        currency: "usd",
        status,
        approvalUrl: "https://wallet.example.test/approve/1",
        // What the wallet issued stays sealed on the purchase and never reaches its card.
        cardCiphertext: `sealed:${PAN}:${CVC}`,
      },
    });
    const notify = vi.fn(async () => undefined);
    const deps = { prisma, events: { notify } };
    const runRef = { id: run.id, threadId: thread.id, botId: bot.id, spaceId: id };
    const cards = async () => {
      const messages = await prisma.message.findMany({
        where: { threadId: thread.id },
        orderBy: { seq: "asc" },
      });
      return messages.flatMap((message) =>
        storedMessageBlocks(message).filter(
          (block): block is Extract<MessageBlock, { kind: "purchase" }> =>
            block.kind === "purchase",
        ),
      );
    };
    const setStatus = (next: string) =>
      prisma.purchase.update({ where: { id: purchase.id }, data: { status: next } });
    /** Everything a client or the audit log could read about this purchase's chat. */
    const readable = async () =>
      JSON.stringify({
        messages: await prisma.message.findMany({ where: { threadId: thread.id } }),
        events: await prisma.event.findMany({ where: { threadId: thread.id } }),
        audit: await prisma.auditEvent.findMany({ where: { threadId: thread.id } }),
      });
    return { id, bot, thread, run, purchase, deps, notify, runRef, cards, setStatus, readable };
  }

  it("posts one card for a purchase its owner still has to approve", async () => {
    const f = await setup();
    await postWalletPurchaseCard(f.deps, f.runRef, f.purchase.id, "Fixture Wallet");
    // A replay of the same tool call finds the card already posted.
    await postWalletPurchaseCard(f.deps, f.runRef, f.purchase.id, "Fixture Wallet");
    expect(await f.cards()).toEqual([
      {
        kind: "purchase",
        purchaseId: f.purchase.id,
        merchant: "Fixture Shop",
        amount: "$23.40",
        state: "pending",
        wallet: "Fixture Wallet",
        approveUrl: "https://wallet.example.test/approve/1",
      },
    ]);
    const stored = await prisma.purchase.findUniqueOrThrow({ where: { id: f.purchase.id } });
    expect(stored.messageId).toEqual(expect.any(String));
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(
      await prisma.auditEvent.findMany({
        where: { threadId: f.thread.id },
        select: { action: true, metadata: true },
      }),
    ).toEqual([
      {
        action: "purchase.approval_shown",
        metadata: expect.objectContaining({
          source: "wallet",
          merchant: "Fixture Shop",
          amount: "$23.40",
        }),
      },
    ]);
  });

  it("posts no card in another Space's chat", async () => {
    const f = await setup();
    const other = await setup();
    await postWalletPurchaseCard(f.deps, other.runRef, f.purchase.id, "Fixture Wallet");
    expect(await f.cards()).toEqual([]);
    expect(await other.cards()).toEqual([]);
  });

  it("follows the purchase to paid, naming the card only by brand and last four", async () => {
    const f = await setup();
    await postWalletPurchaseCard(f.deps, f.runRef, f.purchase.id, "Fixture Wallet");
    await f.setStatus("approved");
    const method = walletCardMethod({ brand: "visa", last4: "4242", expMonth: 8, expYear: 2030 });
    expect(await syncWalletPurchaseCard(f.deps, f.purchase.id, { method })).toBe("approved");
    // Nothing changed since: no second event, no second audit row.
    expect(await syncWalletPurchaseCard(f.deps, f.purchase.id, { method })).toBeUndefined();
    await f.setStatus("completed");
    expect(await syncWalletPurchaseCard(f.deps, f.purchase.id)).toBe("paid");
    const [card] = await f.cards();
    expect(card).toMatchObject({ state: "paid", method: "Visa ·· 4242" });
    expect(card?.method).toMatch(/4242$/);
    // The approval link is gone once nobody has to approve.
    expect(card).not.toHaveProperty("approveUrl");
    const audit = await prisma.auditEvent.findMany({
      where: { threadId: f.thread.id },
      orderBy: { createdAt: "asc" },
      select: { action: true, metadata: true },
    });
    expect(audit.map((event) => event.action)).toEqual([
      "purchase.approval_shown",
      "purchase.approved",
      "purchase.paid",
    ]);
    expect(audit.at(-1)?.metadata).toMatchObject({ last4: "4242" });
    const readable = await f.readable();
    expect(readable).not.toContain(PAN);
    expect(readable).not.toContain("sealed:");
  });

  it("cancels a purchase from its card, for its owner only", async () => {
    const f = await setup();
    const stranger = await setup();
    await postWalletPurchaseCard(f.deps, f.runRef, f.purchase.id, "Fixture Wallet");
    const settle = vi.fn(async (purchase: Purchase) => {
      await prisma.purchase.update({ where: { id: purchase.id }, data: { status: "canceled" } });
    });
    await expect(
      cancelWalletPurchase(
        f.deps,
        settle,
        { userId: stranger.id, spaceId: stranger.id },
        f.purchase.id,
      ),
    ).rejects.toBeInstanceOf(PurchaseNotFoundError);
    expect(settle).not.toHaveBeenCalled();
    expect((await f.cards())[0]).toMatchObject({ state: "pending" });

    const actor = { userId: f.id, spaceId: f.id };
    expect(await cancelWalletPurchase(f.deps, settle, actor, f.purchase.id)).toBe("canceled");
    expect(settle).toHaveBeenCalledTimes(1);
    expect((await f.cards())[0]).toMatchObject({ state: "canceled" });
    // A second press changes nothing and still answers with where the purchase stands.
    expect(await cancelWalletPurchase(f.deps, settle, actor, f.purchase.id)).toBe("canceled");
    expect(settle).toHaveBeenCalledTimes(1);
    const cancelled = await prisma.auditEvent.findMany({
      where: { threadId: f.thread.id, action: "purchase.canceled" },
      select: { actorType: true, actorId: true },
    });
    expect(cancelled).toEqual([{ actorType: "user", actorId: f.id }]);
  });

  it("does not cancel a purchase that was already paid", async () => {
    const f = await setup("completed");
    const settle = vi.fn(async () => undefined);
    expect(
      await cancelWalletPurchase(f.deps, settle, { userId: f.id, spaceId: f.id }, f.purchase.id),
    ).toBe("paid");
    expect(settle).not.toHaveBeenCalled();
  });

  it("marks an order card paid or failed once, only after its user pressed Pay", async () => {
    const f = await setup();
    const order = (effectId: string, answered: boolean): MessageBlock => ({
      kind: "ask",
      approvalEffectId: effectId,
      text: "Pay on shop.example.test?",
      receipt: { button: "Pay $113", items: [], amount: "$113", amountSource: "button" },
      payment: { merchant: "shop.example.test", method: "Visa ·· 4242" },
      status: answered ? "answered" : "pending",
      ...(answered ? { answer: "allow" } : {}),
      actions: [
        { id: "allow", label: "Pay" },
        { id: "deny", label: "Cancel" },
      ],
    });
    let seq = 0;
    for (const [effectId, answered] of [
      ["effect-paid", true],
      ["effect-waiting", false],
    ] as const)
      await prisma.message.create({
        data: {
          threadId: f.thread.id,
          botId: f.bot.id,
          runId: f.run.id,
          seq: seq++,
          role: "bot",
          blocks: [order(effectId, answered)],
        },
      });
    const outcomes = async () => {
      const messages = await prisma.message.findMany({
        where: { threadId: f.thread.id },
        orderBy: { seq: "asc" },
      });
      return messages.flatMap((message) =>
        storedMessageBlocks(message).map((block) =>
          block.kind === "ask" ? (block.payment?.outcome ?? null) : null,
        ),
      );
    };
    const run = { id: f.run.id, threadId: f.thread.id, spaceId: f.id };
    await settlePagePurchaseCard(f.deps, run, f.bot, "effect-paid", "paid");
    // A later failure report for the same press does not rewrite what the card says.
    await settlePagePurchaseCard(f.deps, run, f.bot, "effect-paid", "failed");
    // A card nobody approved is never marked: nothing was pressed.
    await settlePagePurchaseCard(f.deps, run, f.bot, "effect-waiting", "paid");
    expect(await outcomes()).toEqual(["paid", null]);
    const audit = await prisma.auditEvent.findMany({
      where: { threadId: f.thread.id },
      select: { action: true, metadata: true },
    });
    expect(audit).toEqual([
      {
        action: "purchase.paid",
        metadata: expect.objectContaining({
          source: "page",
          merchant: "shop.example.test",
          amount: "$113",
          last4: "4242",
        }),
      },
    ]);
    expect(await f.readable()).not.toContain(PAN);
  });
});
