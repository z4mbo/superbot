import type { MediaProviderDefinition } from "./media-provider-descriptor.js";
import { scriptedMedia } from "./scripted-media-provider.js";

/**
 * Every media provider this build has, by id. The router, the catalog and the tool list read
 * from here, and this order is the default precedence among the providers a person connected.
 * Adding a provider is one import and one line; nothing else names it.
 */
export const mediaProviders = {
  scripted: scriptedMedia,
} satisfies Record<string, MediaProviderDefinition>;

export type MediaProviderRegistry = Readonly<Record<string, MediaProviderDefinition>>;

/** A registered provider this server offers, or undefined. Outside adapters an id is opaque. */
export function knownMediaProvider(
  id: string,
  registry: MediaProviderRegistry = mediaProviders,
): MediaProviderDefinition | undefined {
  if (!Object.hasOwn(registry, id)) return undefined;
  const definition = registry[id];
  return definition && (definition.available?.() ?? true) ? definition : undefined;
}

/** The registered providers this server offers, in precedence order. */
export function offeredMediaProviders(
  registry: MediaProviderRegistry = mediaProviders,
): Array<[string, MediaProviderDefinition]> {
  return Object.keys(registry).flatMap((id) => {
    const definition = knownMediaProvider(id, registry);
    return definition ? [[id, definition] as [string, MediaProviderDefinition]] : [];
  });
}
