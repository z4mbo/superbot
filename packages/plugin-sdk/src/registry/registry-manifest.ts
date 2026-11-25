import { RegistryPluginManifestSchema } from "@rakazo/contracts";

/** The `schemaVersion` every registry manifest carries. */
export const MANIFEST_SCHEMA_VERSION = 1;
export const MAX_PLUGIN_NAME = 120;
export const MAX_PLUGIN_DESCRIPTION = 1000;
export const MAX_PLUGIN_PARTS = 16;
export const MAX_SKILL_INSTRUCTIONS = 16000;
export const MAX_ENDPOINT = 2048;
export const MAX_SLUG = 64;
export const MAX_APP_FIELDS = 16;
export const MAX_APP_FIELD_LABEL = 120;
/** The largest `plugin.json` a client reads; the registry limits keep a real manifest far below it. */
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export type RegistryAppFieldType = "text" | "number" | "date";

/** One input of an app part's form. */
export type RegistryAppField = {
  id: string;
  label: string;
  type: RegistryAppFieldType;
  required: boolean;
};

export type RegistryManifestPart =
  | { kind: "skill"; id: string; instructions: string }
  | { kind: "mcp"; id: string; transport: "streamable_http"; endpoint: string }
  | {
      /**
       * A form people fill in to keep records, which the registry stores per installation.
       * Uninstalling the plugin deletes those records.
       */
      kind: "app";
      id: string;
      fields: RegistryAppField[];
      /** A number field the app totals across the records it shows. */
      summaryField?: string;
    };

/**
 * A registry plugin manifest: the `plugin.json` that `superbot-plugin init` writes and
 * `pluginRegistry/submit` takes. A value from {@link readRegistryManifest} has the right shape;
 * {@link normalizeRegistryManifest} checks the registry's limits and returns the copy it stores.
 */
export type RegistryManifest = {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  name: string;
  description: string;
  parts: RegistryManifestPart[];
};

const FIELD_TYPES: readonly RegistryAppFieldType[] = ["text", "number", "date"];

/** Why a manifest cannot be read or submitted. The message names no location; `path` does. */
export class RegistryManifestError extends Error {
  /** Where in the manifest, like `parts[1].endpoint`; empty for the whole file. */
  readonly path: string;
  /** The file holds something no plugin can carry, so it cannot be edited as one. */
  readonly unsupported: boolean;

  constructor(path: string, message: string, unsupported: boolean) {
    super(message);
    this.name = "RegistryManifestError";
    this.path = path;
    this.unsupported = unsupported;
  }

  /** The message prefixed with its location, as command-line tools report it. */
  located(): string {
    return this.path ? `${this.path}: ${this.message}` : this.message;
  }
}

const invalid = (path: string, message: string) => new RegistryManifestError(path, message, false);
const unsupported = (path: string, message: string) =>
  new RegistryManifestError(path, message, true);

/** Field names that would hand a plugin secrets or let it run something. */
const CARRIES_SECRETS_OR_COMMANDS = new Set([
  "apikey",
  "args",
  "auth",
  "authorization",
  "command",
  "commands",
  "credentials",
  "env",
  "headers",
  "hooks",
  "package",
  "packages",
  "password",
  "script",
  "secrets",
  "token",
]);

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (object: JsonObject, key: string): unknown =>
  Object.hasOwn(object, key) ? object[key] : undefined;

const at = (path: string, key: string) => (path ? `${path}.${key}` : key);

function extraField(path: string, key: string): RegistryManifestError {
  const field = at(path, key);
  return CARRIES_SECRETS_OR_COMMANDS.has(key.replace(/[A-Z]/g, (letter) => letter.toLowerCase()))
    ? unsupported(field, `Superbot plugins can't carry secrets or commands. Remove “${key}”.`)
    : unsupported(field, `Superbot plugins have no “${key}” field. Remove it.`);
}

function object(value: unknown, path: string, what: string, allowed: string[]): JsonObject {
  if (!isObject(value)) throw unsupported(path, `${what} must be a JSON object.`);
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw extraField(path, extra);
  return value;
}

function text(object: JsonObject, path: string, key: string): string {
  const value = own(object, key);
  if (typeof value === "string") return value;
  throw unsupported(
    at(path, key),
    value === undefined ? `“${key}” is missing.` : `“${key}” must be text.`,
  );
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Reads a `plugin.json`. Anything a plugin cannot carry (another schema version, an unknown field
 * or part kind, another transport) is refused; values outside the registry's limits are kept for
 * {@link normalizeRegistryManifest}.
 */
export function readRegistryManifest(bytes: Uint8Array): RegistryManifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw unsupported("", "This file is too large to be a plugin manifest.");
  }
  let value: unknown;
  try {
    // A byte-order mark is not JSON, so it is kept for the parser to refuse.
    value = JSON.parse(utf8.decode(bytes));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw unsupported("", `This file isn't valid JSON (${reason}).`);
  }
  const root = object(value, "", "The manifest", ["schemaVersion", "name", "description", "parts"]);
  const schema = own(root, "schemaVersion");
  if (schema === undefined) throw unsupported("schemaVersion", "“schemaVersion” is missing.");
  if (schema !== MANIFEST_SCHEMA_VERSION) {
    throw unsupported(
      "schemaVersion",
      `This file uses schemaVersion ${JSON.stringify(schema)}. Superbot reads schemaVersion 1.`,
    );
  }
  const parts = own(root, "parts");
  if (parts === undefined) throw unsupported("parts", "“parts” is missing.");
  if (!Array.isArray(parts)) throw unsupported("parts", "“parts” must be a list.");
  if (parts.length > MAX_PLUGIN_PARTS * 4) {
    throw unsupported("parts", "This file has far more parts than a plugin can have.");
  }
  const read = parts.map((part: unknown, index) => readPart(part, index));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    name: text(root, "", "name"),
    description: text(root, "", "description"),
    parts: read,
  };
}

function readPart(value: unknown, index: number): RegistryManifestPart {
  const path = `parts[${index}]`;
  const place = index + 1;
  const kind = isObject(value) ? own(value, "kind") : undefined;
  if (typeof kind !== "string") {
    throw unsupported(path, `Part ${place} needs a “kind” of skill, mcp or app.`);
  }
  switch (kind) {
    case "skill": {
      const part = object(value, path, "A part", ["kind", "id", "instructions"]);
      return { kind, id: text(part, path, "id"), instructions: text(part, path, "instructions") };
    }
    case "mcp": {
      const part = object(value, path, "A part", ["kind", "id", "transport", "endpoint"]);
      const transport = text(part, path, "transport");
      if (transport !== "streamable_http") {
        throw unsupported(
          `${path}.transport`,
          `Part ${place} uses the “${transport}” transport. Plugins connect over streamable_http.`,
        );
      }
      return {
        kind,
        id: text(part, path, "id"),
        transport,
        endpoint: text(part, path, "endpoint"),
      };
    }
    case "app": {
      const part = object(value, path, "A part", ["kind", "id", "fields", "summaryField"]);
      const fields = own(part, "fields");
      if (fields === undefined) throw unsupported(`${path}.fields`, "“fields” is missing.");
      if (!Array.isArray(fields)) throw unsupported(`${path}.fields`, "“fields” must be a list.");
      if (fields.length > MAX_APP_FIELDS * 4) {
        throw unsupported(
          `${path}.fields`,
          `Part ${place} has far more fields than an app can have.`,
        );
      }
      const summaryField = own(part, "summaryField");
      if (summaryField !== undefined && typeof summaryField !== "string") {
        throw unsupported(`${path}.summaryField`, "“summaryField” must be text.");
      }
      const id = text(part, path, "id");
      return {
        kind,
        id,
        fields: fields.map((field: unknown, index) => readField(field, `${path}.fields[${index}]`)),
        ...(summaryField === undefined ? {} : { summaryField }),
      };
    }
    default:
      throw unsupported(
        `${path}.kind`,
        `Part ${place} is a “${kind}”. Plugins have skills, mcp connectors and apps.`,
      );
  }
}

function readField(value: unknown, path: string): RegistryAppField {
  const field = object(value, path, "An app field", ["id", "label", "type", "required"]);
  const type = text(field, path, "type");
  if (!FIELD_TYPES.includes(type as RegistryAppFieldType)) {
    throw unsupported(`${path}.type`, `“${type}” isn't a field type. Use text, number or date.`);
  }
  const required = own(field, "required");
  if (required === undefined) throw unsupported(`${path}.required`, "“required” is missing.");
  if (typeof required !== "boolean") {
    throw unsupported(`${path}.required`, "“required” must be true or false.");
  }
  return {
    id: text(field, path, "id"),
    label: text(field, path, "label"),
    type: type as RegistryAppFieldType,
    required,
  };
}

/**
 * The manifest the registry would store, or the first thing to fix: text trimmed as the registry
 * trims it and endpoints normalized as it parses them, every limit checked. The registry's own
 * schema has the last word, so a rule added there is never missed here.
 */
export function normalizeRegistryManifest(manifest: RegistryManifest): RegistryManifest {
  const name = bounded(manifest.name, MAX_PLUGIN_NAME);
  if (typeof name !== "string") {
    throw invalid(
      "name",
      name.empty
        ? "Give the plugin a name."
        : `The name can be at most ${MAX_PLUGIN_NAME} characters.`,
    );
  }
  const description = bounded(manifest.description, MAX_PLUGIN_DESCRIPTION);
  if (typeof description !== "string") {
    throw invalid(
      "description",
      description.empty
        ? "Say what the plugin does."
        : "The description can be at most 1,000 characters.",
    );
  }
  if (manifest.parts.length === 0) {
    throw invalid("parts", "Add at least one skill, connector or app.");
  }
  if (manifest.parts.length > MAX_PLUGIN_PARTS) {
    throw invalid("parts", "A plugin can have 16 parts.");
  }
  const ids = new Set<string>();
  const parts = manifest.parts.map((part, index): RegistryManifestPart => {
    const path = `parts[${index}]`;
    const place = index + 1;
    const { id } = part;
    if (!isPluginSlug(id)) {
      throw invalid(
        `${path}.id`,
        `Part ${place} needs an identifier in lowercase letters, digits and single hyphens.`,
      );
    }
    if (ids.has(id)) {
      throw invalid(`${path}.id`, `Two parts are called ${id}. Give each its own identifier.`);
    }
    ids.add(id);
    return normalizedPart(part, path, place);
  });
  const normalized: RegistryManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    name,
    description,
    parts,
  };
  const checked = RegistryPluginManifestSchema.safeParse(normalized);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw invalid(issuePath(issue?.path ?? []), issue?.message ?? "The registry refuses this.");
  }
  return normalized;
}

function normalizedPart(
  part: RegistryManifestPart,
  path: string,
  place: number,
): RegistryManifestPart {
  const { id } = part;
  switch (part.kind) {
    case "skill": {
      const instructions = bounded(part.instructions, MAX_SKILL_INSTRUCTIONS);
      if (typeof instructions !== "string") {
        throw invalid(
          `${path}.instructions`,
          instructions.empty
            ? `Part ${place} needs instructions.`
            : `Part ${place}'s instructions can be at most 16,000 characters.`,
        );
      }
      return { kind: "skill", id, instructions };
    }
    case "mcp": {
      const endpoint = registryEndpoint(part.endpoint);
      if (endpoint === undefined) {
        throw invalid(
          `${path}.endpoint`,
          `Part ${place}: use a public HTTPS address without keys, tokens or a ?query.`,
        );
      }
      return { kind: "mcp", id, transport: "streamable_http", endpoint };
    }
    case "app":
      return normalizedApp(part, path, place);
  }
}

function normalizedApp(
  part: Extract<RegistryManifestPart, { kind: "app" }>,
  path: string,
  place: number,
): RegistryManifestPart {
  const { id, fields, summaryField } = part;
  if (fields.length === 0) {
    throw invalid(`${path}.fields`, `Part ${place} needs at least one field.`);
  }
  if (fields.length > MAX_APP_FIELDS) {
    throw invalid(`${path}.fields`, `Part ${place} can have ${MAX_APP_FIELDS} fields.`);
  }
  const ids = new Set<string>();
  const normalized = fields.map((field, index): RegistryAppField => {
    const fieldPath = `${path}.fields[${index}]`;
    const number = index + 1;
    if (!isPluginSlug(field.id)) {
      throw invalid(
        `${fieldPath}.id`,
        `Field ${number} of part ${place} needs an identifier in lowercase letters, digits and single hyphens.`,
      );
    }
    if (ids.has(field.id)) {
      throw invalid(
        `${fieldPath}.id`,
        `Two fields of part ${place} are called ${field.id}. Give each its own identifier.`,
      );
    }
    ids.add(field.id);
    const label = appFieldLabel(field.label);
    if (label.problem !== undefined) {
      throw invalid(`${fieldPath}.label`, `Field ${number} of part ${place}: ${label.problem}`);
    }
    return { id: field.id, label: label.value, type: field.type, required: field.required };
  });
  if (
    summaryField !== undefined &&
    !fields.some((field) => field.id === summaryField && field.type === "number")
  ) {
    throw invalid(
      `${path}.summaryField`,
      `Part ${place} totals “${summaryField}”, which isn't one of its number fields.`,
    );
  }
  return {
    kind: "app",
    id,
    fields: normalized,
    ...(summaryField === undefined ? {} : { summaryField }),
  };
}

/** The label the registry stores. Unlike names, the registry measures a label before trimming it. */
function appFieldLabel(
  label: string,
): { value: string; problem?: undefined } | { problem: string } {
  if (label.length > MAX_APP_FIELD_LABEL) {
    return { problem: "a label can be at most 120 characters." };
  }
  const trimmed = label.trim();
  if (trimmed === "") return { problem: "give it a label." };
  if (/[\0\p{Bidi_Control}]/u.test(trimmed)) {
    return { problem: "remove the hidden control characters from its label." };
  }
  return { value: trimmed };
}

/** A zod issue path in the `parts[1].endpoint` form the other errors use. */
function issuePath(path: readonly PropertyKey[]): string {
  return path
    .map((key, index) =>
      typeof key === "number" ? `[${key}]` : `${index === 0 ? "" : "."}${String(key)}`,
    )
    .join("");
}

/**
 * Lowercase ASCII letters and digits in segments joined by single hyphens, at most 64 characters:
 * plugin slugs and part ids.
 */
export function isPluginSlug(value: string): boolean {
  return value.length <= MAX_SLUG && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/**
 * `value` trimmed as the registry trims it (JavaScript's own `trim`) when 1 to `max` UTF-16 code
 * units remain; otherwise whether nothing was left.
 */
export function bounded(value: string, max: number): string | { empty: boolean } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { empty: true };
  if (trimmed.length > max) return { empty: false };
  return trimmed;
}

/** The endpoint the registry stores, if it accepts this one. */
export function registryEndpoint(endpoint: string): string | undefined {
  // The registry's URL parsing trims and removes ASCII tabs and newlines before its refinements.
  const normalized = endpoint.trim().replace(/[\t\n\r]/g, "");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return undefined;
  }
  const accepted =
    endpoint.length <= MAX_ENDPOINT &&
    normalized.startsWith("https://") &&
    !normalized.includes("?") &&
    !normalized.endsWith("#") &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "";
  return accepted ? normalized : undefined;
}

/** The file's text: pretty JSON and a final newline, as the command-line tool writes it. */
export function registryManifestText(manifest: RegistryManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
