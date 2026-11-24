import * as z from "zod";

/**
 * Named documents in a bot's own memory, each at a well-known path: who the bot is
 * (identity), how it comes across (soul) and, for each person it works with, what it
 * knows about them (profile).
 */
export const MemoryLayerSchema = z.enum(["identity", "soul", "profile"]);
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>;

export const IDENTITY_MEMORY_PATH = "IDENTITY.md";
export const SOUL_MEMORY_PATH = "SOUL.md";
const PROFILE_FOLDER = "people/";
const PROFILE_PATH = /^people\/([A-Za-z0-9_-]+)\.md$/;

/** One profile per person, named by their user id, which is never shown as a title. */
export function profileMemoryPath(userId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error("A profile needs a plain user id.");
  return `${PROFILE_FOLDER}${userId}.md`;
}

/** The person a profile path belongs to, or undefined for any other path. */
export function profileMemoryPerson(path: string): string | undefined {
  return PROFILE_PATH.exec(path)?.[1];
}

/** Which layer a bot memory document is, from its path alone. */
export function memoryLayerOf(path: string): MemoryLayer | undefined {
  if (path === IDENTITY_MEMORY_PATH) return "identity";
  if (path === SOUL_MEMORY_PATH) return "soul";
  // Everything in the folder counts, so a stray name there is never read as general memory.
  if (path.startsWith(PROFILE_FOLDER)) return "profile";
  return undefined;
}

/** Where a layer lives in a bot's memory; a profile is the given person's. */
export function memoryLayerPath(layer: MemoryLayer, personId: string): string {
  if (layer === "identity") return IDENTITY_MEMORY_PATH;
  if (layer === "soul") return SOUL_MEMORY_PATH;
  return profileMemoryPath(personId);
}
