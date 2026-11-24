import type { AdapterContext, MemorySnapshot, MemoryStore } from "@rakazo/adapter-kit";
import { byteLength } from "@rakazo/core";
import { appendMemoryFact } from "./memory-tools.js";

/**
 * Daily notes are a bot's own dated memory documents, one per UTC day at
 * `daily/YYYY-MM-DD.md`. A bot only ever adds to them, so the day's earlier
 * entries stay as written. Every note stays stored; the prompt carries only the
 * recent ones.
 */
export const DAILY_NOTES_PREFIX = "daily/";
/** How many days of notes reach the prompt: today and yesterday. */
export const DAILY_NOTE_DAYS_IN_PROMPT = 2;
/** What a bot may write to one day's note. */
export const DAILY_NOTE_MAX_BYTES = 8 * 1024;

const DAILY_NOTE_PATH = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar date, as `YYYY-MM-DD`. */
export function dailyNoteDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function dailyNotePath(now: Date): string {
  return `${DAILY_NOTES_PREFIX}${dailyNoteDate(now)}.md`;
}

/** The date a daily note's path names, or undefined for any other document. */
export function dailyNoteDateOf(path: string): string | undefined {
  return DAILY_NOTE_PATH.exec(path)?.[1];
}

/** The paths of the notes from the last `days` days, newest first. */
export function recentDailyNotePaths(now: Date, days = DAILY_NOTE_DAYS_IN_PROMPT): string[] {
  return Array.from({ length: days }, (_, back) =>
    dailyNotePath(new Date(now.getTime() - back * DAY_MS)),
  );
}

/** A bot's recent daily notes, newest first; days without a note are skipped. */
export async function readRecentDailyNotes(
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
  now: Date,
  days = DAILY_NOTE_DAYS_IN_PROMPT,
): Promise<MemorySnapshot["documents"]> {
  const notes = await Promise.all(
    recentDailyNotePaths(now, days).map(async (path) => {
      const snapshot = await memory.read({ scope: "bot", botId, path }, context);
      return snapshot.documents.find((document) => document.path === path);
    }),
  );
  return notes.filter((note) => note !== undefined);
}

export const DAILY_NOTE_EDIT_ERROR =
  "A daily note keeps its entries as written. Leave out old_text, or leave out daily to change a fact in your memory.";

/** Adds an entry to the end of a day's note, refusing one that would pass the cap. */
export function appendDailyNote(
  existing: string,
  entry: string,
  maxBytes = DAILY_NOTE_MAX_BYTES,
): { content: string } | { error: string } {
  const content = appendMemoryFact(existing, entry);
  if (content !== existing && byteLength(content) > maxBytes) {
    return {
      error: `Today's note is full (${maxBytes} bytes). Save what still matters with remember without daily.`,
    };
  }
  return { content };
}
