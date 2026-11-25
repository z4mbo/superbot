import type { SecretStore } from "@rakazo/adapter-kit";
import type { CardSecretValue } from "@rakazo/contracts";
import { cardSummary, cardTitle, decodeCardSecret } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runCardKind } from "@rakazo/db";
import type { BotSecretScope } from "./vault-access.js";
import { cardRedactionForms } from "./vault-redaction.js";

/**
 * A card a Secure form sent for this run only ("Save to Vault" off). It is never a vault item: it
 * waits under the run, is typed only into a checkout the person approves like a saved card, and is
 * dropped with the run. `savedAt` is when it was sent, which an approval is bound to.
 */
export type RunCard = { card: CardSecretValue; title: string; savedAt: string };

/** This run's card under `name` that the person chose not to save, if any. */
export async function findRunCard(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  runId: string,
  name: string,
): Promise<RunCard | undefined> {
  const row = await prisma.secret.findFirst({
    where: { userId: scope.userId, spaceId: scope.spaceId, kind: runCardKind(runId, name) },
    select: { id: true, ciphertext: true, createdAt: true },
  });
  if (!row) return undefined;
  const card = decodeCardSecret(await secretStore.load(row.ciphertext, row.id));
  return { card, title: cardTitle(cardSummary(card)), savedAt: row.createdAt.toISOString() };
}

/** What request_secret tells the bot of a card sent for this run only: never its number or code. */
export function runCardToolView(name: string, card: CardSecretValue) {
  const { billing: _billing, ...summary } = cardSummary(card);
  return { saved: false, name, origin: "", auth: { type: "card" as const }, card: summary };
}

/** Redaction forms of this run's unsaved cards' numbers, from the start of the run. */
export async function loadRunCardRedactions(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  runId: string,
): Promise<string[]> {
  const rows = await prisma.secret.findMany({
    where: {
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: { startsWith: runCardKind(runId, "") },
    },
    select: { id: true, ciphertext: true },
  });
  const forms = new Set<string>();
  for (const row of rows) {
    const { number } = decodeCardSecret(await secretStore.load(row.ciphertext, row.id));
    for (const form of cardRedactionForms(number)) forms.add(form);
  }
  return [...forms];
}
