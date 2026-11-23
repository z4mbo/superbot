import { pluginRegistryRpc } from "@rakazo/contracts";
import type { RpcClient } from "../../../lib/query/rpc";

type Registry = RpcClient["pluginRegistry"];
export type RegistryVersion = Awaited<ReturnType<Registry["discover"]>>["items"][number];
export type RegistryInstallation = Awaited<ReturnType<Registry["install"]>>;
export type RegistryManifest = RegistryVersion["manifest"];
export type RegistryPart = RegistryManifest["parts"][number];
export type RegistryAppPart = Extract<RegistryPart, { kind: "app" }>;
export type RegistryAppField = RegistryAppPart["fields"][number];
export type RegistryAppRecord = Awaited<ReturnType<Registry["addAppRecord"]>>;
export type SubmitInput = Parameters<Registry["submit"]>[0];

export const REGISTRY_PAGE_SIZE = 50;
export const MAX_PARTS = 16;
export const MAX_APP_FIELDS = 16;
const MAX_PAGES = 100;

const submitSchema = pluginRegistryRpc.pluginRegistry.submit["~orpc"].inputSchema!;

/** Reads every page of a registry list; installs and an author's versions stay small. */
export async function readAllPages<Item>(
  read: (after: string | undefined) => Promise<{ items: Item[]; nextAfter: string | null }>,
): Promise<Item[]> {
  const items: Item[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await read(after);
    items.push(...result.items);
    if (!result.nextAfter) break;
    after = result.nextAfter;
  }
  return items;
}

/** The newest version of each plugin, by name. */
export function latestBySlug(versions: readonly RegistryVersion[]): RegistryVersion[] {
  const latest = new Map<string, RegistryVersion>();
  for (const version of versions) {
    const seen = latest.get(version.slug);
    if (!seen || version.version > seen.version) latest.set(version.slug, version);
  }
  return [...latest.values()].sort(
    (a, b) => a.manifest.name.localeCompare(b.manifest.name) || a.slug.localeCompare(b.slug),
  );
}

export function grantedBots(installation: RegistryInstallation): string[] {
  return [...new Set(installation.grants.map((grant) => grant.botId))];
}

export function grantedParts(installation: RegistryInstallation, botId: string): string[] {
  return installation.grants.filter((grant) => grant.botId === botId).map((grant) => grant.partId);
}

export function appParts(manifest: RegistryManifest): RegistryAppPart[] {
  return manifest.parts.filter((part): part is RegistryAppPart => part.kind === "app");
}

export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

export function nextVersion(mine: readonly RegistryVersion[], slug: string): number {
  return Math.max(0, ...mine.filter((row) => row.slug === slug).map((row) => row.version)) + 1;
}

export type FieldDraft = {
  key: number;
  label: string;
  id: string;
  /** False while the ID still follows the label. */
  idEdited: boolean;
  type: RegistryAppField["type"];
  required: boolean;
};

export type PartDraft =
  | { key: number; kind: "skill"; id: string; instructions: string }
  | { key: number; kind: "mcp"; id: string; endpoint: string }
  | { key: number; kind: "app"; id: string; fields: FieldDraft[]; summaryField: string };

export type PluginDraft = {
  name: string;
  slug: string;
  /** False while the slug still follows the name. */
  slugEdited: boolean;
  version: string;
  description: string;
  parts: PartDraft[];
};

let partKeys = 0;

export function newField(patch: Partial<Omit<FieldDraft, "key">> = {}): FieldDraft {
  partKeys += 1;
  return {
    key: partKeys,
    label: "",
    id: "",
    idEdited: false,
    type: "text",
    required: true,
    ...patch,
  };
}

/** A field edit; the ID follows the label until the author edits the ID. */
export function changeField(
  field: FieldDraft,
  patch: Partial<Omit<FieldDraft, "key">>,
): FieldDraft {
  const next = { ...field, ...patch };
  if (patch.id !== undefined) next.idEdited = true;
  else if (patch.label !== undefined && !field.idEdited) next.id = slugFromName(patch.label);
  return next;
}

const PART_ID_BASE = { skill: "skill", mcp: "tools", app: "app" } as const;

export function newPart(kind: PartDraft["kind"], taken: readonly PartDraft[]): PartDraft {
  const base = PART_ID_BASE[kind];
  let id: string = base;
  for (let index = 2; taken.some((part) => part.id === id); index += 1) id = `${base}-${index}`;
  partKeys += 1;
  if (kind === "skill") return { key: partKeys, kind, id, instructions: "" };
  if (kind === "mcp") return { key: partKeys, kind, id, endpoint: "" };
  return { key: partKeys, kind, id, fields: [newField()], summaryField: "" };
}

export function emptyDraft(): PluginDraft {
  return {
    name: "",
    slug: "",
    slugEdited: false,
    version: "1",
    description: "",
    parts: [newPart("skill", [])],
  };
}

/** True until the author types or loads anything. */
export function isUntouched(draft: PluginDraft): boolean {
  const [part, ...rest] = draft.parts;
  return (
    !draft.name &&
    !draft.slug &&
    !draft.description &&
    !rest.length &&
    part?.kind === "skill" &&
    part.id === "skill" &&
    !part.instructions
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fieldDrafts(raw: unknown): FieldDraft[] {
  return (Array.isArray(raw) ? raw : []).flatMap((entry): FieldDraft[] => {
    if (!entry || typeof entry !== "object") return [];
    const field = entry as Record<string, unknown>;
    const type = field.type === "number" || field.type === "date" ? field.type : "text";
    return [
      newField({
        label: text(field.label),
        id: text(field.id),
        idEdited: true,
        type,
        required: field.required !== false,
      }),
    ];
  });
}

/** A draft from a manifest: one already published, or JSON an author pasted. */
export function draftFromManifest(manifest: unknown, slug: string, version: number): PluginDraft {
  const source = (manifest && typeof manifest === "object" ? manifest : {}) as Record<
    string,
    unknown
  >;
  const rawParts = Array.isArray(source.parts) ? source.parts : [];
  const parts = rawParts.flatMap((raw): PartDraft[] => {
    if (!raw || typeof raw !== "object") return [];
    const part = raw as Record<string, unknown>;
    partKeys += 1;
    const key = partKeys;
    if (part.kind === "skill")
      return [{ key, kind: "skill", id: text(part.id), instructions: text(part.instructions) }];
    if (part.kind === "mcp")
      return [{ key, kind: "mcp", id: text(part.id), endpoint: text(part.endpoint) }];
    if (part.kind === "app")
      return [
        {
          key,
          kind: "app",
          id: text(part.id),
          fields: fieldDrafts(part.fields),
          summaryField: text(part.summaryField),
        },
      ];
    return [];
  });
  return {
    name: text(source.name),
    slug,
    slugEdited: Boolean(slug),
    version: String(version),
    description: text(source.description),
    parts,
  };
}

/** Another author's published plugin as the start of a new one under an ID of the author's own. */
export function draftFromTemplate(
  template: RegistryVersion,
  mine: readonly RegistryVersion[],
): PluginDraft {
  const slug = slugFromName(`my ${template.slug}`);
  return draftFromManifest(template.manifest, slug, nextVersion(mine, slug));
}

/** Pasted JSON as a draft: a bare manifest, or a `{ slug, version, manifest }` submission. */
export function draftFromJson(json: string, current: PluginDraft): PluginDraft {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SyntaxError("Not a JSON object");
  const record = value as Record<string, unknown>;
  const wrapped = record.manifest && typeof record.manifest === "object";
  const slug = wrapped && typeof record.slug === "string" ? record.slug : current.slug;
  const version =
    wrapped && typeof record.version === "number" ? record.version : Number(current.version) || 1;
  const draft = draftFromManifest(wrapped ? record.manifest : record, slug, version);
  if (!draft.slug) draft.slug = slugFromName(draft.name);
  draft.slugEdited = Boolean(wrapped && typeof record.slug === "string") || current.slugEdited;
  return draft;
}

function partToInput(part: PartDraft) {
  if (part.kind === "skill")
    return { id: part.id.trim(), kind: "skill", instructions: part.instructions };
  if (part.kind === "mcp")
    return {
      id: part.id.trim(),
      kind: "mcp",
      transport: "streamable_http",
      endpoint: part.endpoint.trim(),
    };
  return {
    id: part.id.trim(),
    kind: "app",
    fields: part.fields.map(({ id, label, type, required }) => ({
      id: id.trim(),
      label,
      type,
      required,
    })),
    ...(part.summaryField ? { summaryField: part.summaryField } : {}),
  };
}

function draftToInput(draft: PluginDraft) {
  return {
    slug: draft.slug.trim(),
    version: draft.version.trim() === "" ? Number.NaN : Number(draft.version),
    manifest: {
      schemaVersion: 1,
      name: draft.name,
      description: draft.description,
      parts: draft.parts.map(partToInput),
    },
  };
}

export type DraftIssue = { path: readonly PropertyKey[]; message: string; code?: string };

/** The draft checked against the registry's own submit contract. */
export function checkDraft(
  draft: PluginDraft,
): { ok: true; input: SubmitInput } | { ok: false; issues: DraftIssue[] } {
  const parsed = submitSchema.safeParse(draftToInput(draft));
  if (parsed.success) return { ok: true, input: parsed.data as SubmitInput };
  const seen = new Set<string>();
  const issues = parsed.error.issues.filter((issue) => {
    const key = issue.path.map(String).join(".");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ok: false, issues };
}

export function manifestJson(draft: PluginDraft): string {
  return JSON.stringify(draftToInput(draft).manifest, null, 2);
}

/** The calorie diary example plugin, for authors to start from and adapt. */
export const CALORIE_DIARY_MANIFEST: RegistryManifest = {
  schemaVersion: 1,
  name: "Calorie diary",
  description: "Log meals and see the total calories for a day.",
  parts: [
    {
      kind: "app",
      id: "meals",
      fields: [
        { id: "date", label: "Date", type: "date", required: true },
        { id: "meal", label: "Meal", type: "text", required: true },
        { id: "kcal", label: "Calories (kcal)", type: "number", required: true },
      ],
      summaryField: "kcal",
    },
  ],
};

/** The example as a new draft whose ID follows its name, clear of the bundled plugin's ID. */
export function calorieDiaryDraft(mine: readonly RegistryVersion[]): PluginDraft {
  const slug = slugFromName(CALORIE_DIARY_MANIFEST.name);
  return {
    ...draftFromManifest(CALORIE_DIARY_MANIFEST, slug, nextVersion(mine, slug)),
    slugEdited: false,
  };
}
