import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { findModelCredential } from "@rakazo/db";
import {
  resolveStoredModelAuth,
  withModelCredentialLock,
} from "../models/model-credential-refresh.js";
import {
  MODEL_PROVIDER_NOT_ALLOWED_ERROR,
  modelProviderAllowed,
  modelProviderAllowlist,
} from "../models/model-provider-allowlist.js";
import {
  isRetiredModelCredentialError,
  oauthCredentialAccountId,
} from "../runtime/pi/models/pi-oauth.js";
import type {
  MediaModelConnectionSource,
  MediaProviderCredential,
} from "./media-provider-descriptor.js";
import { MediaConnectionError } from "./media-router.js";

/**
 * A current credential from the person's model connection, for a media provider that borrows
 * it: refreshed and retired under the same lock a model run uses, as voice borrows one. Nothing
 * is saved for media; each call reads the model connection, so a reconnect there carries over.
 */
export async function borrowMediaModelConnection(
  deps: {
    prisma: PrismaClient;
    secretStore: Pick<SecretStore, "load" | "put" | "delete" | "isRemote">;
  },
  scope: { userId: string; spaceId: string },
  source: MediaModelConnectionSource,
  name: string,
  signal?: AbortSignal,
): Promise<MediaProviderCredential> {
  // A model connection the deployment's allowlist refuses is not borrowed for media either.
  if (!modelProviderAllowed(modelProviderAllowlist(), source.provider)) {
    throw new MediaConnectionError(MODEL_PROVIDER_NOT_ALLOWED_ERROR);
  }
  const missing = () => new MediaConnectionError(`Connect ${name} in Models settings.`);
  const credential = await findModelCredential(
    deps.prisma,
    { userId: scope.userId },
    source.provider,
  );
  if (!credential) throw missing();
  return withModelCredentialLock(credential.secretId, async () => {
    const row = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    });
    if (!row) throw missing();
    const stored = await deps.secretStore.load(row.ciphertext, row.id);
    try {
      const { secret, apiKey } = await resolveStoredModelAuth(
        deps.prisma,
        deps.secretStore,
        scope,
        credential,
        stored,
        source.provider,
        { signal },
      );
      if (!apiKey) throw missing();
      // Media requests carry no retention routing, so a protected connection is never borrowed.
      if (secret.kind === "api_key" && secret.zeroDataRetention) {
        throw new MediaConnectionError(
          "This model connection keeps zero data retention, which media generation can't enforce. Add a separate key.",
        );
      }
      const auth = secret.kind === "oauth" ? "oauth" : "api_key";
      // A sign-in and a key reach different endpoints; only the kind the provider takes is used.
      if (auth !== source.auth) throw missing();
      const accountId =
        secret.kind === "oauth"
          ? oauthCredentialAccountId(secret.credential)
          : secret.kind === "api_key"
            ? secret.accountId
            : undefined;
      return {
        kind: "model_connection",
        provider: source.provider,
        auth,
        token: apiKey,
        ...(accountId ? { accountId } : {}),
        ...(secret.kind === "openai_compatible" ? { baseUrl: secret.baseUrl } : {}),
      };
    } catch (error) {
      if (isRetiredModelCredentialError(error)) throw missing();
      throw error;
    }
  });
}
