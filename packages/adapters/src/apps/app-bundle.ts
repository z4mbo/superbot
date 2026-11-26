import { createHash } from "node:crypto";
import type { AppFile, AppManifest } from "@rakazo/contracts";
import { APP_ICON_MAX_BYTES, appManifestSchema, appRelativePathProblem } from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { checkApp } from "@rakazo/plugin-sdk";
import { appFunctionRuntime } from "./functions/app-function-runtime.js";

/** An app version that passed every check, ready to store. */
export type CheckedAppBundle = {
  manifest: AppManifest;
  source: string;
  /** The source compiled for the page viewer. */
  code: string;
  /** The server file, for the function sandbox; null when the app has none. */
  server: string | null;
  icon: string | null;
  digest: string;
};

const MAX_REPORTED = 20;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const IMAGE_TYPES: Record<string, { type: string; matches: (bytes: Buffer) => boolean }> = {
  ".png": {
    type: "image/png",
    matches: (bytes) =>
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  ".jpg": { type: "image/jpeg", matches: (bytes) => jpeg(bytes) },
  ".jpeg": { type: "image/jpeg", matches: (bytes) => jpeg(bytes) },
  ".webp": {
    type: "image/webp",
    matches: (bytes) =>
      bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP",
  },
};

function jpeg(bytes: Buffer): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * The same name on every system: Windows and macOS compare file names without case and macOS
 * also without Unicode normalization, so two files that differ only that way collide there.
 */
function folderKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * sha256 over what runs and what was consented to, in a key order the database cannot change, so
 * a stored version edited after it was published no longer matches what installs pinned. The
 * server file is covered when there is one; a version without one hashes as it always did.
 */
export function appReleaseDigest(release: {
  manifest: unknown;
  source: string;
  code: string;
  icon: string | null;
  server?: string | null;
}): string {
  const { manifest, source, code, icon, server } = release;
  // As the database hands it back: a key left undefined is not stored.
  const stored: unknown = JSON.parse(JSON.stringify(manifest));
  const hash = createHash("sha256").update(
    stableJsonValue({
      manifest: stored,
      source,
      code,
      icon,
      ...(server !== null && server !== undefined ? { server } : {}),
    }),
  );
  return `sha256:${hash.digest("hex")}`;
}

function iconDataUrl(path: string, file: AppFile, errors: string[]): string | null {
  const kind = IMAGE_TYPES[path.slice(path.lastIndexOf(".")).toLowerCase()];
  if (!kind) return null;
  if (file.encoding !== "base64" || !BASE64.test(file.content)) {
    errors.push(`${path}: send the icon as base64.`);
    return null;
  }
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.byteLength > APP_ICON_MAX_BYTES) {
    errors.push(
      `${path}: the icon is ${bytes.byteLength} bytes; the limit is ${APP_ICON_MAX_BYTES}.`,
    );
    return null;
  }
  if (!kind.matches(bytes)) {
    errors.push(`${path}: the file is not the image its name says.`);
    return null;
  }
  return `data:${kind.type};base64,${file.content}`;
}

/**
 * Checks an app version as its author sent it: the manifest against the shared schema, every
 * path for a folder that unpacks the same way on Windows, macOS and Linux, the entry and server
 * file with the app check (which compiles the entry and parses the server file; nothing runs
 * here), and the icon's bytes. Only the files the manifest names are accepted.
 */
export function checkAppBundle(input: {
  manifest: unknown;
  files: readonly AppFile[];
}): { ok: true; bundle: CheckedAppBundle } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const files = new Map<string, AppFile>();
  const seen = new Set<string>();
  for (const file of input.files) {
    const problem = appRelativePathProblem(file.path);
    if (problem) {
      errors.push(`Path ${JSON.stringify(file.path.slice(0, 200))} ${problem}.`);
      continue;
    }
    const key = folderKey(file.path);
    if (seen.has(key)) {
      errors.push(`${file.path}: another file has the same name on Windows and macOS.`);
      continue;
    }
    seen.add(key);
    files.set(file.path, file);
  }
  const parsed = appManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.map(String).join(".");
      errors.push(`app.json${at ? ` ${at}` : ""}: ${issue.message}`);
    }
    return { ok: false, errors: errors.slice(0, MAX_REPORTED) };
  }
  const manifest = parsed.data;
  const named = new Set([
    manifest.entry,
    ...(manifest.server ? [manifest.server] : []),
    ...(manifest.icon ? [manifest.icon] : []),
  ]);
  for (const path of files.keys())
    if (!named.has(path)) errors.push(`${path}: app.json does not use this file; leave it out.`);
  const entry = files.get(manifest.entry);
  const serverFile = manifest.server ? files.get(manifest.server) : undefined;
  let server: string | null = null;
  if (manifest.server) {
    if (!serverFile) errors.push(`${manifest.server}: the server file is missing.`);
    else if (serverFile.encoding !== "utf8")
      errors.push(`${manifest.server}: send the server file as text.`);
    else server = serverFile.content;
  }
  let code = "";
  if (!entry) errors.push(`${manifest.entry}: the entry file is missing.`);
  else if (entry.encoding !== "utf8") errors.push(`${manifest.entry}: send the entry as text.`);
  else if (!manifest.server || server !== null) {
    // Compiled with the app's names and surface, so its controls work where it is installed.
    const check = checkApp({ manifest, source: entry.content, server: server ?? undefined });
    if (check.ok) code = check.code;
    else
      errors.push(
        ...check.errors.map((error) =>
          manifest.server && error.startsWith(manifest.server)
            ? error
            : `${manifest.entry}: ${error}`,
        ),
      );
  }
  let icon: string | null = null;
  if (manifest.icon) {
    const file = files.get(manifest.icon);
    if (!file) errors.push(`${manifest.icon}: the icon file is missing.`);
    else icon = iconDataUrl(manifest.icon, file, errors);
  }
  if (errors.length || !entry) return { ok: false, errors: errors.slice(0, MAX_REPORTED) };
  return {
    ok: true,
    bundle: {
      manifest,
      source: entry.content,
      code,
      server,
      icon,
      digest: appReleaseDigest({ manifest, source: entry.content, code, icon, server }),
    },
  };
}

/**
 * Loads a server file in the function sandbox and checks that every function an action runs is
 * one: the static check knows only that the names are exported.
 */
export async function appServerProblems(
  manifest: AppManifest,
  server: string | null,
): Promise<string[]> {
  if (!manifest.server || server === null) return [];
  const loaded = await (await appFunctionRuntime()).functions(server, manifest.server);
  if (!loaded.ok) return [loaded.error];
  return manifest.actions.flatMap((action) =>
    action.run === undefined || loaded.names.includes(action.run)
      ? []
      : [`${manifest.server}: ${action.run}, which ${action.name} runs, is not a function.`],
  );
}
