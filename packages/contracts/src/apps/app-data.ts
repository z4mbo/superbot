import * as z from "zod";
import { appFieldsSchema, appNameSchema } from "./app-fields.js";

/**
 * What an installed app keeps on the platform and reaches beyond it. Records live in the app's
 * own collections, one set per install (one person in one Space); its server functions read and
 * write them, and call out only to the hosts the person allowed. All of it is declared here, so
 * the person sees it before installing and the host enforces exactly it.
 */

export const APP_COLLECTIONS_MAX = 8;
export const APP_COLLECTION_FIELDS_MAX = 32;
/** Fields a collection may filter and sort on. */
export const APP_COLLECTION_INDEX_MAX = 3;
/** Records one install keeps in all its collections. */
export const APP_DATA_RECORDS_MAX = 10_000;
/** The most one record's fields may take as JSON. */
export const APP_DATA_RECORD_MAX_BYTES = 16 * 1024;
/** The most all of one install's records may take. */
export const APP_DATA_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
export const APP_DATA_LIST_DEFAULT = 50;
export const APP_DATA_LIST_MAX = 200;

/** Keys every record has that the app does not write. */
export const APP_RECORD_RESERVED_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "createdAt",
  "updatedAt",
]);

export const appCollectionSchema = z
  .strictObject({
    fields: appFieldsSchema(APP_COLLECTION_FIELDS_MAX, "A collection declares"),
    /** Fields `list` can filter by value or range and sort on. */
    index: z.array(appNameSchema).max(APP_COLLECTION_INDEX_MAX).optional(),
  })
  .superRefine((collection, ctx) => {
    for (const name of Object.keys(collection.fields))
      if (APP_RECORD_RESERVED_FIELDS.has(name))
        ctx.addIssue({
          code: "custom",
          path: ["fields", name],
          message: `"${name}" is set by the platform; choose another field name.`,
        });
    const index = collection.index ?? [];
    if (new Set(index).size !== index.length)
      ctx.addIssue({ code: "custom", path: ["index"], message: "List each field once." });
    for (const name of index)
      if (!Object.hasOwn(collection.fields, name))
        ctx.addIssue({
          code: "custom",
          path: ["index"],
          message: `"${name}" is not one of the collection's fields.`,
        });
  });
export type AppCollection = z.infer<typeof appCollectionSchema>;

export const appDataSchema = z.strictObject({
  collections: z
    .record(appNameSchema, appCollectionSchema)
    .refine((collections) => Object.keys(collections).length >= 1, {
      message: "Declare at least one collection.",
    })
    .refine((collections) => Object.keys(collections).length <= APP_COLLECTIONS_MAX, {
      message: `Declare at most ${APP_COLLECTIONS_MAX} collections.`,
    }),
});
export type AppData = z.infer<typeof appDataSchema>;

export const APP_NETWORK_HOSTS_MAX = 8;
// A DNS name of two or more labels, lowercase; no port, no wildcard, no trailing dot.
const HOSTNAME =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why a host cannot be listed, or undefined when it can. */
export function appNetworkHostProblem(host: string): string | undefined {
  if (host.includes("*")) return "must be an exact host name, without wildcards";
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("["))
    return "must be a host name, not an IP address or port";
  if (host !== host.toLowerCase()) return "must be lowercase";
  if (!HOSTNAME.test(host)) return "is not a host name like api.example.com";
  if (host === "localhost" || /\.(?:localhost|local|internal|lan|home|arpa)$/.test(host))
    return "must be a public host";
  return undefined;
}

export const appNetworkSchema = z.strictObject({
  /** Exact HTTPS hosts the app's functions may call. */
  hosts: z
    .array(
      z.string().superRefine((host, ctx) => {
        const problem = appNetworkHostProblem(host);
        if (problem) ctx.addIssue({ code: "custom", message: `"${host}" ${problem}.` });
      }),
    )
    .min(1)
    .max(APP_NETWORK_HOSTS_MAX)
    .refine((hosts) => new Set(hosts).size === hosts.length, "List each host once."),
});
export type AppNetwork = z.infer<typeof appNetworkSchema>;

export const APP_CARDS_MAX = 8;
const CARD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A view of the app a bot can show in chat, by name, with an input of its own. */
export const appCardSchema = z.strictObject({
  name: z.string().max(40).regex(CARD_NAME, "A card name is lowercase words and hyphens."),
  title: z.string().trim().min(1).max(80),
  /** Read by bots to decide when to show it. */
  description: z.string().trim().min(1).max(300),
  input: appFieldsSchema(16, "A card takes").optional(),
});
export type AppCard = z.infer<typeof appCardSchema>;

/** A stored record as functions and bots see it: its fields and what the platform keeps. */
export type AppRecord = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

/** A `list` filter on one indexed field: a value, or a range. */
export const appRecordFilterSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z
    .strictObject({
      gt: z.union([z.string(), z.number().finite()]).optional(),
      gte: z.union([z.string(), z.number().finite()]).optional(),
      lt: z.union([z.string(), z.number().finite()]).optional(),
      lte: z.union([z.string(), z.number().finite()]).optional(),
    })
    .refine((range) => Object.keys(range).length > 0, "A range needs gt, gte, lt or lte."),
]);
export type AppRecordFilter = z.infer<typeof appRecordFilterSchema>;

/** What `list` takes. `order` names an indexed field, `createdAt` or `updatedAt`. */
export const appRecordQuerySchema = z.strictObject({
  where: z.record(appNameSchema, appRecordFilterSchema).optional(),
  order: z
    .union([
      appNameSchema,
      z.strictObject({ by: appNameSchema, direction: z.enum(["asc", "desc"]).optional() }),
    ])
    .optional(),
  limit: z.number().int().min(1).max(APP_DATA_LIST_MAX).optional(),
  cursor: z.string().max(200).optional(),
});
export type AppRecordQuery = z.infer<typeof appRecordQuerySchema>;

/** The most an app's server file may take, as UTF-8. */
export const APP_SERVER_MAX_BYTES = 128 * 1024;
