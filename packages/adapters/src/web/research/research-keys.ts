import type { SecretStore } from "@rakazo/adapter-kit";
import type { ResearchKeyProvider } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem, withTransactionRetry } from "@rakazo/db";
import { z } from "zod";
import type { SecretCleanup, SecretCleanupDeps } from "../../secrets/secret-cleanup.js";
import {
  cleanUpUnsavedSecret,
  finishSecretCleanup,
  recordSecretCleanup,
} from "../../secrets/secret-cleanup.js";
import { researchProvider, researchProviderDescriptors } from "./research-providers.js";

/**
 * A research key is an account-level secret row (no Space), like account computer settings: only
 * its owner's runs use it, in every Space they work in.
 */
const KIND_PREFIX = "research-key:";
const storedKeySchema = z.object({ provider: z.string(), key: z.string().min(1) });
/** Printable characters without spaces: what an API key sent in a header can hold. */
const KEY_CHARACTERS = /^[\x21-\x7e]+$/;

export type ResearchKeyDeps = Pick<SecretCleanupDeps, "jobs"> & {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load" | "delete" | "isRemote">;
};

type Account = { userId: string; spaceId: string };

function kind(providerId: string) {
  return `${KIND_PREFIX}${providerId}`;
}

function accountRows(userId: string, providerIds: readonly string[]) {
  return { userId, spaceId: null, kind: { in: providerIds.map(kind) } };
}

/** Provider ids this account saved a key for. Reads no secret. */
export async function savedResearchProviderIds(
  prisma: Pick<PrismaClient, "secret">,
  userId: string,
): Promise<Set<string>> {
  const ids = researchProviderDescriptors().map((descriptor) => descriptor.id);
  const rows = await runAsSystem("read which research keys an account saved", () =>
    prisma.secret.findMany({ where: accountRows(userId, ids), select: { kind: true } }),
  );
  return new Set(rows.map((row) => row.kind.slice(KIND_PREFIX.length)));
}

/** The key this account saved for a provider, or undefined when there is none or it is unreadable. */
export async function loadResearchKey(
  deps: { prisma: Pick<PrismaClient, "secret">; secrets: Pick<SecretStore, "load"> },
  userId: string,
  providerId: string,
): Promise<string | undefined> {
  const row = await runAsSystem("read an account's research key", () =>
    deps.prisma.secret.findFirst({
      where: { userId, spaceId: null, kind: kind(providerId) },
      orderBy: { createdAt: "desc" },
      select: { id: true, ciphertext: true },
    }),
  );
  if (!row) return undefined;
  const stored = storedKeySchema.safeParse(
    parseJson(await deps.secrets.load(row.ciphertext, row.id)),
  );
  return stored.success && stored.data.provider === providerId ? stored.data.key : undefined;
}

export async function listResearchKeys(
  prisma: Pick<PrismaClient, "secret">,
  userId: string,
): Promise<ResearchKeyProvider[]> {
  const saved = await savedResearchProviderIds(prisma, userId);
  return researchProviderDescriptors().map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    capability: descriptor.capability,
    saved: saved.has(descriptor.id),
  }));
}

/** Saves or replaces the account's key for one provider. The key is never read back to a client. */
export async function saveResearchKey(
  deps: ResearchKeyDeps,
  account: Account,
  input: { provider: string; key: string },
): Promise<ResearchKeyProvider[]> {
  const provider = researchProvider(input.provider);
  if (!provider) throw new ClientError("BAD_REQUEST", "Unknown provider");
  const key = input.key.trim();
  if (!KEY_CHARACTERS.test(key))
    throw new ClientError("BAD_REQUEST", "Enter the key without spaces or line breaks.");
  const stored = await deps.secrets.put(JSON.stringify({ provider: provider.descriptor.id, key }), {
    operationId: "research-key",
    traceId: "research-key",
    spaceId: account.spaceId,
    userId: account.userId,
    signal: new AbortController().signal,
  });
  const mine = { userId: account.userId, spaceId: null, kind: kind(provider.descriptor.id) };
  let replaced: SecretCleanup[];
  try {
    replaced = await withTransactionRetry(() =>
      runAsSystem("an account saves a research key", () =>
        deps.prisma.$transaction(
          async (tx) => {
            const secret = await tx.secret.create({
              data: { ...mine, id: stored.id, ciphertext: stored.ciphertext },
            });
            return dropRows(deps, tx, { ...mine, id: { not: secret.id } });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      ),
    );
  } catch (error) {
    await cleanUpUnsavedSecret(deps, rowSecret(stored));
    throw error;
  }
  // A remote secret store keeps the replaced value until it is deleted there too.
  await Promise.all(replaced.map((cleanup) => finishSecretCleanup(deps, cleanup)));
  return listResearchKeys(deps.prisma, account.userId);
}

/** Removes the account's key for one provider; removing a key that is not saved is a no-op. */
export async function removeResearchKey(
  deps: ResearchKeyDeps,
  account: Account,
  providerId: string,
): Promise<ResearchKeyProvider[]> {
  if (!researchProvider(providerId)) throw new ClientError("BAD_REQUEST", "Unknown provider");
  const mine = { userId: account.userId, spaceId: null, kind: kind(providerId) };
  const removed = await runAsSystem("an account removes a research key", () =>
    deps.prisma.$transaction((tx) => dropRows(deps, tx, mine)),
  );
  await Promise.all(removed.map((cleanup) => finishSecretCleanup(deps, cleanup)));
  return listResearchKeys(deps.prisma, account.userId);
}

/** In the transaction that deletes the rows, so their store entries are removed even after a crash. */
async function dropRows(
  deps: ResearchKeyDeps,
  tx: Prisma.TransactionClient,
  where: Prisma.SecretWhereInput,
): Promise<SecretCleanup[]> {
  const rows = await tx.secret.findMany({ where, select: { id: true, ciphertext: true } });
  if (rows.length === 0) return [];
  await tx.secret.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  const cleanups = rows.map(rowSecret);
  for (const cleanup of cleanups) await recordSecretCleanup(deps, tx, cleanup);
  return cleanups;
}

function rowSecret(row: { id: string; ciphertext: string }): SecretCleanup {
  return { kind: "secret_row", recordId: row.id, ref: row.ciphertext };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // An unreadable entry counts as no saved key.
    return undefined;
  }
}

/** The research tools this account turned on by saving a key for their provider. */
export async function savedResearchTools(
  prisma: Pick<PrismaClient, "secret">,
  userId: string,
): Promise<Set<string>> {
  const saved = await savedResearchProviderIds(prisma, userId);
  return new Set(
    researchProviderDescriptors()
      .filter((descriptor) => saved.has(descriptor.id))
      .map((descriptor) => descriptor.toolName),
  );
}
