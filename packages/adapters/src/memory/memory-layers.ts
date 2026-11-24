import type { MemorySnapshot } from "@rakazo/adapter-kit";
import { memoryLayerOf, profileMemoryPerson } from "@rakazo/contracts";
import type { MemoryPromptDocument } from "./memory-context.prompt.js";

/**
 * The one person whose profile a run may read and write: the person the run acts for,
 * and only while they are part of the conversation (they own its thread or wrote in it).
 * Other people in a shared conversation get no profile, so a run never carries what the
 * bot knows about someone who did not ask. Runs that read no memory pass nothing here.
 */
export function conversationProfilePerson(conversation: {
  personId: string;
  threadUserId: string;
  authorUserIds: Iterable<string | null | undefined>;
}): string | undefined {
  const { personId, threadUserId } = conversation;
  if (!personId) return undefined;
  if (personId === threadUserId) return personId;
  for (const author of conversation.authorUserIds) if (author === personId) return personId;
  return undefined;
}

/**
 * Splits a bot's documents into its named layers and the rest of its memory. A profile is
 * kept only for a person in `people`; every other profile is dropped here, before anything
 * reaches a prompt. This is where a person's profile is kept out of other people's runs.
 */
export function botMemoryDocuments(
  snapshot: MemorySnapshot,
  people: readonly string[],
): MemoryPromptDocument[] {
  return snapshot.documents.flatMap((document) => {
    const layer = memoryLayerOf(document.path);
    if (!layer) return [{ ...document, scope: "bot" as const }];
    if (layer === "profile") {
      const person = profileMemoryPerson(document.path);
      if (!person || !people.includes(person)) return [];
    }
    return [{ ...document, scope: "bot" as const, layer }];
  });
}
