import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
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

/** Checks an app folder the way the product checks an app: `app.json` and its entry file. */
export async function checkAppFolder(folder: string): Promise<AppCheck> {
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
  let source: string;
  try {
    source = normalizeAppText(await readFile(await appFile(root, parsed.manifest.entry), "utf8"));
    if (parsed.manifest.icon) await appFile(root, parsed.manifest.icon);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  return checkApp({ manifest: parsed.manifest, source });
}
