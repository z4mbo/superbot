import type { AppAction, AppManifest, AppPermission } from "@rakazo/contracts";
import { APP_MANIFEST_FILE, appManifestSchema } from "@rakazo/contracts";

export type ManifestParse = { ok: true; manifest: AppManifest } | { ok: false; errors: string[] };

/** Problems come back one per line, each naming the field, so a bot or a person can fix them. */
export function parseAppManifest(value: unknown): ManifestParse {
  const parsed = appManifestSchema.safeParse(value);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const at = issue.path.length ? issue.path.join(".") : APP_MANIFEST_FILE;
      return `${at}: ${issue.message}`;
    }),
  };
}

/** `app.json` text as written on any system: a byte-order mark and CRLF line ends are fine. */
export function parseAppManifestText(text: string): ManifestParse {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return {
      ok: false,
      errors: [
        `${APP_MANIFEST_FILE}: not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
      ],
    };
  }
  return parseAppManifest(value);
}

export function hasPermission(
  manifest: Pick<AppManifest, "permissions">,
  permission: AppPermission,
) {
  return manifest.permissions.includes(permission);
}

export function findAction<Action extends { name: string }>(
  manifest: { actions: readonly Action[] },
  name: unknown,
): Action | undefined {
  return typeof name === "string"
    ? manifest.actions.find((action) => action.name === name)
    : undefined;
}

/** An action's inputs as the JSON Schema a bot's tool call fills in. */
export function actionInputJsonSchema(action: AppAction): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(action.input)) {
    const { required: needed, ...rest } = field;
    if (needed) required.push(name);
    if (rest.type === "number") {
      const { integer, min, max, ...number } = rest;
      properties[name] = {
        ...number,
        ...(integer ? { type: "integer" } : {}),
        ...(min !== undefined ? { minimum: min } : {}),
        ...(max !== undefined ? { maximum: max } : {}),
      };
    } else properties[name] = rest;
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * What the viewer and a bot are told about an app: its permissions and its actions with their
 * inputs. Effects stay on the server, where they run.
 */
export type AppSurface = {
  permissions: AppPermission[];
  actions: { name: string; description: string; input: AppAction["input"] }[];
  initialState: Record<string, unknown>;
};

export function appSurface(manifest: AppManifest): AppSurface {
  return {
    permissions: [...manifest.permissions],
    actions: manifest.actions.map(({ name, description, input }) => ({ name, description, input })),
    initialState: manifest.initialState,
  };
}
