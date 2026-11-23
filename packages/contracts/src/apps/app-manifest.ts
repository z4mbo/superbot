import * as z from "zod";

/**
 * An app is a page with declared state and actions: a person uses it through its controls and a
 * bot through tools, and both run the same declared actions on the same stored state. The app's
 * code runs only in the sandboxed page viewer, which loads nothing from the network, so what an
 * app can reach outside itself is exactly what these permissions grant and the host enforces.
 */
export const APP_PERMISSIONS = [
  /** The app keeps state between visits, and its declared actions change that state. */
  "state",
  /** Bots in the chat can read the app's state. */
  "agent:read",
  /** Bots in the chat can run the app's declared actions. */
  "agent:actions",
  /** The app can put a reply in the chat composer beside it, for the person to send. */
  "reply",
  /** The app can ask to open a web or mail link, which the person confirms. */
  "links",
  /** The app can put text on the clipboard after the person clicks. */
  "clipboard",
] as const;

export const appPermissionSchema = z.enum(APP_PERMISSIONS);
export type AppPermission = z.infer<typeof appPermissionSchema>;

export const APP_ID_MAX_LENGTH = 64;
export const APP_NAME_MAX_LENGTH = 80;
export const APP_DESCRIPTION_MAX_LENGTH = 500;
export const APP_PATH_MAX_LENGTH = 200;
export const APP_ACTIONS_MAX = 32;
export const APP_ACTION_INPUTS_MAX = 16;
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

/** A state path: dot-separated keys, never one that reaches an object's prototype. */
const STATE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

export const appStatePathSchema = z
  .string()
  .max(200)
  .refine(
    (path) => path.split(".").every((key) => STATE_KEY.test(key) && !FORBIDDEN_KEYS.has(key)),
    "A state path is dot-separated keys of letters, digits and underscores.",
  );

const inputName = z
  .string()
  .regex(STATE_KEY)
  .refine((name) => !FORBIDDEN_KEYS.has(name), "That input name is reserved.");

/** One field an action takes. Only plain values, so a bot and a control send the same thing. */
export const appActionInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("string"),
    description: z.string().max(300).optional(),
    required: z.boolean().optional(),
    maxLength: z.number().int().min(1).max(4000).optional(),
    enum: z.array(z.string().max(200)).min(1).max(50).optional(),
  }),
  z.strictObject({
    type: z.literal("number"),
    description: z.string().max(300).optional(),
    required: z.boolean().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    integer: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("boolean"),
    description: z.string().max(300).optional(),
    required: z.boolean().optional(),
  }),
]);
export type AppActionInput = z.infer<typeof appActionInputSchema>;

/**
 * What an action does to the app's state, step by step. Steps are data, not code, so the host
 * runs them the same way whether a person or a bot asked, and app code never runs on the server.
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

export const appActionSchema = z.strictObject({
  /** How the app's code and a bot's tool call name the action. */
  name: inputName,
  /** Read by bots to decide when to run it. */
  description: z.string().min(1).max(300),
  input: z
    .record(inputName, appActionInputSchema)
    .refine((fields) => Object.keys(fields).length <= APP_ACTION_INPUTS_MAX, {
      message: `An action takes at most ${APP_ACTION_INPUTS_MAX} inputs.`,
    })
    .default({}),
  effects: z.array(appActionEffectSchema).min(1).max(APP_ACTION_EFFECTS_MAX),
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
  })
  .superRefine((manifest, ctx) => {
    const names = new Set<string>();
    for (const action of manifest.actions) {
      if (names.has(action.name))
        ctx.addIssue({ code: "custom", path: ["actions"], message: `"${action.name}" twice.` });
      names.add(action.name);
    }
    if (manifest.actions.length > 0 && !manifest.permissions.includes("state"))
      ctx.addIssue({
        code: "custom",
        path: ["permissions"],
        message: 'Actions change the app\'s state, so they need the "state" permission.',
      });
    if (
      (manifest.permissions.includes("agent:read") ||
        manifest.permissions.includes("agent:actions")) &&
      !manifest.permissions.includes("state")
    )
      ctx.addIssue({
        code: "custom",
        path: ["permissions"],
        message: 'Bots reach an app through its state, so "agent:*" needs "state".',
      });
    if (stateBytes(manifest.initialState) > APP_STATE_MAX_BYTES)
      ctx.addIssue({
        code: "custom",
        path: ["initialState"],
        message: `The initial state must fit within ${APP_STATE_MAX_BYTES} bytes.`,
      });
  });
export type AppManifest = z.infer<typeof appManifestSchema>;
/** A manifest as written in `app.json`, before defaults fill in. */
export type AppManifestInput = z.input<typeof appManifestSchema>;

/** The file an app folder keeps its manifest in. */
export const APP_MANIFEST_FILE = "app.json";
