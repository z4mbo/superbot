import * as z from "zod";

/** What media a provider or model makes. */
export const MediaKindSchema = z.enum(["image", "video"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

/** One model a connected provider offers, with only what it can really do for that connection. */
export const MediaModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: MediaKindSchema,
  default: z.boolean().optional(),
  edit: z.boolean().optional(),
  mask: z.boolean().optional(),
  referenceImages: z.number().int().nonnegative().optional(),
  startFrame: z.boolean().optional(),
  endFrame: z.boolean().optional(),
  audio: z.boolean().optional(),
  durationSeconds: z.object({ min: z.number(), max: z.number() }).optional(),
  aspectRatios: z.array(z.string()).optional(),
  resolutions: z.array(z.string()).optional(),
  sizes: z.array(z.string()).optional(),
  qualities: z.array(z.enum(["low", "medium", "high", "auto"])).optional(),
});
export type MediaModelInfo = z.infer<typeof MediaModelInfoSchema>;

/** One value the connection form asks for. A secret one is never sent back once saved. */
export const MediaCredentialFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  secret: z.boolean(),
});
export type MediaCredentialField = z.infer<typeof MediaCredentialFieldSchema>;

export const MediaCapabilitiesSchema = z.object({
  image: z.boolean(),
  imageEdit: z.boolean(),
  video: z.boolean(),
});
export type MediaCapabilities = z.infer<typeof MediaCapabilitiesSchema>;

/**
 * One media provider as it stands for the signed-in person. `source` says what connects it: a
 * key they saved, or a model connection of theirs it borrows. Not connected means unusable.
 */
export const MediaProviderEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  fields: z.array(MediaCredentialFieldSchema),
  /** Model providers whose connection this provider can borrow instead of a key of its own. */
  modelConnections: z.array(z.string()),
  connected: z.boolean(),
  source: z.enum(["key", "model_connection"]).nullable(),
  /** The saved values that are not secret, by field name. Secret fields never appear here. */
  hints: z.record(z.string(), z.string()),
  capabilities: MediaCapabilitiesSchema,
  /** The models it offers for this connection, or every listed model when not connected. */
  models: z.array(MediaModelInfoSchema),
  /** Takes a model id beyond the listed ones. */
  customModels: z.boolean(),
});
export type MediaProviderEntry = z.infer<typeof MediaProviderEntrySchema>;

export const MediaPreferenceChoiceSchema = z.object({
  provider: z.string(),
  /** Null uses the provider's default model. */
  model: z.string().nullable(),
});
export const MediaPreferenceSchema = z.object({
  image: MediaPreferenceChoiceSchema.nullable(),
  video: MediaPreferenceChoiceSchema.nullable(),
});
export type MediaPreference = z.infer<typeof MediaPreferenceSchema>;

export const MediaCatalogSchema = z.object({
  providers: z.array(MediaProviderEntrySchema),
  preference: MediaPreferenceSchema,
  /**
   * What the server's own media setup makes for someone who connected nothing for that kind.
   * Null when the server has none.
   */
  server: MediaCapabilitiesSchema.nullable(),
});
export type MediaCatalog = z.infer<typeof MediaCatalogSchema>;

const providerId = z.string().trim().min(1).max(80);

export const MediaConnectInputSchema = z.object({
  provider: providerId,
  /** Every field of the provider's form by name; a blank secret field keeps the saved value. */
  fields: z
    .record(z.string().min(1).max(80), z.string().max(8192))
    .refine((fields) => Object.keys(fields).length <= 12, "Too many fields."),
});

export const MediaSetPreferenceInputSchema = z.object({
  kind: MediaKindSchema,
  /** Null clears the choice, so the first connected provider is used. */
  provider: providerId.nullable(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
});
