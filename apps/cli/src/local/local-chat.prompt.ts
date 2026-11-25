/** A turn in the history a local model is given, in the chat format its CLI reads. */
export type LocalHistoryTurn = { role: "user" | "assistant"; content: string };

/**
 * The prompt for a local model: the new message alone in a chat without messages, otherwise the
 * recent text history with the new message last.
 */
export function localConversationPrompt(
  chatIsEmpty: boolean,
  history: LocalHistoryTurn[],
  input: string,
): string {
  if (chatIsEmpty) return input;
  const messages = [...history, { role: "user", content: input }];
  return `Continue the conversation. Reply to the final user message.\n${JSON.stringify(messages)}`;
}

/** Puts the agent's saved instructions ahead of the conversation, as data. */
export function withAgentInstructions(instructions: string, conversation: string): string {
  if (instructions.trim() === "") return conversation;
  return `Saved working instructions for this agent (JSON string): ${JSON.stringify(instructions)}\n\n${conversation}`;
}
