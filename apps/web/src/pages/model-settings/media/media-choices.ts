import type {
  MediaCapabilities,
  MediaCatalog,
  MediaKind,
  MediaProviderEntry,
} from "@rakazo/contracts";

/** The chooser's value for no saved choice: the first connected provider, or the server's. */
export const AUTOMATIC_MEDIA = "automatic";

/** One chooser option's value: a provider and one of its models, or a provider alone. */
export function mediaChoiceValue(provider: string, model: string | null): string {
  return JSON.stringify([provider, model]);
}

export function parseMediaChoice(value: string): { provider: string; model: string | null } | null {
  if (value === AUTOMATIC_MEDIA) return null;
  const [provider, model] = JSON.parse(value) as [string, string | null];
  return { provider, model };
}

function makes(entry: MediaProviderEntry, kind: MediaKind): boolean {
  return kind === "video" ? entry.capabilities.video : entry.capabilities.image;
}

/** Whether anything can make this kind: a connected provider or the server's own setup. */
export function mediaKindAvailable(catalog: MediaCatalog, kind: MediaKind): boolean {
  const server = kind === "video" ? catalog.server?.video : catalog.server?.image;
  return (
    Boolean(server) || catalog.providers.some((entry) => entry.connected && makes(entry, kind))
  );
}

export type MediaChoiceOption = {
  value: string;
  provider: string | null;
  model: string | null;
  /** Why it cannot be chosen; absent when it can. */
  unavailable?: "not_connected" | "cannot_make";
  providerName: string;
  modelName: string | null;
};

/**
 * Every choice for one kind: Automatic, each model of every connected provider that makes it,
 * then the providers that cannot be chosen and why. A provider that is not connected is listed
 * only when connecting it would let it make this kind.
 */
export function mediaChoiceOptions(catalog: MediaCatalog, kind: MediaKind): MediaChoiceOption[] {
  const available: MediaChoiceOption[] = [];
  const unavailable: MediaChoiceOption[] = [];
  const saved = catalog.preference[kind];
  for (const entry of catalog.providers) {
    const models = entry.models.filter((model) => model.kind === kind);
    if (entry.connected && makes(entry, kind)) {
      for (const model of models) {
        available.push({
          value: mediaChoiceValue(entry.id, model.id),
          provider: entry.id,
          model: model.id,
          providerName: entry.name,
          modelName: model.name,
        });
      }
      // A model id beyond the listed ones, saved where the provider takes them.
      if (
        saved?.provider === entry.id &&
        saved.model &&
        !models.some((model) => model.id === saved.model)
      ) {
        available.push({
          value: mediaChoiceValue(entry.id, saved.model),
          provider: entry.id,
          model: saved.model,
          providerName: entry.name,
          modelName: saved.model,
        });
      }
    } else if (entry.connected) {
      unavailable.push({
        value: mediaChoiceValue(entry.id, null),
        provider: entry.id,
        model: null,
        unavailable: "cannot_make",
        providerName: entry.name,
        modelName: null,
      });
    } else if (models.length) {
      unavailable.push({
        value: mediaChoiceValue(entry.id, null),
        provider: entry.id,
        model: null,
        unavailable: "not_connected",
        providerName: entry.name,
        modelName: null,
      });
    }
  }
  return [
    {
      value: AUTOMATIC_MEDIA,
      provider: null,
      model: null,
      providerName: "",
      modelName: null,
    },
    ...available,
    ...unavailable,
  ];
}

/** The option the saved choice stands for; a choice that no longer works shows as unavailable. */
export function selectedMediaChoice(catalog: MediaCatalog, kind: MediaKind): string {
  const saved = catalog.preference[kind];
  if (!saved) return AUTOMATIC_MEDIA;
  const options = mediaChoiceOptions(catalog, kind);
  const entry = catalog.providers.find((candidate) => candidate.id === saved.provider);
  const model =
    saved.model ??
    entry?.models.find((candidate) => candidate.kind === kind && candidate.default)?.id ??
    entry?.models.find((candidate) => candidate.kind === kind)?.id ??
    null;
  const exact = options.find(
    (option) => option.provider === saved.provider && option.model === model && !option.unavailable,
  );
  if (exact) return exact.value;
  return (
    options.find((option) => option.provider === saved.provider)?.value ??
    // A provider this server no longer offers: nothing to show but the automatic choice.
    AUTOMATIC_MEDIA
  );
}

/**
 * What a model connection of this provider lets its media provider make, read from the catalog:
 * a media provider connected through that model connection. Null when it lends nothing.
 */
export function mediaIncludedWith(
  catalog: MediaCatalog | undefined,
  modelProvider: string,
): MediaCapabilities | null {
  const lent = catalog?.providers.filter(
    (entry) =>
      entry.source === "model_connection" &&
      entry.connected &&
      entry.modelConnections.includes(modelProvider),
  );
  if (!lent?.length) return null;
  const capabilities = {
    image: lent.some((entry) => entry.capabilities.image),
    imageEdit: lent.some((entry) => entry.capabilities.imageEdit),
    video: lent.some((entry) => entry.capabilities.video),
  };
  return capabilities.image || capabilities.video ? capabilities : null;
}
