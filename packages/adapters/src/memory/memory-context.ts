import type { AdapterContext, MemoryStore } from "@rakazo/adapter-kit";
import { DAILY_NOTES_PREFIX, dailyNoteDateOf, readRecentDailyNotes } from "./daily-notes.js";
import type { MemoryPromptDocument } from "./memory-context.prompt.js";
import { AGENT_MEMORY_MAX_BYTES, buildAgentMemoryPrompt } from "./memory-context.prompt.js";

export async function loadAgentMemoryContext(
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
  maxBytes = AGENT_MEMORY_MAX_BYTES,
  now = new Date(),
): Promise<string | undefined> {
  const documents = await readAgentMemory(memory, botId, context, now);
  return buildAgentMemoryPrompt(documents, maxBytes).text;
}

/**
 * The bot's own memory plus the user's, in the shape the prompt builder reads.
 * Of the bot's daily notes only the recent ones come along; older ones stay stored.
 */
export async function readAgentMemory(
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
  now = new Date(),
): Promise<MemoryPromptDocument[]> {
  const [botMemory, dailyNotes, userMemory] = await Promise.all([
    memory.read({ scope: "bot", botId, excludePathPrefix: DAILY_NOTES_PREFIX }, context),
    readRecentDailyNotes(memory, botId, context, now),
    memory.read({ scope: "user" }, context),
  ]);
  return [
    ...botMemory.documents
      .filter((document) => !dailyNoteDateOf(document.path))
      .map((document) => ({ ...document, scope: "bot" as const })),
    ...dailyNotes.map((document) => ({ ...document, scope: "bot" as const })),
    ...userMemory.documents.map((document) => ({ ...document, scope: "user" as const })),
  ];
}
