import { oc } from "@orpc/contract";
import * as z from "zod";
import { IsoDate } from "../ids.js";
import { McpRemoteEndpointSchema } from "./mcp.js";

const id = z.string().min(1).max(128);
const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const version = z.number().int().min(1).max(2147483647);
const status = z.enum(["pending", "approved", "rejected"]);

export const RegistryPluginPartSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: slug,
    kind: z.literal("skill"),
    instructions: z.string().trim().min(1).max(16000),
  }),
  z.strictObject({
    id: slug,
    kind: z.literal("mcp"),
    transport: z.literal("streamable_http"),
    endpoint: McpRemoteEndpointSchema.refine(
      (value) => value.startsWith("https://") && !value.includes("?"),
      "Use an HTTPS endpoint without credentials, query parameters, or fragments",
    ),
  }),
]);

export const RegistryPluginManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000),
  parts: z
    .array(RegistryPluginPartSchema)
    .min(1)
    .max(16)
    .refine(
      (parts) => new Set(parts.map((part) => part.id)).size === parts.length,
      "Part IDs must be unique",
    ),
});

export const RegistryPluginVersionSchema = z.object({
  id,
  slug,
  version,
  manifest: RegistryPluginManifestSchema,
  status,
  reason: z.string().nullable(),
  createdAt: IsoDate,
  reviewedAt: IsoDate.nullable(),
});

const installation = z.object({
  id,
  plugin: RegistryPluginVersionSchema,
  grants: z.array(z.object({ botId: id, partId: slug })),
  createdAt: IsoDate,
});

const pageInput = {
  after: id.optional(),
  limit: z.number().int().min(1).max(50).default(20),
};

const page = <Item extends z.ZodType>(item: Item) =>
  z.object({ items: z.array(item), nextAfter: id.nullable() });

export const pluginRegistryRpc = {
  pluginRegistry: {
    submit: oc
      .input(z.object({ slug, version, manifest: RegistryPluginManifestSchema }))
      .output(RegistryPluginVersionSchema),
    mine: oc.input(z.object(pageInput)).output(page(RegistryPluginVersionSchema)),
    submissions: oc
      .input(z.object({ ...pageInput, status: status.default("pending") }))
      .output(page(RegistryPluginVersionSchema)),
    review: oc
      .input(
        z.discriminatedUnion("decision", [
          z.strictObject({ versionId: id, decision: z.literal("approved") }),
          z.strictObject({
            versionId: id,
            decision: z.literal("rejected"),
            reason: z.string().trim().min(1).max(2000),
          }),
        ]),
      )
      .output(RegistryPluginVersionSchema),
    discover: oc
      .input(z.object({ ...pageInput, slug: slug.optional() }))
      .output(page(RegistryPluginVersionSchema)),
    install: oc.input(z.object({ versionId: id })).output(installation),
    installations: oc.input(z.object(pageInput)).output(page(installation)),
    setGrants: oc
      .input(
        z.object({
          installationId: id,
          botId: id,
          partIds: z.array(slug).max(16),
        }),
      )
      .output(installation),
    uninstall: oc.input(z.object({ installationId: id })).output(z.object({ ok: z.literal(true) })),
  },
};
