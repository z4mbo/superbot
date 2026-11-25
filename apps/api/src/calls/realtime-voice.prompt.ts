/** Longest part of the bot's own instructions a realtime conversation carries. */
export const REALTIME_INSTRUCTIONS_MAX_CHARS = 12_000;

/**
 * What a realtime speech model is told: the bot's own instructions, then how to talk. The speech
 * model answers by itself, so it has none of the bot's tools or memory.
 */
export function realtimeVoiceInstructions(bot: {
  name: string;
  instructions: string;
  language?: string | null;
}): string {
  const own = bot.instructions.trim().slice(0, REALTIME_INSTRUCTIONS_MAX_CHARS);
  return [
    `You are ${bot.name}, talking with the user in a live voice conversation.`,
    own ? `Your instructions:\n${own}` : "",
    "Speak naturally in short replies. No markdown, lists, code or URLs.",
    "You cannot use tools or files during this conversation. When asked for something that needs them, say it will be done after the call.",
    bot.language
      ? `Speak in the language with the BCP-47 tag ${bot.language} unless the user asks for another.`
      : "Reply in the language the user speaks.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
