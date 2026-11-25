import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RegistryManifest } from "@rakazo/plugin-sdk/registry";
import {
  bounded,
  isPluginSlug,
  normalizeRegistryManifest,
  readRegistryManifest,
} from "@rakazo/plugin-sdk/registry";
import { CommandError, withContext } from "../cli/errors.js";

/** A manifest file as the registry would store it. `file` is resolved from `cwd` and shown as given. */
export async function readManifestFile(file: string, cwd: string): Promise<RegistryManifest> {
  try {
    return normalizeRegistryManifest(readRegistryManifest(await readFile(path.resolve(cwd, file))));
  } catch (error) {
    throw withContext(`Reading registry manifest ${file}`, error);
  }
}

export function checkSlug(value: string): void {
  if (!isPluginSlug(value)) {
    throw new CommandError(
      "Use 1 to 64 lowercase ASCII letters or digits separated by single hyphens",
    );
  }
}

/** `value` trimmed as the registry trims it, refused when empty or longer than `max`. */
export function trimText(value: string, field: string, max: number): string {
  const trimmed = bounded(value, max);
  if (typeof trimmed !== "string") {
    throw new CommandError(`${field} must contain 1 to ${max} UTF-16 code units after trimming`);
  }
  return trimmed;
}
