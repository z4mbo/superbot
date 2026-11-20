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

const appFieldLimit = 16;
const postgresText = (value: string) => !/[\uD800-\uDFFF]/u.test(value) && !value.includes("\0");
export const RegistryAppDateSchema = z.iso.date();
export const RegistryAppTextSchema = z.string().max(2000).trim().min(1).refine(postgresText);
export const RegistryAppNumberSchema = z
  .number()
  .min(-1e12)
  .max(1e12)
  .transform((value) => (value === 0 ? 0 : value));

export const RegistryAppPartSchema = z
  .strictObject({
    id: slug,
    kind: z.literal("app"),
    fields: z
      .array(
        z.strictObject({
          id: slug,
          label: z
            .string()
            .max(120)
            .trim()
            .min(1)
            .refine(postgresText)
            .regex(/^[^\p{Bidi_Control}]*$/u),
          type: z.enum(["text", "number", "date"]),
          required: z.boolean(),
        }),
      )
      .min(1)
      .max(appFieldLimit)
      .refine(
        (fields) => new Set(fields.map((field) => field.id)).size === fields.length,
        "App field IDs must be unique",
      ),
    summaryField: slug.optional(),
  })
  .refine(
    ({ fields, summaryField }) =>
      summaryField === undefined ||
      fields.some(({ id, type }) => id === summaryField && type === "number"),
    { path: ["summaryField"], message: "The summary field must identify a numeric field" },
  );

export type RegistryAppPart = z.infer<typeof RegistryAppPartSchema>;

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
  RegistryAppPartSchema,
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

const appTarget = { installationId: id.refine(postgresText), partId: slug };
const appRecordId = z.uuid().transform((value) => value.toLowerCase());
export const RegistryAppValuesSchema = z
  .record(slug, z.union([RegistryAppTextSchema, RegistryAppNumberSchema]))
  .refine((values) => Object.keys(values).length <= appFieldLimit, "Too many app record fields");

/** Date filters match the first date field in manifest order. */
export const RegistryAppRecordsInputSchema = z.strictObject({
  ...pageInput,
  ...appTarget,
  after: appRecordId.optional(),
  date: RegistryAppDateSchema.optional(),
});

export const AddRegistryAppRecordInputSchema = z.strictObject({
  ...appTarget,
  operationId: appRecordId,
  values: RegistryAppValuesSchema,
});

export const RemoveRegistryAppRecordInputSchema = z.strictObject({
  ...appTarget,
  recordId: appRecordId,
});

export const RegistryAppRecordSchema = z.object({
  id: appRecordId,
  values: RegistryAppValuesSchema,
  createdAt: IsoDate,
});

/** Total sums every live record matching the filter, independently of pagination. */
export const RegistryAppRecordsSchema = page(RegistryAppRecordSchema).extend({
  nextAfter: appRecordId.nullable(),
  total: z.number().nullable(),
});

export type RegistryAppRecord = z.infer<typeof RegistryAppRecordSchema>;
export type RegistryAppRecords = z.infer<typeof RegistryAppRecordsSchema>;
export type RegistryAppRecordsInput = z.input<typeof RegistryAppRecordsInputSchema>;
export type AddRegistryAppRecordInput = z.input<typeof AddRegistryAppRecordInputSchema>;
export type RemoveRegistryAppRecordInput = z.input<typeof RemoveRegistryAppRecordInputSchema>;

export const MAX_REGISTRY_SEARCH_LENGTH = 120;

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
      .input(
        z.object({
          ...pageInput,
          slug: slug.optional(),
          query: z
            .string()
            .trim()
            .min(1)
            .max(MAX_REGISTRY_SEARCH_LENGTH)
            .regex(/^[^\0]*$/)
            .optional(),
        }),
      )
      .output(page(RegistryPluginVersionSchema)),
    install: oc.input(z.object({ versionId: id })).output(installation),
    switchVersion: oc
      .input(z.object({ installationId: id, expectedVersionId: id, versionId: id }))
      .output(installation),
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
    appRecords: oc.input(RegistryAppRecordsInputSchema).output(RegistryAppRecordsSchema),
    addAppRecord: oc.input(AddRegistryAppRecordInputSchema).output(RegistryAppRecordSchema),
    removeAppRecord: oc
      .input(RemoveRegistryAppRecordInputSchema)
      .output(z.object({ ok: z.literal(true) })),
  },
};
