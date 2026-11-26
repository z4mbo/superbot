import * as z from "zod";
import { APP_CARDS_MAX, appCardSchema, appDataSchema, appNetworkSchema } from "./app-data.js";
import {
  APP_ACTION_INPUTS_MAX,
  appFieldsSchema,
  appNameSchema,
  appStatePathSchema,
} from "./app-fields.js";

/**
 * An app is a page with declared state and actions: a person uses it through its controls and a
 * bot through tools, and both run the same declared actions. The app's page code runs only in
 * the sandboxed page viewer, which loads nothing from the network; an installed app may also
 * keep records on the platform and run server functions in a sandbox there. What an app can
 * reach outside itself is exactly what these permissions grant and the host enforces.
 */
export const APP_PERMISSIONS = [
  /** The app keeps state between visits, and its declared actions change that state. */
  "state",
  /** Bots in the chat can read the app's state and run its read-only actions. */
  "agent:read",
  /** Bots in the chat can run the app's declared actions. */
  "agent:actions",
  /** The app can put a reply in the chat composer beside it, for the person to send. */
  "reply",
  /** The app can ask to open a web or mail link, which the person confirms. */
  "links",
  /** The app can put text on the clipboard after the person clicks. */
  "clipboard",
  /** The app keeps records in its own collections on the platform (installed apps only). */
  "data",
  /** The app's server functions call the HTTPS hosts its manifest names (installed apps only). */
  "network",
] as const;

export const appPermissionSchema = z.enum(APP_PERMISSIONS);
export type AppPermission = z.infer<typeof appPermissionSchema>;

export const APP_ID_MAX_LENGTH = 64;
export const APP_NAME_MAX_LENGTH = 80;
export const APP_DESCRIPTION_MAX_LENGTH = 500;
export const APP_PATH_MAX_LENGTH = 200;
export const APP_ACTIONS_MAX = 32;
export const APP_ACTION_EFFECTS_MAX = 8;
/** The most UTF-8 an app's state may take, initial or after any action. */
export const APP_STATE_MAX_BYTES = 64 * 1024;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Semantic Versioning 2.0.0, without a leading "v".
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
// Names Windows will not create as files, with or without an extension.
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/**
 * A path inside the app's folder, written with forward slashes on every system. Each segment is
 * a plain file name that Windows, macOS and Linux all accept, so the folder unpacks the same way
 * everywhere; nothing can climb out of the folder or name a drive.
 */
export function appRelativePathProblem(path: string): string | undefined {
  if (path.length === 0 || path.length > APP_PATH_MAX_LENGTH)
    return `must be 1 to ${APP_PATH_MAX_LENGTH} characters`;
  if (path.includes("\\")) return "must use forward slashes";
  const segments = path.split("/");
  for (const segment of segments) {
    if (!PATH_SEGMENT.test(segment) || segment.endsWith("."))
      return `has an unsupported segment "${segment}"`;
    if (WINDOWS_RESERVED.test(segment)) return `uses "${segment}", a name Windows reserves`;
  }
  return undefined;
}

function relativePath(extensions: readonly string[]) {
  return z.string().superRefine((path, ctx) => {
    const problem = appRelativePathProblem(path);
    if (problem) ctx.addIssue({ code: "custom", message: `Path ${problem}.` });
    else if (!extensions.some((extension) => path.toLowerCase().endsWith(extension)))
      ctx.addIssue({ code: "custom", message: `Path must end in ${extensions.join(", ")}.` });
  });
}

const inputName = appNameSchema;

/**
 * What an action does to the app's state, step by step. Steps are data, not code, so the host
 * runs them the same way whether a person or a bot asked.
 * `from` names an input field; without it a step uses the whole input.
 */
export const appActionEffectSchema = z.discriminatedUnion("op", [
  /** Replace the value at `path`, with an input field or a fixed `value`. */
  z.strictObject({
    op: z.literal("set"),
    path: appStatePathSchema,
    from: inputName.optional(),
    value: z.json().optional(),
  }),
  /** Add the input (or one field) to the end of the list at `path`, dropping the oldest past `max`. */
  z.strictObject({
    op: z.literal("append"),
    path: appStatePathSchema,
    from: inputName.optional(),
    /** Give an appended object an `id` the host makes up. */
    assignId: z.boolean().optional(),
    max: z.number().int().min(1).max(1000).optional(),
  }),
  /** Change the item in the list at `path` whose `key` equals input `match`, with the other inputs. */
  z.strictObject({
    op: z.literal("update"),
    path: appStatePathSchema,
    key: inputName.default("id"),
    match: inputName.default("id"),
  }),
  /** Remove the items in the list at `path` whose `key` equals input `match`. */
  z.strictObject({
    op: z.literal("remove"),
    path: appStatePathSchema,
    key: inputName.default("id"),
    match: inputName.default("id"),
  }),
  /** Add a number input (or `by`, or 1) to the number at `path`. */
  z.strictObject({
    op: z.literal("increment"),
    path: appStatePathSchema,
    from: inputName.optional(),
    by: z.number().finite().optional(),
  }),
  /** Flip the boolean at `path`, or the `field` of the matching list item. */
  z.strictObject({
    op: z.literal("toggle"),
    path: appStatePathSchema,
    field: inputName.optional(),
    key: inputName.default("id"),
    match: inputName.default("id"),
  }),
]);
export type AppActionEffect = z.infer<typeof appActionEffectSchema>;

/** A function the app's server file exports: a plain JavaScript name. */
const functionName = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/, "A function name is a JavaScript name.")
  .refine((name) => !APP_FORBIDDEN_FUNCTION_NAMES.has(name), "That function name is reserved.");
const APP_FORBIDDEN_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "default",
  "then",
]);

/**
 * One thing the app does, by name. It is backed either by `effects` the host applies to the
 * app's state, or by `run`, a function in the app's server file; never both. A `readOnly`
 * function only reads: it needs no click to run and a bot may call it with `agent:read`.
 */
export const appActionSchema = z
  .strictObject({
    /** How the app's code and a bot's tool call name the action. */
    name: inputName,
    /** Read by bots to decide when to run it. */
    description: z.string().min(1).max(300),
    input: appFieldsSchema(APP_ACTION_INPUTS_MAX, "An action takes").default({}),
    effects: z.array(appActionEffectSchema).min(1).max(APP_ACTION_EFFECTS_MAX).optional(),
    /** The server function that runs the action, exported by the manifest's `server` file. */
    run: functionName.optional(),
    readOnly: z.boolean().optional(),
  })
  .superRefine((action, ctx) => {
    if ((action.effects === undefined) === (action.run === undefined))
      ctx.addIssue({
        code: "custom",
        message: `${action.name}: give either "effects" or "run", not both or neither.`,
      });
    if (action.readOnly && action.run === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["readOnly"],
        message: `${action.name}: only a "run" action can be read-only; effects change state.`,
      });
  });
export type AppAction = z.infer<typeof appActionSchema>;

function stateBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export const appManifestSchema = z
  .strictObject({
    /** Stable across versions; lowercase words joined by hyphens. */
    id: z.string().max(APP_ID_MAX_LENGTH).regex(SLUG, "An app id is lowercase words and hyphens."),
    name: z.string().trim().min(1).max(APP_NAME_MAX_LENGTH),
    version: z.string().max(100).regex(SEMVER, "The version must be semantic, like 1.0.0."),
    description: z.string().trim().min(1).max(APP_DESCRIPTION_MAX_LENGTH),
    /** The app's source file inside its folder. */
    entry: relativePath([".jsx", ".js"]),
    /** The app's server functions inside its folder: one plain JavaScript module. */
    server: relativePath([".js", ".mjs"]).optional(),
    permissions: z
      .array(appPermissionSchema)
      .max(APP_PERMISSIONS.length)
      .refine((list) => new Set(list).size === list.length, "List each permission once.")
      .default([]),
    /** A square image inside the app's folder. */
    icon: relativePath([".png", ".jpg", ".jpeg", ".webp"]).optional(),
    /** The state a new copy of the app starts with. */
    initialState: z.record(z.string(), z.json()).default({}),
    actions: z.array(appActionSchema).max(APP_ACTIONS_MAX).default([]),
    /** Collections of records the app keeps on the platform; needs the "data" permission. */
    data: appDataSchema.optional(),
    /** Hosts the server functions may call; needs the "network" permission. */
    network: appNetworkSchema.optional(),
    /** Named views a bot can show in chat. */
    cards: z.array(appCardSchema).max(APP_CARDS_MAX).optional(),
  })
  .superRefine((manifest, ctx) => {
    const has = (permission: AppPermission) => manifest.permissions.includes(permission);
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const names = new Set<string>();
    for (const action of manifest.actions) {
      if (names.has(action.name)) issue("actions", `"${action.name}" twice.`);
      names.add(action.name);
    }
    const cards = new Set<string>();
    for (const card of manifest.cards ?? []) {
      if (cards.has(card.name)) issue("cards", `"${card.name}" twice.`);
      cards.add(card.name);
    }
    if (manifest.actions.some((action) => action.effects) && !has("state"))
      issue("permissions", 'Effects change the app\'s state, so they need the "state" permission.');
    const functions = manifest.actions.filter((action) => action.run !== undefined);
    if (functions.length > 0 && manifest.server === undefined)
      issue("server", 'Actions that "run" a function need a "server" file.');
    if (manifest.server !== undefined && functions.length === 0)
      issue("server", 'A "server" file is used only by actions that "run" its functions.');
    if ((has("agent:read") || has("agent:actions")) && !has("state") && functions.length === 0)
      issue(
        "permissions",
        'Bots reach an app through its state or its functions, so "agent:*" needs "state" or a "run" action.',
      );
    if (has("data") !== (manifest.data !== undefined))
      issue("data", 'Collections in "data" and the "data" permission go together.');
    if (manifest.data && manifest.server === undefined)
      issue("data", 'Records are read and written by server functions, so "data" needs "server".');
    if (has("network") !== (manifest.network !== undefined))
      issue("network", 'Hosts in "network" and the "network" permission go together.');
    if (manifest.network && manifest.server === undefined)
      issue("network", 'Only server functions call out, so "network" needs "server".');
    if (stateBytes(manifest.initialState) > APP_STATE_MAX_BYTES)
      issue("initialState", `The initial state must fit within ${APP_STATE_MAX_BYTES} bytes.`);
  });
export type AppManifest = z.infer<typeof appManifestSchema>;
/** A manifest as written in `app.json`, before defaults fill in. */
export type AppManifestInput = z.input<typeof appManifestSchema>;

/** Whether the app needs the platform beyond its page: hosted data, server code or network. */
export function appNeedsInstall(manifest: Pick<AppManifest, "server" | "data" | "network">) {
  return (
    manifest.server !== undefined || manifest.data !== undefined || manifest.network !== undefined
  );
}

/** The file an app folder keeps its manifest in. */
export const APP_MANIFEST_FILE = "app.json";
