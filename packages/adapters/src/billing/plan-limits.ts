import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PlanLimits, PlanLimitWindow, ProviderUsageStatus } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  modelProviderAllowed,
  modelProviderAllowlist,
} from "../models/model-provider-allowlist.js";
import type { StoredModelSecret } from "../models/model-secret.js";
import { parseModelSecret } from "../models/model-secret.js";
import type { UsageReading } from "./usage-readers.js";
import {
  keyUsageReader,
  oauthUsageReader,
  PLAN_LIMIT_PROVIDERS,
  UsageHttpError,
} from "./usage-readers.js";

export {
  PLAN_LIMIT_PROVIDERS,
  parseChatGptPlanLimits,
  parseClaudePlanLimits,
} from "./usage-readers.js";

/** A fresh reading is reused this long, and a failure is not retried sooner. */
const FRESH_MS = 60_000;
const FAILURE_RETRY_MS = 15_000;
/** Asking again on demand still waits this long after the last attempt. */
const REFRESH_FLOOR_MS = 10_000;
/** Older readings are dropped rather than shown as current. */
const STALE_MS = 30 * 60_000;
const MAX_ENTRIES = 512;

/** A connection's usable secret, in the form a usage read takes it. */
export type UsageSecret =
  | { kind: "oauth"; credential: OAuthCredential }
  | { kind: "api_key"; key: string };

type Entry = {
  /** The last good reading, kept through later failures until it is stale. */
  reading: UsageReading | null;
  readAt: number | null;
  attemptAt: number;
  retryAt: number;
  /** Why the latest attempt failed; null when it succeeded. */
  failure: "error" | "not_signed_in" | null;
};

/** What a connection's row shows; `reading` is set when the provider's last answer still counts. */
export type UsageOutcome = {
  status: ProviderUsageStatus;
  reading: UsageReading | null;
  readAt: number | null;
};

/**
 * Reads what providers report about the member's own connections. Readings are cached per
 * connection so opening a menu never fans out to providers, and a failed read keeps showing the
 * last good one for a while instead of nothing. Subscription allowances and the full usage roster
 * share one cache, so a connection is never read twice for the two.
 */
export class PlanLimitsReader {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** A subscription's allowances; null when it has none or none could be read lately. */
  async read(
    key: string,
    provider: string,
    credential: OAuthCredential | null,
  ): Promise<PlanLimitWindow[] | null> {
    if (!PLAN_LIMIT_PROVIDERS.includes(provider)) return null;
    const entry = await this.settle(
      key,
      provider,
      credential ? { kind: "oauth", credential } : null,
      false,
    );
    // Allowances for one model family stay out: this list keys its rows by period.
    const windows =
      (entry && this.current(entry, this.now()))?.windows.filter((window) => !window.model) ?? [];
    return windows.length ? windows : null;
  }

  /** A connection's usage, asking the provider again on `refresh` unless it was just asked. */
  async usage(
    key: string,
    provider: string,
    secret: UsageSecret,
    options: { refresh?: boolean } = {},
  ): Promise<UsageOutcome> {
    if (!this.source(provider, secret))
      return { status: "unavailable", reading: null, readAt: null };
    const entry = await this.settle(key, provider, secret, options.refresh === true);
    // Nothing read yet, e.g. an expired sign-in whose refresh is still running.
    if (!entry) return { status: "error", reading: null, readAt: null };
    const readAt = entry.readAt;
    if (entry.failure === "not_signed_in")
      return { status: "not_signed_in", reading: null, readAt };
    const reading = this.current(entry, this.now());
    if (!reading) return { status: "error", reading: null, readAt };
    const reported = reading.windows.length > 0 || reading.credits !== null;
    return { status: reported ? "ok" : "no_data", reading, readAt };
  }

  private source(provider: string, secret: UsageSecret): (() => Promise<UsageReading>) | null {
    if (secret.kind === "oauth") {
      const reader = oauthUsageReader(provider);
      return reader ? () => reader.read(secret.credential, this.fetchImpl) : null;
    }
    const reader = keyUsageReader(provider);
    return reader ? () => reader(secret.key, this.fetchImpl) : null;
  }

  /** The entry once any read this call should make has finished; null when none ever was. */
  private async settle(
    key: string,
    provider: string,
    secret: UsageSecret | null,
    refresh: boolean,
  ): Promise<Entry | null> {
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const now = this.now();
    const cached = this.cache.get(key) ?? null;
    // An expired token reads nothing; the caller has a refresh started.
    if (!secret || (secret.kind === "oauth" && secret.credential.expires <= now)) return cached;
    const read = this.source(provider, secret);
    if (!read) return cached;
    const due = !cached || cached.retryAt <= now;
    if (!due && !(refresh && now - cached.attemptAt >= REFRESH_FLOOR_MS)) return cached;
    const task = read()
      .then(
        (reading): Entry => ({
          reading,
          readAt: this.now(),
          attemptAt: now,
          retryAt: this.now() + FRESH_MS,
          failure: null,
        }),
        (error: unknown): Entry => {
          // Provider errors can carry account details; keep only the last good reading.
          const previous = this.cache.get(key);
          return {
            reading: previous?.reading ?? null,
            readAt: previous?.readAt ?? null,
            attemptAt: now,
            retryAt: this.now() + FAILURE_RETRY_MS,
            failure: error instanceof UsageHttpError && error.rejected ? "not_signed_in" : "error",
          };
        },
      )
      .then((entry) => {
        this.store(key, entry);
        return entry;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private current(entry: Entry, now: number): UsageReading | null {
    return entry.reading && entry.readAt !== null && now - entry.readAt < STALE_MS
      ? entry.reading
      : null;
  }

  private store(key: string, entry: Entry) {
    this.cache.delete(key);
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, entry);
  }
}

export const planLimitsReader = new PlanLimitsReader();

export type MemberCredentialRow = { id: string; provider: string; label: string; secretId: string };

/**
 * The member's model connections to allowed providers, oldest first, each with its stored secret,
 * or null where the secret is missing or cannot be read.
 */
export async function loadMemberModelSecrets(
  prisma: Pick<PrismaClient, "userModelCredential" | "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  providers?: readonly string[],
): Promise<{ row: MemberCredentialRow; secret: StoredModelSecret | null }[]> {
  const allowlist = modelProviderAllowlist();
  const rows = (
    await prisma.userModelCredential.findMany({
      where: {
        userId,
        ...(providers
          ? {
              provider: {
                in: providers.filter((provider) => modelProviderAllowed(allowlist, provider)),
              },
            }
          : {}),
      },
      select: { id: true, provider: true, label: true, secretId: true },
      orderBy: { createdAt: "asc" },
    })
  ).filter((row) => modelProviderAllowed(allowlist, row.provider));
  if (!rows.length) return [];
  const secrets = await prisma.secret.findMany({
    where: { id: { in: rows.map((row) => row.secretId) }, userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  const ciphertexts = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  return Promise.all(
    rows.map(async (row) => {
      const ciphertext = ciphertexts.get(row.secretId);
      if (!ciphertext) return { row, secret: null };
      try {
        return { row, secret: parseModelSecret(await secretStore.load(ciphertext, row.secretId)) };
      } catch {
        return { row, secret: null };
      }
    }),
  );
}

/** Allowances for each of the member's subscription sign-ins that can report one. */
export async function readMemberPlanLimits(
  prisma: Pick<PrismaClient, "userModelCredential" | "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  reader: PlanLimitsReader,
  onExpiredToken: (secretId: string, provider: string) => void,
): Promise<PlanLimits[]> {
  const connections = await loadMemberModelSecrets(
    prisma,
    secretStore,
    userId,
    PLAN_LIMIT_PROVIDERS,
  );
  const plans = await Promise.all(
    connections.map(async ({ row, secret }) => {
      // An API key has no subscription allowance to read.
      if (secret?.kind !== "oauth" || secret.reconnectRequired) return null;
      const credential = secret.credential;
      if (credential.expires <= Date.now()) onExpiredToken(row.secretId, row.provider);
      // A new sign-in gets a new secret, so its readings never mix with the old account's.
      const windows = await reader.read(`${userId}:${row.secretId}`, row.provider, credential);
      if (!windows) return null;
      const name = oauthUsageReader(row.provider)?.name ?? row.label;
      return { credentialId: row.id, name, label: row.label, windows };
    }),
  );
  return plans.filter((plan) => plan !== null);
}
