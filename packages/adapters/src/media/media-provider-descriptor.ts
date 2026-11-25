import type { MediaGenerationProvider, MediaQuality } from "@rakazo/adapter-kit";
import type { ResolveHostname } from "../web/web-ssrf.js";

/** One model a provider offers, with only what it can really do. */
export interface MediaModelDescriptor {
  /** The provider's own model id, sent as `model` in a generation input. */
  id: string;
  name: string;
  kind: "image" | "video";
  /** The model a call uses when it names none; at most one per kind. */
  default?: boolean;
  /** Image models: changes a source image (`editImage`). */
  edit?: boolean;
  /** Image models that edit: takes a mask. */
  mask?: boolean;
  /** How many reference images one generation takes. Absent or 0 means none. */
  referenceImages?: number;
  /** Video models: starts from a first frame. */
  startFrame?: boolean;
  /** Video models: ends on a last frame. */
  endFrame?: boolean;
  /** Video models: can make sound. */
  audio?: boolean;
  /** Video models: the lengths it makes, in seconds. */
  durationSeconds?: { min: number; max: number };
  aspectRatios?: readonly string[];
  /** Video resolutions such as "720p", or an image model's named sizes such as "2k". */
  resolutions?: readonly string[];
  /** Pixel sizes as "1024x1024", for a model that takes a size. */
  sizes?: readonly string[];
  qualities?: readonly MediaQuality[];
}

/** One value a person pastes to connect a provider with a key of its own. */
export interface MediaCredentialField {
  /** The key in `MediaProviderCredential.fields`. */
  name: string;
  label: string;
  /** Masked in Settings and never returned once saved. */
  secret: boolean;
}

/** A model connection whose sign-in or key this provider can use instead of a key of its own. */
export interface MediaModelConnectionSource {
  /** The model provider id, as model settings stores it. */
  provider: string;
  auth: "api_key" | "oauth";
}

/** What a provider authenticates with: its own pasted values, or a borrowed model connection. */
export type MediaProviderCredential =
  | { kind: "key"; fields: Readonly<Record<string, string>> }
  | {
      kind: "model_connection";
      provider: string;
      auth: "api_key" | "oauth";
      /** The API key, or a current OAuth access token. */
      token: string;
      /** The signed-in account, where the provider's requests name it. */
      accountId?: string;
      /** The connection's own endpoint, when it has one. */
      baseUrl?: string;
    };

export interface MediaProviderOptions {
  fetch?: typeof fetch;
  resolveHostname?: ResolveHostname;
}

/**
 * One media provider: everything the router, the catalog Settings reads, and tests read about
 * it. The registry key is its id. It is listed as available only for a credential it can use.
 */
export interface MediaProviderDefinition {
  catalog: {
    /** The name Settings and the chooser show. */
    name: string;
    /** What to paste to connect it with a key of its own; empty when it only borrows. */
    fields: readonly MediaCredentialField[];
  };
  /** Model connections it can borrow, most preferred first. */
  modelConnections?: readonly MediaModelConnectionSource[];
  /** The models offered by name. A capability no listed model has is one it does not have. */
  models: readonly MediaModelDescriptor[];
  /** Takes a model id beyond the listed ones, for the kinds its listed models cover. */
  customModels?: boolean;
  /**
   * Models as they stand for one credential, when that differs from `models` (a sign-in that
   * makes images but no video). Absent means every listed model.
   */
  modelsFor?(credential: MediaProviderCredential): readonly MediaModelDescriptor[];
  /** Builds the provider for one credential. It makes no request until a generation is asked. */
  create(
    credential: MediaProviderCredential,
    options: MediaProviderOptions,
  ): MediaGenerationProvider;
}
