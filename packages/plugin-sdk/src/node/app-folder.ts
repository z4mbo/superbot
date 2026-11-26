import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AppManifest } from "@rakazo/contracts";
import { APP_MANIFEST_FILE } from "@rakazo/contracts";
import type { AppCheck } from "../check/check-app.js";
import { checkApp } from "../check/check-app.js";
import { parseAppManifestText } from "../manifest/manifest.js";

/** Text as the check reads it on every system: no byte-order mark, LF line ends. */
export function normalizeAppText(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/**
 * A file inside the app folder, named with the exact case the manifest uses. Windows and macOS
 * open `App.jsx` for `app.jsx`, Linux does not, so a case mismatch fails on every system alike.
 * A link that leads out of the folder is refused too.
 */
async function appFile(root: string, relative: string): Promise<string> {
  const segments = relative.split("/");
  let at = root;
  for (const segment of segments) {
    let names: string[];
    try {
      names = await readdir(at);
    } catch {
      throw new Error(`${relative} was not found in the app folder.`);
    }
    if (!names.includes(segment)) {
      const near = names.find((name) => name.toLowerCase() === segment.toLowerCase());
      throw new Error(
        near
          ? `${relative}: the folder has "${near}"; names must match exactly, including case.`
          : `${relative} was not found in the app folder.`,
      );
    }
    at = path.join(at, segment);
  }
  const real = await realpath(at);
  const inside = path.relative(root, real);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside))
    throw new Error(`${relative} leads outside the app folder.`);
  return real;
}

/** An app folder's files as the check and a publish read them. */
export type AppFolderFiles = {
  manifestText: string;
  source: string;
  server?: string;
  icon?: Buffer;
};

/**
 * Reads the files an app folder's manifest names: the entry, the server file and the icon. A
 * missing file, a case mismatch or a link out of the folder is an error naming the file.
 */
export async function readAppFolder(
  folder: string,
): Promise<
  | { ok: true; root: string; manifest: AppManifest; files: AppFolderFiles }
  | { ok: false; errors: string[] }
> {
  let root: string;
  try {
    root = await realpath(folder);
  } catch {
    return { ok: false, errors: [`${folder} is not a folder.`] };
  }
  let manifestText: string;
  try {
    manifestText = await readFile(await appFile(root, APP_MANIFEST_FILE), "utf8");
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  const parsed = parseAppManifestText(manifestText);
  if (!parsed.ok) return parsed;
  const { manifest } = parsed;
  try {
    const source = normalizeAppText(await readFile(await appFile(root, manifest.entry), "utf8"));
    const server = manifest.server
      ? normalizeAppText(await readFile(await appFile(root, manifest.server), "utf8"))
      : undefined;
    const icon = manifest.icon ? await readFile(await appFile(root, manifest.icon)) : undefined;
    return {
      ok: true,
      root,
      manifest,
      files: {
        manifestText,
        source,
        ...(server !== undefined ? { server } : {}),
        ...(icon ? { icon } : {}),
      },
    };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Checks an app folder the way the product checks an app: `app.json`, its entry file and its
 * server file when it has one.
 */
export async function checkAppFolder(folder: string): Promise<AppCheck> {
  const read = await readAppFolder(folder);
  if (!read.ok) return read;
  return checkApp({
    manifest: read.manifest,
    source: read.files.source,
    server: read.files.server,
  });
}
