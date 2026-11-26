import type { MediaGenerationProvider, SecretStore } from "@rakazo/adapter-kit";
import type {
  MediaCapabilities,
  MediaKind,
  MediaModelInfo,
  MediaPreference,
  MediaProviderEntry,
} from "@rakazo/contracts";
import { canonicalPiProviderId } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { readJsonColumn } from "@rakazo/db";
import { z } from "zod";
import { borrowMediaModelConnection } from "./media-model-connection.js";
import type {
  MediaModelConnectionSource,
  MediaModelDescriptor,
  MediaProviderCredential,
  MediaProviderDefinition,
  MediaProviderOptions,
} from "./media-provider-descriptor.js";
import type { MediaProviderRegistry } from "./media-providers.js";
import { mediaProviders, offeredMediaProviders } from "./media-providers.js";

/** What one call asks for. An edit is an image job that changes a source image. */
export type MediaJob = "image" | "image_edit" | "video";

/** The provider id a job made by the server's own media setup is saved under. */
export const SERVER_MEDIA_PROVIDER = "server";
const SERVER_MEDIA_NAME = "Server default";

/**
 * Where a call went, saved with a video job so the background check builds the same provider
 * again. It names the credential, never its secret.
 */
export const MediaRouteSchema = z.object({
  provider: z.string(),
  providerName: z.string(),
  source: z.enum(["key", "model_connection", "server"]),
  /** The user's saved key, for `key`. */
  credentialId: z.string().optional(),
  /** The model provider whose connection is borrowed, for `model_connection`. */
  modelConnection: z.string().optional(),
  model: z.string().optional(),
});
export type MediaRoute = z.infer<typeof MediaRouteSchema>;

/** The route of a job made by the server's own provider, and of jobs saved before routes. */
export const SERVER_MEDIA_ROUTE: MediaRoute = {
  provider: SERVER_MEDIA_PROVIDER,
  providerName: SERVER_MEDIA_NAME,
  source: "server",
};

export interface MediaRouterDeps {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load" | "put" | "delete" | "isRemote">;
  /** The server's own provider, used only for a kind the person connected nothing for. */
  serverDefault?: MediaGenerationProvider;
  registry?: MediaProviderRegistry;
  providerOptions?: MediaProviderOptions;
}

type Scope = { userId: string; spaceId: string };

/** A failure the person can act on, such as a removed key: its message goes back to the model. */
export class MediaConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaConnectionError";
  }
}

/** The sealed value of a saved key: every field the provider's form has, by name. */
const storedKeySchema = z.object({
  kind: z.literal("media_key"),
  fields: z.record(z.string(), z.string()),
});
export function serializeMediaKey(fields: Record<string, string>): string {
  return JSON.stringify({ kind: "media_key", fields });
}
export function parseMediaKey(plaintext: string): Record<string, string> {
  const parsed = storedKeySchema.safeParse(JSON.parse(plaintext));
  if (!parsed.success)
    throw new MediaConnectionError("The saved key is unreadable. Save it again.");
  return parsed.data.fields;
}
const hintsSchema = z.record(z.string(), z.string());

type Connection =
  | { source: "key"; credentialId: string; secretId: string; hints: Record<string, string> }
  | { source: "model_connection"; connection: MediaModelConnectionSource };

function jobKind(job: MediaJob): MediaKind {
  return job === "video" ? "video" : "image";
}

function modelDoes(model: Pick<MediaModelDescriptor, "kind" | "edit">, job: MediaJob): boolean {
  return model.kind === jobKind(job) && (job !== "image_edit" || Boolean(model.edit));
}

export function mediaCapabilities(models: readonly MediaModelDescriptor[]): MediaCapabilities {
  return {
    image: models.some((model) => modelDoes(model, "image")),
    imageEdit: models.some((model) => modelDoes(model, "image_edit")),
    video: models.some((model) => modelDoes(model, "video")),
  };
}

export function serverMediaCapabilities(
  provider: MediaGenerationProvider | undefined,
): MediaCapabilities | null {
  if (!provider) return null;
  const capabilities = {
    image: provider.capabilities.images,
    imageEdit: Boolean(provider.capabilities.imageEdit && provider.editImage),
    video: provider.capabilities.video,
  };
  return capabilities.image || capabilities.imageEdit || capabilities.video ? capabilities : null;
}

/**
 * A credential standing in for one only the listing sees: the non-secret values of a key, or
 * the borrowed connection without its token. `modelsFor` reads which models a credential
 * reaches, never its secret, so the listing and the call agree.
 */
function listingCredential(connection: Connection): MediaProviderCredential {
  return connection.source === "key"
    ? { kind: "key", fields: connection.hints }
    : { kind: "model_connection", ...connection.connection, token: "" };
}

function modelsForConnection(
  definition: MediaProviderDefinition,
  credential: MediaProviderCredential,
): readonly MediaModelDescriptor[] {
  return definition.modelsFor?.(credential) ?? definition.models;
}

/** The person's saved keys and the model connections each provider can borrow, by provider id. */
async function userConnections(
  deps: MediaRouterDeps,
  scope: Scope,
  registry: MediaProviderRegistry,
): Promise<Map<string, Connection>> {
  const [keys, modelCredentials] = await Promise.all([
    deps.prisma.userMediaCredential.findMany({ where: { userId: scope.userId } }),
    deps.prisma.userModelCredential.findMany({
      where: { userId: scope.userId },
      select: { provider: true },
    }),
  ]);
  const modelProviders = new Set(
    modelCredentials.map((row) => canonicalPiProviderId(row.provider)),
  );
  const connections = new Map<string, Connection>();
  for (const [id, definition] of offeredMediaProviders(registry)) {
    const key = keys.find((row) => row.provider === id);
    if (key) {
      connections.set(id, {
        source: "key",
        credentialId: key.id,
        secretId: key.secretId,
        hints: readJsonColumn(
          hintsSchema,
          key.hints,
          { table: "user_media_credentials", column: "hints", id: key.id },
          { fallback: {} },
        ),
      });
      continue;
    }
    // A model connection is borrowed without asking, as signing in to the provider is consent
    // to use it; each call still checks the allowlist, retention and sign-in when it borrows.
    const borrowed = definition.modelConnections?.find((source) =>
      modelProviders.has(canonicalPiProviderId(source.provider)),
    );
    if (borrowed) connections.set(id, { source: "model_connection", connection: borrowed });
  }
  return connections;
}

const preferenceKinds = new Set<string>(["image", "video"]);

export async function readMediaPreference(
  prisma: Pick<PrismaClient, "userMediaPreference">,
  userId: string,
): Promise<MediaPreference> {
  const rows = await prisma.userMediaPreference.findMany({ where: { userId } });
  const preference: MediaPreference = { image: null, video: null };
  for (const row of rows) {
    if (!preferenceKinds.has(row.kind)) continue;
    preference[row.kind as MediaKind] = { provider: row.provider, model: row.model };
  }
  return preference;
}

function modelInfo(model: MediaModelDescriptor): MediaModelInfo {
  return {
    ...model,
    aspectRatios: model.aspectRatios ? [...model.aspectRatios] : undefined,
    resolutions: model.resolutions ? [...model.resolutions] : undefined,
    sizes: model.sizes ? [...model.sizes] : undefined,
    qualities: model.qualities ? [...model.qualities] : undefined,
  };
}

export type MediaAvailability = {
  providers: MediaProviderEntry[];
  preference: MediaPreference;
  server: MediaCapabilities | null;
};

/**
 * Every provider this server offers, as it stands for one person: connected or not, from what,
 * and what its models do for that connection. Nothing is offered as usable that is not.
 */
export async function listMediaProviders(
  deps: MediaRouterDeps,
  scope: Scope,
): Promise<MediaAvailability> {
  const registry: MediaProviderRegistry = deps.registry ?? mediaProviders;
  const [connections, preference] = await Promise.all([
    userConnections(deps, scope, registry),
    readMediaPreference(deps.prisma, scope.userId),
  ]);
  const providers = offeredMediaProviders(registry).map(([id, definition]) => {
    const connection = connections.get(id);
    const models = connection
      ? modelsForConnection(definition, listingCredential(connection))
      : definition.models;
    const capabilities = mediaCapabilities(models);
    return {
      id,
      name: definition.catalog.name,
      fields: definition.catalog.fields.map((field) => ({ ...field })),
      modelConnections: (definition.modelConnections ?? []).map((source) => source.provider),
      connected: Boolean(connection),
      source: connection?.source ?? null,
      hints: connection?.source === "key" ? connection.hints : {},
      // A provider not connected does nothing for this person.
      capabilities: connection ? capabilities : { image: false, imageEdit: false, video: false },
      models: models.map(modelInfo),
      customModels: Boolean(definition.customModels),
    } satisfies MediaProviderEntry;
  });
  return { providers, preference, server: serverMediaCapabilities(deps.serverDefault) };
}

/** What a run may offer: a capability counts when a connected provider or the server has it. */
export function availableMediaCapabilities(availability: MediaAvailability): MediaCapabilities {
  const connected = availability.providers.filter((provider) => provider.connected);
  const any = (key: keyof MediaCapabilities) =>
    connected.some((provider) => provider.capabilities[key]) || Boolean(availability.server?.[key]);
  return { image: any("image"), imageEdit: any("imageEdit"), video: any("video") };
}

const jobCapability: Record<MediaJob, keyof MediaCapabilities> = {
  image: "image",
  image_edit: "imageEdit",
  video: "video",
};

/** One line per connected provider that can do the job, naming the models a call may pass. */
export function describeMediaChoices(availability: MediaAvailability, job: MediaJob): string {
  const lines = availability.providers
    .filter((provider) => provider.connected && provider.capabilities[jobCapability[job]])
    .map((provider) => {
      const models = provider.models
        .filter((model) => modelDoes(model, job))
        .map((model) => (model.default ? `${model.id} (default)` : model.id));
      return `${provider.id} (${provider.name}): ${models.join(", ")}`;
    });
  if (!lines.length && availability.server?.[jobCapability[job]]) {
    return "The server's default provider; no provider or model can be chosen.";
  }
  return lines.join("; ");
}

export type ResolvedMedia = {
  provider: MediaGenerationProvider;
  route: MediaRoute;
  /** The chosen model's descriptor; absent for the server default or an unlisted model. */
  model?: MediaModelDescriptor;
};

function pickModel(
  models: readonly MediaModelDescriptor[],
  job: MediaJob,
  requested: string | undefined,
  customModels: boolean,
): { model?: MediaModelDescriptor; id?: string } | null {
  const able = models.filter((model) => modelDoes(model, job));
  if (requested) {
    const listed = able.find((model) => model.id === requested);
    if (listed) return { model: listed, id: listed.id };
    // A listed model that cannot do this job is refused even where custom ids are taken.
    if (models.some((model) => model.id === requested) || !customModels || !able.length) {
      return null;
    }
    return { id: requested };
  }
  const chosen = able.find((model) => model.default) ?? able[0];
  return chosen ? { model: chosen, id: chosen.id } : null;
}

const JOB_WORDS: Record<MediaJob, string> = {
  image: "make images",
  image_edit: "edit images",
  video: "make videos",
};

/**
 * Picks the provider and model for one call: the call's own choice, then the person's saved
 * preference, then the first connected provider in registry order that can do the job, then
 * the server's default. A provider the person did not connect is never called, and a choice
 * that is not available is refused with what is.
 */
export async function resolveMediaRoute(
  deps: MediaRouterDeps,
  scope: Scope,
  request: { job: MediaJob; provider?: string; model?: string },
  signal?: AbortSignal,
): Promise<ResolvedMedia> {
  const registry: MediaProviderRegistry = deps.registry ?? mediaProviders;
  const availability = await listMediaProviders(deps, scope);
  const capability = jobCapability[request.job];
  const able = availability.providers.filter(
    (provider) => provider.connected && provider.capabilities[capability],
  );
  const choices = describeMediaChoices(availability, request.job);
  const refuse = (what: string) =>
    new MediaConnectionError(
      choices
        ? `${what} Available: ${choices}.`
        : `${what} No connected provider can ${JOB_WORDS[request.job]}.`,
    );
  const server = deps.serverDefault;
  const serverCan = Boolean(availability.server?.[capability]);

  let chosen: MediaProviderEntry | undefined;
  let requestedModel = request.model?.trim() || undefined;
  if (request.provider) {
    chosen = able.find((provider) => provider.id === request.provider);
    if (!chosen) {
      const named = availability.providers.find((provider) => provider.id === request.provider);
      throw refuse(
        !named
          ? `There is no media provider "${request.provider}".`
          : named.connected
            ? `${named.name} can't ${JOB_WORDS[request.job]}.`
            : `${named.name} is not connected.`,
      );
    }
  } else if (requestedModel) {
    chosen = able.find((provider) => provider.models.some((model) => model.id === requestedModel));
    if (!chosen) throw refuse(`Model "${requestedModel}" is not available.`);
  } else {
    const preferred = availability.preference[jobKind(request.job)];
    chosen = preferred ? able.find((provider) => provider.id === preferred.provider) : undefined;
    if (chosen && preferred?.model) {
      const preferredModel = preferred.model;
      // A saved model that cannot do this job (an edit) leaves the provider's own choice.
      const listed = chosen.models.find((model) => model.id === preferredModel);
      if ((listed && modelDoes(listed, request.job)) || (!listed && chosen.customModels)) {
        requestedModel = preferredModel;
      }
    }
    chosen ??= able[0];
  }

  if (!chosen) {
    if (server && serverCan) {
      return { provider: server, route: SERVER_MEDIA_ROUTE };
    }
    throw new MediaConnectionError("Media generation is unavailable.");
  }
  const definition = registry[chosen.id];
  if (!definition) throw new MediaConnectionError("Media generation is unavailable.");
  const connection = (await userConnections(deps, scope, registry)).get(chosen.id);
  if (!connection) throw refuse(`${chosen.name} is not connected.`);
  const credential = await loadMediaCredential(deps, scope, chosen.name, connection, signal);
  const picked = pickModel(
    modelsForConnection(definition, credential),
    request.job,
    requestedModel,
    Boolean(definition.customModels),
  );
  if (!picked)
    throw refuse(
      `${chosen.name} has no model "${requestedModel}" that can ${JOB_WORDS[request.job]}.`,
    );
  return {
    provider: definition.create(credential, deps.providerOptions ?? {}),
    route: {
      provider: chosen.id,
      providerName: chosen.name,
      source: connection.source,
      ...(connection.source === "key"
        ? { credentialId: connection.credentialId }
        : { modelConnection: connection.connection.provider }),
      ...(picked.id ? { model: picked.id } : {}),
    },
    ...(picked.model ? { model: picked.model } : {}),
  };
}

async function loadMediaCredential(
  deps: MediaRouterDeps,
  scope: Scope,
  name: string,
  connection: Connection,
  signal?: AbortSignal,
): Promise<MediaProviderCredential> {
  if (connection.source === "model_connection") {
    return borrowMediaModelConnection(deps, scope, connection.connection, name, signal);
  }
  const row = await deps.prisma.secret.findFirst({
    where: { id: connection.secretId, userId: scope.userId, spaceId: null },
  });
  if (!row) throw new MediaConnectionError(`The ${name} key was removed. Connect it again.`);
  const fields = parseMediaKey(await deps.secretStore.load(row.ciphertext, row.id));
  return { kind: "key", fields };
}

/**
 * The provider a saved job was submitted to, built again from the same credential, for the
 * background check. A credential removed since is a MediaConnectionError: the job fails.
 */
export async function reopenMediaRoute(
  deps: MediaRouterDeps,
  scope: Scope,
  route: MediaRoute,
  signal?: AbortSignal,
): Promise<MediaGenerationProvider> {
  if (route.source === "server") {
    if (!deps.serverDefault) throw new MediaConnectionError("Media generation is unavailable.");
    return deps.serverDefault;
  }
  const registry: MediaProviderRegistry = deps.registry ?? mediaProviders;
  const definition = registry[route.provider];
  const name = definition?.catalog.name ?? route.providerName;
  const gone = new MediaConnectionError(`The ${name} connection was removed.`);
  if (!definition || (definition.available?.() ?? true) === false) throw gone;
  let connection: Connection;
  if (route.source === "key") {
    const row = route.credentialId
      ? await deps.prisma.userMediaCredential.findFirst({
          where: { id: route.credentialId, userId: scope.userId, provider: route.provider },
        })
      : null;
    if (!row) throw gone;
    connection = { source: "key", credentialId: row.id, secretId: row.secretId, hints: {} };
  } else {
    const source = definition.modelConnections?.find(
      (entry) => entry.provider === route.modelConnection,
    );
    if (!source) throw gone;
    connection = { source: "model_connection", connection: source };
  }
  const credential = await loadMediaCredential(deps, scope, name, connection, signal);
  return definition.create(credential, deps.providerOptions ?? {});
}
