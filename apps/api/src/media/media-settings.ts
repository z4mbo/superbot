import type { MediaGenerationProvider, SecretStore } from "@rakazo/adapter-kit";
import type { MediaProviderRegistry, MediaRouterDeps } from "@rakazo/adapters";
import {
  knownMediaProvider,
  listMediaProviders,
  parseMediaKey,
  readMediaPreference,
  serializeMediaKey,
} from "@rakazo/adapters";
import type {
  Actor,
  MediaCatalog,
  MediaKind,
  MediaPreference,
  MediaProviderEntry,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { deleteUnreferencedCredentialSecret, Prisma, withTransactionRetry } from "@rakazo/db";

export type MediaSettingsDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  /** The server's own provider, shown as what a kind falls back to. */
  mediaGeneration?: MediaGenerationProvider;
  mediaProviders?: MediaProviderRegistry;
};

type Owner = Pick<Actor, "userId" | "spaceId">;

function routerDeps(deps: MediaSettingsDeps): MediaRouterDeps {
  return {
    prisma: deps.prisma,
    secretStore: deps.secrets,
    serverDefault: deps.mediaGeneration,
    registry: deps.mediaProviders,
  };
}

function mediaContext(actor: Owner, signal?: AbortSignal) {
  return {
    operationId: "media",
    traceId: "media",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };

/** Every media provider as it stands for the person, with their saved choice. */
export function mediaCatalog(deps: MediaSettingsDeps, actor: Owner): Promise<MediaCatalog> {
  return listMediaProviders(routerDeps(deps), actor);
}

async function mediaEntry(
  deps: MediaSettingsDeps,
  actor: Owner,
  provider: string,
): Promise<MediaProviderEntry> {
  const { providers } = await mediaCatalog(deps, actor);
  const entry = providers.find((candidate) => candidate.id === provider);
  if (!entry) throw new ClientError("NOT_FOUND", "Unknown media provider.");
  return entry;
}

/**
 * Saves a provider's key: every field of its form as one sealed value, and the fields that are
 * not secret as hints Settings shows back. A blank secret field keeps the saved one, so a key
 * id can change without pasting the secret again. Nothing secret is returned.
 */
export async function connectMediaProvider(
  deps: MediaSettingsDeps,
  actor: Owner,
  input: { provider: string; fields: Record<string, string> },
  signal?: AbortSignal,
): Promise<MediaProviderEntry> {
  const definition = knownMediaProvider(input.provider, deps.mediaProviders);
  // A provider that only borrows a model connection has nothing to paste.
  if (!definition?.catalog.fields.length) {
    throw new ClientError("BAD_REQUEST", "Unknown media provider.");
  }
  const form = definition.catalog.fields;
  if (Object.keys(input.fields).some((name) => !form.some((field) => field.name === name))) {
    throw new ClientError("BAD_REQUEST", "Unknown field for this provider.");
  }
  const existing = await deps.prisma.userMediaCredential.findUnique({
    where: { userId_provider: { userId: actor.userId, provider: input.provider } },
  });
  let previous: Record<string, string> | undefined;
  const fields: Record<string, string> = {};
  for (const field of form) {
    let value = input.fields[field.name]?.trim() ?? "";
    if (!value && field.secret && existing) {
      previous ??= await savedFields(deps, actor, existing.secretId);
      value = previous?.[field.name] ?? "";
    }
    if (!value) throw new ClientError("BAD_REQUEST", `Enter the ${field.label}.`);
    fields[field.name] = value;
  }
  const hints = Object.fromEntries(
    form.filter((field) => !field.secret).map((field) => [field.name, fields[field.name]!]),
  );
  const stored = await deps.secrets.put(serializeMediaKey(fields), mediaContext(actor, signal));
  await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const current = await tx.userMediaCredential.findUnique({
        where: { userId_provider: { userId: actor.userId, provider: input.provider } },
      });
      const secret = await tx.secret.create({
        data: {
          id: stored.id,
          userId: actor.userId,
          spaceId: null,
          kind: "media",
          ciphertext: stored.ciphertext,
        },
      });
      if (current) {
        await tx.userMediaCredential.update({
          where: { id: current.id },
          data: { secretId: secret.id, hints },
        });
        await deleteUnreferencedCredentialSecret(tx, {
          credentialKind: "media",
          credentialId: current.id,
          secretId: current.secretId,
        });
      } else {
        await tx.userMediaCredential.create({
          data: { userId: actor.userId, provider: input.provider, secretId: secret.id, hints },
        });
      }
    }, serializable),
  );
  return mediaEntry(deps, actor, input.provider);
}

async function savedFields(
  deps: MediaSettingsDeps,
  actor: Owner,
  secretId: string,
): Promise<Record<string, string> | undefined> {
  const row = await deps.prisma.secret.findFirst({
    where: { id: secretId, userId: actor.userId, spaceId: null },
  });
  if (!row) return undefined;
  try {
    return parseMediaKey(await deps.secrets.load(row.ciphertext, row.id));
  } catch {
    // An unreadable key has nothing to keep; the form must be complete.
    return undefined;
  }
}

/** Removes the person's own key for a provider, and its sealed value once nothing holds it. */
export async function disconnectMediaProvider(
  deps: MediaSettingsDeps,
  actor: Owner,
  input: { provider: string },
): Promise<{ ok: true }> {
  await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const rows = await tx.userMediaCredential.findMany({
        where: { userId: actor.userId, provider: input.provider },
      });
      if (!rows.length) return;
      await tx.userMediaCredential.deleteMany({
        where: { userId: actor.userId, id: { in: rows.map((row) => row.id) } },
      });
      for (const row of rows) {
        await deleteUnreferencedCredentialSecret(tx, {
          credentialKind: "media",
          credentialId: row.id,
          secretId: row.secretId,
        });
      }
    }, serializable),
  );
  return { ok: true as const };
}

/**
 * Saves which provider, and optionally which model, a kind uses first. Only a connected
 * provider that makes that kind can be chosen; null clears the choice.
 */
export async function setMediaPreference(
  deps: MediaSettingsDeps,
  actor: Owner,
  input: { kind: MediaKind; provider: string | null; model?: string | null },
): Promise<MediaPreference> {
  if (input.provider === null) {
    await deps.prisma.userMediaPreference.deleteMany({
      where: { userId: actor.userId, kind: input.kind },
    });
    return readMediaPreference(deps.prisma, actor.userId);
  }
  const entry = await mediaEntry(deps, actor, input.provider);
  const makes = input.kind === "video" ? entry.capabilities.video : entry.capabilities.image;
  if (!entry.connected) throw new ClientError("BAD_REQUEST", `Connect ${entry.name} first.`);
  if (!makes) throw new ClientError("BAD_REQUEST", `${entry.name} can't make that.`);
  const model = input.model ?? null;
  if (
    model &&
    !entry.models.some((candidate) => candidate.id === model && candidate.kind === input.kind) &&
    !entry.customModels
  ) {
    throw new ClientError("BAD_REQUEST", `${entry.name} has no model "${model}".`);
  }
  await deps.prisma.userMediaPreference.upsert({
    where: { userId_kind: { userId: actor.userId, kind: input.kind } },
    create: { userId: actor.userId, kind: input.kind, provider: input.provider, model },
    update: { provider: input.provider, model },
  });
  return readMediaPreference(deps.prisma, actor.userId);
}
