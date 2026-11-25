import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AdapterContext,
  SecretStore,
  SignInSourceCredential,
  SignInSourceProvider,
} from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError, SignInSourceDisconnected } from "@rakazo/adapter-kit";
import type { SignInSourceState } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient, SignInSource } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { advisoryLock } from "../locks/advisory-lock.js";
import { withRefreshLock } from "../locks/refresh-lock.js";
import { recordSignInEvent } from "./sign-in-source-activity.js";

export interface SignInSourceDeps {
  prisma: PrismaClient;
  secretStore: SecretStore;
  signInSource: SignInSourceProvider | null | undefined;
  /** The web app's public origin: the provider sends the person back to a page on it. */
  webOrigin?: string;
}

export type SignInActor = { userId: string; spaceId: string };

/** The web page the provider redirects to after the person approves the connection. */
export const SIGN_IN_SOURCE_CALLBACK_PATH = "/sign-in-source/callback";
/** The `secrets` row kind that holds a connection's sealed material. */
export const SIGN_IN_SOURCE_SECRET_KIND = "sign_in_source";

const PROVIDER_TIMEOUT_MS = 30_000;
/** Refresh a little before the provider asks, to cover clock skew and request time. */
const REFRESH_SKEW_MS = 60_000;

/** A connect in progress (with the connection it replaces), or the connection itself. */
type Material = { pending: string; state: string; previous?: string } | { secret: string };

/** No sign-in source is configured, or the server cannot connect to it yet. */
export class SignInSourceUnavailableError extends ClientError {
  constructor(message = "Signing in with a password manager is not available on this server yet.") {
    super("BAD_REQUEST", message, "SIGN_IN_SOURCE_UNAVAILABLE");
    this.name = "SignInSourceUnavailableError";
  }
}

/** The redirect does not belong to the person's connect in progress. */
export class SignInSourceConnectError extends ClientError {
  constructor(message = "This sign-in link has expired. Connect again.") {
    super("CONFLICT", message, "SIGN_IN_SOURCE_CONNECT_STALE");
    this.name = "SignInSourceConnectError";
  }
}

/** The provider would not revoke the connection, so it is kept, as the provider asks. */
export class SignInSourceRevokeError extends ClientError {
  constructor() {
    super("CONFLICT", "Couldn't disconnect right now. Try again.", "SIGN_IN_SOURCE_REVOKE_FAILED");
    this.name = "SignInSourceRevokeError";
  }
}

export function providerContext(actor: SignInActor, operation: string): AdapterContext {
  return {
    operationId: `sign-in-source.${operation}`,
    traceId: `sign-in-source.${operation}`,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  };
}

/** Error names only: provider errors may quote tokens or response bodies. */
export function warnSignIn(message: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  getLogger().warn(`${message}: ${name}`);
}

export function signInRedirectUri(deps: Pick<SignInSourceDeps, "webOrigin">): string {
  if (!deps.webOrigin) throw new SignInSourceUnavailableError();
  return new URL(SIGN_IN_SOURCE_CALLBACK_PATH, deps.webOrigin).toString();
}

async function seal(
  deps: SignInSourceDeps,
  tx: Prisma.TransactionClient,
  actor: SignInActor,
  material: Material,
): Promise<string> {
  const stored = await deps.secretStore.put(
    JSON.stringify(material),
    providerContext(actor, "persist"),
  );
  await tx.secret.create({
    data: {
      id: stored.id,
      userId: actor.userId,
      spaceId: null,
      kind: SIGN_IN_SOURCE_SECRET_KIND,
      ciphertext: stored.ciphertext,
    },
  });
  return stored.id;
}

/** Null when the stored material is gone or unreadable; a store outage still throws. */
async function unseal(
  deps: SignInSourceDeps,
  row: Pick<SignInSource, "userId" | "secretId">,
): Promise<Material | null> {
  const secret = await deps.prisma.secret.findFirst({
    where: { id: row.secretId, userId: row.userId, kind: SIGN_IN_SOURCE_SECRET_KIND },
    select: { id: true, ciphertext: true },
  });
  if (!secret) return null;
  try {
    const value: unknown = JSON.parse(await deps.secretStore.load(secret.ciphertext, secret.id));
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.secret === "string") return { secret: record.secret };
    if (typeof record.pending === "string" && typeof record.state === "string")
      return {
        pending: record.pending,
        state: record.state,
        ...(typeof record.previous === "string" && { previous: record.previous }),
      };
    return null;
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) throw error;
    return null;
  }
}

function dropSecret(tx: Prisma.TransactionClient, userId: string, secretId: string) {
  return tx.secret.deleteMany({
    where: { id: secretId, userId, kind: SIGN_IN_SOURCE_SECRET_KIND },
  });
}

function lockSource(tx: Prisma.TransactionClient, userId: string): Promise<unknown> {
  return advisoryLock(tx, "sign-in-source", userId);
}

/** The user's connection with the configured provider; one with another provider counts as none. */
async function currentSource(
  deps: SignInSourceDeps,
  userId: string,
): Promise<SignInSource | null> {
  if (!deps.signInSource) return null;
  const row = await deps.prisma.signInSource.findUnique({ where: { userId } });
  return row && row.provider === deps.signInSource.describe().id ? row : null;
}

function stateOf(provider: SignInSourceProvider, row: SignInSource | null): SignInSourceState {
  const descriptor = provider.describe();
  const base = {
    id: descriptor.id,
    label: provider.displayName,
    connectable: descriptor.capabilities.connectable,
  };
  if (row?.status === "connected" && row.connectedAt)
    return { ...base, status: "connected", connectedAt: row.connectedAt.toISOString() };
  if (row?.status === "needs_reconnect") return { ...base, status: "needs_reconnect" };
  if (row?.status === "connecting" && row.connectExpiresAt && row.connectExpiresAt > new Date())
    return { ...base, status: "connecting" };
  return { ...base, status: "disconnected" };
}

/** The connection as Settings and the chat show it; null when the deployment offers none. */
export async function signInSourceState(
  deps: SignInSourceDeps,
  actor: SignInActor,
): Promise<SignInSourceState | null> {
  const provider = deps.signInSource;
  if (!provider) return null;
  return stateOf(provider, await currentSource(deps, actor.userId));
}

/** Whether the run's user has a working connection: needs_reconnect counts as none. */
export async function signInSourceConnected(
  deps: SignInSourceDeps,
  userId: string,
): Promise<boolean> {
  return (await currentSource(deps, userId))?.status === "connected";
}

/**
 * Starts the provider's sign-in, keeping a connection that needs reconnecting until the new one
 * replaces it: some providers send part of it only on first consent.
 */
export async function startSignInSourceConnect(
  deps: SignInSourceDeps,
  actor: SignInActor,
): Promise<{ authorizeUrl: string }> {
  const provider = deps.signInSource;
  if (!provider?.describe().capabilities.connectable) throw new SignInSourceUnavailableError();
  const start = await provider.beginConnect(
    { redirectUri: signInRedirectUri(deps) },
    providerContext(actor, "connect"),
  );
  await deps.prisma.$transaction(async (tx) => {
    await lockSource(tx, actor.userId);
    const row = await tx.signInSource.findUnique({ where: { userId: actor.userId } });
    const held = row && row.provider === provider.describe().id ? await unseal(deps, row) : null;
    const previous =
      held && "secret" in held ? held.secret : held && "previous" in held ? held.previous : undefined;
    const secretId = await seal(deps, tx, actor, {
      pending: start.pending,
      state: start.state,
      ...(previous && { previous }),
    });
    const fields = {
      provider: provider.describe().id,
      status: "connecting",
      secretId,
      refreshAt: null,
      connectExpiresAt: start.expiresAt,
      connectedAt: null,
    };
    await tx.signInSource.upsert({
      where: { userId: actor.userId },
      create: { userId: actor.userId, ...fields },
      update: fields,
    });
    if (row) await dropSecret(tx, actor.userId, row.secretId);
  });
  return { authorizeUrl: start.authorizeUrl };
}

function sameState(expected: string, received: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(received));
}

/** Finishes the connect from the redirect page; only the person who started it can. */
export async function finishSignInSourceConnect(
  deps: SignInSourceDeps,
  actor: SignInActor,
  callback: { code: string; state: string; fragment?: Readonly<Record<string, string>> },
): Promise<SignInSourceState> {
  const provider = deps.signInSource;
  if (!provider) throw new SignInSourceUnavailableError();
  const row = await currentSource(deps, actor.userId);
  if (row?.status !== "connecting" || !row.connectExpiresAt || row.connectExpiresAt <= new Date())
    throw new SignInSourceConnectError();
  const material = await unseal(deps, row);
  if (!material || !("pending" in material) || !sameState(material.state, callback.state))
    throw new SignInSourceConnectError();
  const credential = await provider.finishConnect(
    {
      pending: material.pending,
      redirectUri: signInRedirectUri(deps),
      callback,
      ...(material.previous && { previous: { secret: material.previous, refreshAt: null } }),
    },
    providerContext(actor, "finish"),
  );
  const connectedAt = new Date();
  const saved = await deps.prisma.$transaction(async (tx) => {
    await lockSource(tx, actor.userId);
    const secretId = await seal(deps, tx, actor, { secret: credential.secret });
    const { count } = await tx.signInSource.updateMany({
      where: { id: row.id, secretId: row.secretId, status: "connecting" },
      data: {
        status: "connected",
        secretId,
        refreshAt: credential.refreshAt,
        connectExpiresAt: null,
        connectedAt,
      },
    });
    // A disconnect or another connect landed meanwhile: nothing keeps this one.
    await dropSecret(tx, actor.userId, count ? row.secretId : secretId);
    return count > 0;
  });
  if (!saved) {
    try {
      await provider.disconnect(credential, providerContext(actor, "disconnect"));
    } catch (error) {
      warnSignIn("Sign-in source revoke failed", error);
    }
    throw new SignInSourceConnectError();
  }
  await recordSignInEvent({
    action: "sign_in_source.connected",
    actor: { type: "user", id: actor.userId },
    userId: actor.userId,
    provider: provider.describe().id,
  });
  return stateOf(provider, await currentSource(deps, actor.userId));
}

/**
 * Revokes the connection with the provider, then forgets it. A connection the provider still
 * holds is kept when the revoke fails, as the provider asks, so the person can try again.
 */
export async function disconnectSignInSource(
  deps: SignInSourceDeps,
  actor: SignInActor,
): Promise<SignInSourceState> {
  const provider = deps.signInSource;
  if (!provider) throw new SignInSourceUnavailableError();
  const row = await currentSource(deps, actor.userId);
  if (row?.status === "connected") {
    try {
      await withSignInCredential(deps, actor, (credential) =>
        provider.disconnect(credential, providerContext(actor, "disconnect")),
      );
    } catch (error) {
      // A connection the provider already dropped has nothing left to revoke.
      if (!(error instanceof SignInSourceDisconnected)) {
        warnSignIn("Sign-in source revoke failed", error);
        throw new SignInSourceRevokeError();
      }
    }
  }
  if (row) {
    await deps.prisma.$transaction(async (tx) => {
      await lockSource(tx, actor.userId);
      const current = await tx.signInSource.findUnique({ where: { userId: actor.userId } });
      if (!current) return;
      await tx.signInSource.delete({ where: { id: current.id } });
      await dropSecret(tx, actor.userId, current.secretId);
    });
    await recordSignInEvent({
      action: "sign_in_source.disconnected",
      actor: { type: "user", id: actor.userId },
      userId: actor.userId,
      provider: row.provider,
    });
  }
  return stateOf(provider, null);
}

type Refreshed =
  | { gone: true }
  | { dropped: SignInSource }
  | { credential: SignInSourceCredential; row: SignInSource };

function refreshDue(refreshAt: Date | null): boolean {
  return Boolean(refreshAt && refreshAt.getTime() - REFRESH_SKEW_MS <= Date.now());
}

/** The provider dropped the connection: it stays listed, asking the person to connect again. */
async function markNeedsReconnect(deps: SignInSourceDeps, row: SignInSource): Promise<void> {
  await deps.prisma.signInSource.updateMany({
    where: { id: row.id, secretId: row.secretId },
    data: { status: "needs_reconnect" },
  });
}

/**
 * Runs `fn` with the user's credential, refreshing it first under a lock when due: providers
 * rotate refresh tokens, so one another process already refreshed is adopted, never spent twice.
 * Throws SignInSourceDisconnected when there is no working connection.
 */
export async function withSignInCredential<T>(
  deps: SignInSourceDeps,
  actor: SignInActor,
  fn: (credential: SignInSourceCredential) => Promise<T>,
): Promise<T> {
  const provider = deps.signInSource;
  const row = await currentSource(deps, actor.userId);
  if (!provider || row?.status !== "connected") throw new SignInSourceDisconnected();
  let credential: SignInSourceCredential;
  let held = row;
  if (refreshDue(row.refreshAt)) {
    const refreshed = await withRefreshLock<Refreshed>(
      deps.prisma,
      (tx) => lockSource(tx, actor.userId),
      async (tx) => {
        const current = await tx.signInSource.findUnique({ where: { userId: actor.userId } });
        if (current?.status !== "connected" || current.provider !== provider.describe().id)
          return { gone: true };
        const material = await unseal(deps, current);
        if (!material || !("secret" in material)) return { dropped: current };
        const stored = { secret: material.secret, refreshAt: current.refreshAt };
        if (!refreshDue(current.refreshAt)) return { credential: stored, row: current };
        let next: SignInSourceCredential;
        try {
          next = await provider.refresh(stored, providerContext(actor, "refresh"));
        } catch (error) {
          if (error instanceof SignInSourceDisconnected) return { dropped: current };
          throw error;
        }
        const secretId = await seal(deps, tx, actor, { secret: next.secret });
        const updated = await tx.signInSource.update({
          where: { id: current.id },
          data: { secretId, refreshAt: next.refreshAt },
        });
        await dropSecret(tx, actor.userId, current.secretId);
        return { credential: next, row: updated };
      },
    );
    if ("gone" in refreshed) throw new SignInSourceDisconnected();
    if ("dropped" in refreshed) {
      await markNeedsReconnect(deps, refreshed.dropped);
      throw new SignInSourceDisconnected();
    }
    credential = refreshed.credential;
    held = refreshed.row;
  } else {
    const material = await unseal(deps, row);
    if (!material || !("secret" in material)) {
      await markNeedsReconnect(deps, row);
      throw new SignInSourceDisconnected();
    }
    credential = { secret: material.secret, refreshAt: row.refreshAt };
  }
  try {
    return await fn(credential);
  } catch (error) {
    if (error instanceof SignInSourceDisconnected) await markNeedsReconnect(deps, held);
    throw error;
  }
}
