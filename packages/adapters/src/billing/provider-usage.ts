import type { SecretStore } from "@rakazo/adapter-kit";
import type { ProviderUsage } from "@rakazo/contracts";
import { canonicalPiProviderId } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { StoredModelSecret } from "../models/model-secret.js";
import type { PiCatalogEntry } from "../runtime/pi/models/pi-models.js";
import { listPiCatalog } from "../runtime/pi/models/pi-models.js";
import type { PlanLimitsReader, UsageOutcome } from "./plan-limits.js";
import { loadMemberModelSecrets } from "./plan-limits.js";
import { oauthUsageReader } from "./usage-readers.js";

let catalogNames: { entries: readonly PiCatalogEntry[]; names: Map<string, string> } | undefined;

/** The provider's name as the model catalog shows it. */
function catalogProviderName(provider: string): string | undefined {
  const entries = listPiCatalog();
  if (catalogNames?.entries !== entries) {
    catalogNames = {
      entries,
      names: new Map(entries.map((entry) => [entry.provider, entry.providerName])),
    };
  }
  return catalogNames.names.get(canonicalPiProviderId(provider));
}

function outcomeFor(
  reader: PlanLimitsReader,
  key: string,
  provider: string,
  secret: StoredModelSecret | null,
  refresh: boolean,
  onExpiredToken: () => void,
): Promise<UsageOutcome> | UsageOutcome {
  if (!secret) return { status: "error", reading: null, readAt: null };
  if (secret.kind === "api_key")
    return reader.usage(key, provider, { kind: "api_key", key: secret.key }, { refresh });
  // A self-described endpoint has no usage API anyone documents.
  if (secret.kind !== "oauth") return { status: "unavailable", reading: null, readAt: null };
  if (secret.reconnectRequired) return { status: "not_signed_in", reading: null, readAt: null };
  const credential = secret.credential;
  if (credential.expires <= Date.now()) onExpiredToken();
  return reader.usage(key, provider, { kind: "oauth", credential }, { refresh });
}

/**
 * Every model connection the member has, oldest first, each with the usage its provider reports
 * or the reason there is none. One connection that cannot be read never hides the others.
 */
export async function readMemberProviderUsage(
  prisma: Pick<PrismaClient, "userModelCredential" | "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  reader: PlanLimitsReader,
  onExpiredToken: (secretId: string, provider: string) => void,
  options: { refresh?: boolean } = {},
): Promise<ProviderUsage[]> {
  const connections = await loadMemberModelSecrets(prisma, secretStore, userId);
  return Promise.all(
    connections.map(async ({ row, secret }): Promise<ProviderUsage> => {
      // A new sign-in gets a new secret, so its readings never mix with the old account's.
      const outcome = await outcomeFor(
        reader,
        `${userId}:${row.secretId}`,
        row.provider,
        secret,
        options.refresh === true,
        () => onExpiredToken(row.secretId, row.provider),
      );
      const subscription = secret?.kind === "oauth";
      const shown = outcome.status === "ok" ? outcome.reading : null;
      return {
        credentialId: row.id,
        provider: row.provider,
        name:
          (subscription ? oauthUsageReader(row.provider)?.name : undefined) ??
          catalogProviderName(row.provider) ??
          row.label,
        label: row.label,
        // A secret that cannot be read does not say which kind it was.
        kind: subscription ? "subscription" : "api_key",
        plan: outcome.reading?.plan ?? null,
        status: outcome.status,
        windows: shown?.windows ?? [],
        credits: shown?.credits ?? null,
        readAt: outcome.readAt === null ? null : new Date(outcome.readAt).toISOString(),
      };
    }),
  );
}
