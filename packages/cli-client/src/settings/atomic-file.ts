import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Replaces `file` in one step: the text goes to a temporary file beside it, readable only by this
 * user, which then takes its name. The mode is set again so a saved file never widens it.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const pending = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(pending, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
    if (process.platform !== "win32") await chmod(pending, 0o600);
    await rename(pending, file);
  } catch (error) {
    await rm(pending, { force: true });
    throw error;
  }
}

/** The file's text, or undefined when it does not exist. Any other failure is thrown. */
export async function readOptionalFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** A JSON object whose values are all strings, as the settings files hold. */
export function parseStringMap(text: string): Map<string, string> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  const entries = Object.entries(parsed);
  if (entries.some(([, value]) => typeof value !== "string")) {
    throw new Error("Expected only string values");
  }
  return new Map(entries as [string, string][]);
}

/** Compact JSON with sorted keys, the format earlier releases wrote. */
export function stringifyStringMap(map: Map<string, string>): string {
  const sorted = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(sorted));
}
