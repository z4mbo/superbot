import { rm } from "node:fs/promises";
import {
  parseStringMap,
  readOptionalFile,
  stringifyStringMap,
  writeFileAtomic,
} from "../settings/atomic-file.js";

/**
 * `sessions.json` holds one signed session per server, readable only by this user. It is used only
 * when the computer has no system credential store, such as a Linux server without a Secret Service.
 * An unreadable file is an error rather than an empty store, so it is never overwritten.
 */
export async function readTokens(file: string): Promise<Map<string, string>> {
  const text = await readOptionalFile(file);
  return text === undefined ? new Map() : parseStringMap(text);
}

export async function saveToken(file: string, server: string, token: string): Promise<void> {
  const tokens = await readTokens(file);
  tokens.set(server, token);
  await writeFileAtomic(file, stringifyStringMap(tokens));
}

/** Removes the server's session; the file goes once it holds none. */
export async function forgetToken(file: string, server: string): Promise<void> {
  const tokens = await readTokens(file);
  if (!tokens.delete(server)) return;
  if (tokens.size === 0) {
    await rm(file, { force: true });
    return;
  }
  await writeFileAtomic(file, stringifyStringMap(tokens));
}
