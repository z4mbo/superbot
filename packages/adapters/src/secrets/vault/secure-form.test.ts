import type { BotSecretDestination } from "@rakazo/contracts";
import { encodeCardSecret } from "@rakazo/contracts";
import { installAuditEventStore, runCardKind } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAuditLog, fakeDatabase } from "../bot-secrets.test-support.js";
import { createRunSecretWriter } from "../run-secret.js";
import { EncryptedSecretStore } from "../secrets.js";
import { expectNoVaultSecrets, findVaultSecretLeaks } from "./vault-leak.test-support.js";
import { findRunCard, runCardToolView } from "./vault-run-card.js";

// Fixture values only.
const CARD = { number: "4242424242424242", expMonth: 8, expYear: 2030, cvc: "123" };
const FIXTURE = { cardNumbers: [CARD.number], cvcs: [CARD.cvc] };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };

afterEach(() => installAuditEventStore(undefined));

/** A run waiting on a Secure form for `credential`, with what it holds for itself. */
function waitingOn(credential: BotSecretDestination) {
  const db = fakeDatabase();
  const runSecrets: Array<{ id: string; kind: string; ciphertext: string; createdAt: Date }> = [];
  Object.assign(db.prisma, {
    run: { findFirst: async () => ({ botId: scope.botId, userId: scope.userId }) },
    message: {
      findFirst: async () => ({
        blocks: [{ kind: "ask", text: "Card", input: "secret", status: "pending", credential }],
      }),
    },
    secret: {
      count: async () => 0,
      findFirst: async ({ where }: { where: { kind: string } }) =>
        runSecrets.find((row) => row.kind === where.kind) ?? null,
      deleteMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: { id: string; kind: string; ciphertext: string } }) =>
        runSecrets.push({ ...data, createdAt: new Date("2026-11-25T10:00:00.000Z") }),
    },
  });
  return { db, runSecrets };
}

/** The person sends the form, as the threads.answer route hands it to the run. */
function send(
  db: ReturnType<typeof fakeDatabase>,
  credential: BotSecretDestination,
  answer: string,
  remember?: false,
) {
  return createRunSecretWriter(secretStore).withPrepared!(
    db.prisma,
    {
      spaceId: scope.spaceId,
      runId: "run-1",
      threadId: "thread-1",
      messageId: "message-1",
      answeredByUserId: scope.userId,
      answer,
      ...(remember === false ? { remember } : {}),
    },
    (writer) =>
      db.prisma.$transaction(async (tx) => {
        await writer.store({
          botId: scope.botId,
          credential,
          remember: remember !== false,
          runId: "run-1",
          userId: scope.userId,
          spaceId: scope.spaceId,
          plaintext: answer,
          tx: tx as never,
        });
        return true;
      }),
  );
}

const cardForm = { name: "checkout_card", origin: "", auth: { type: "card" as const } };

describe("a Secure form for a card", () => {
  it("sent for one fill, waits under the run only, and the bot sees only its summary", async () => {
    const audit = fakeAuditLog();
    const { db, runSecrets } = waitingOn(cardForm);
    await send(db, cardForm, encodeCardSecret(CARD), false);

    // Nothing in the vault; the card waits, encrypted, under this run for the fill to read.
    expect(db.rows()).toEqual([]);
    expect(runSecrets).toEqual([
      expect.objectContaining({ kind: runCardKind("run-1", "checkout_card") }),
    ]);
    const held = await findRunCard(db.prisma, secretStore, scope, "run-1", "checkout_card");
    expect(held?.card).toMatchObject({ number: CARD.number, cvc: CARD.cvc });
    expect(held?.title).toBe("Visa ·· 4242");

    // What request_secret tells the bot of it, and what the audit log keeps: no number, no code.
    const view = runCardToolView("checkout_card", held!.card);
    expect(view).toEqual({
      saved: false,
      name: "checkout_card",
      origin: "",
      auth: { type: "card" },
      card: { brand: "Visa", last4: "4242", expMonth: 8, expYear: 2030 },
    });
    expect(audit).toEqual([
      expect.objectContaining({
        action: "vault.fill_approved",
        actorType: "user",
        targetType: "secure_form",
        targetLabel: "checkout_card",
        runId: "run-1",
        metadata: { name: "checkout_card", kind: "card" },
      }),
    ]);
    expectNoVaultSecrets({ view, audit, stored: runSecrets }, FIXTURE);
  });

  it("saved, is a vault item, and its activity records the form that saved it", async () => {
    const audit = fakeAuditLog();
    const { db, runSecrets } = waitingOn(cardForm);
    await send(db, cardForm, encodeCardSecret(CARD));

    expect(runSecrets).toEqual([]);
    const [item] = db.rows();
    expect(item).toMatchObject({ name: "checkout_card", auth: { type: "card" } });
    expect(JSON.parse(await secretStore.load(item!.ciphertext, item!.id))).toMatchObject({
      number: CARD.number,
    });
    expect(audit).toEqual([
      expect.objectContaining({
        action: "vault.form_saved",
        targetType: "vault_credential",
        targetId: item!.id,
        targetLabel: "checkout_card",
        metadata: expect.objectContaining({ kind: "card", name: "checkout_card" }),
      }),
    ]);
    expectNoVaultSecrets({ audit }, FIXTURE);
  });

  it("refuses one-time use for a form that is not a login or a card, keeping nothing", async () => {
    const audit = fakeAuditLog();
    const contact = { name: "home", origin: "", auth: { type: "contact" as const } };
    const { db, runSecrets } = waitingOn(contact);
    await expect(send(db, contact, '{"phone":"+1 555 0100"}', false)).rejects.toThrow(
      "Secret request changed; retry",
    );
    expect(db.rows()).toEqual([]);
    expect(runSecrets).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("would be caught if a value reached what the bot reads", async () => {
    const { db } = waitingOn(cardForm);
    await send(db, cardForm, encodeCardSecret(CARD), false);
    const held = await findRunCard(db.prisma, secretStore, scope, "run-1", "checkout_card");
    // Negative control: the card itself, handed back as a tool result, is found.
    expect(findVaultSecretLeaks({ "tool result": held }, FIXTURE)).toEqual([
      'card number "4242424242424242" in tool result',
      'security code "123" in tool result',
    ]);
  });
});
