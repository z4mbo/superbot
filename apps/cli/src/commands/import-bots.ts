import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Client } from "@rakazo/cli-client";
import { CommandError, withContext } from "../output/errors.js";
import { terminalText } from "../output/text.js";
import type { Io } from "../terminal/io.js";
import { line } from "../terminal/io.js";
import { resolveSpace } from "./workspaces.js";

const CONTROL = /\p{Cc}/u;

export async function readRoster(file: string): Promise<string[]> {
  let contents: Buffer;
  try {
    contents = await readFile(file);
  } catch (error) {
    throw withContext(`Read roster ${file}`, error);
  }
  return parseRoster(contents);
}

/** The names in a roster file, trimmed, each once in its first spelling and order. */
export function parseRoster(contents: Uint8Array): string[] {
  let roster: unknown;
  try {
    roster = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
  } catch (error) {
    throw withContext("Read roster JSON", error);
  }
  const entries =
    typeof roster === "object" && roster !== null && !Array.isArray(roster)
      ? (roster as { names?: unknown }).names
      : undefined;
  if (!Array.isArray(entries)) throw new CommandError("Expected a JSON object with a names array");
  const names: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry: unknown, index) => {
    if (typeof entry !== "string") throw new CommandError(`Name ${index + 1} must be text`);
    const name = entry.trim();
    // The server counts UTF-16 code units, as string length does.
    if (name === "" || name.length > 80 || CONTROL.test(name)) {
      throw new CommandError(`Name ${index + 1} must be one line with 1 to 80 UTF-16 units`);
    }
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  });
  return names;
}

/** The creation key that makes importing the same name twice, or concurrently, create one bot. */
export function rosterKey(name: string): string {
  return `superbot:roster:${createHash("sha256").update(name.toLowerCase()).digest("hex")}`;
}

/** Creates the roster's missing names in the destination Space; a dry run only lists them. */
export async function importBots(
  io: Io,
  client: Client,
  destination: string,
  names: string[],
  dryRun: boolean,
): Promise<void> {
  const space = await resolveSpace(client, destination);
  const active = await client.rpc("bots/list", space.id, {});
  const archived = await client.rpc("bots/listArchived", space.id, {});
  const existing = new Set([...active, ...archived].map((bot) => bot.name.trim().toLowerCase()));
  const missing = names.filter((name) => !existing.has(name.toLowerCase()));
  line(
    io,
    `Space ${terminalText(space.name)} (${terminalText(space.id)}): ${names.length - missing.length} existing, ${missing.length} to import.`,
  );
  for (const name of missing) {
    if (dryRun) {
      line(io, `  ${terminalText(name)}`);
      continue;
    }
    try {
      await client.rpc("bots/create", space.id, { name, spawnKey: rosterKey(name) });
    } catch (error) {
      throw withContext(`Import ${terminalText(name)}. Rerun the command to resume.`, error);
    }
  }
  if (!dryRun) line(io, "Roster import complete.");
}
