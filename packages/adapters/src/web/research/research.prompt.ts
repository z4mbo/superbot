/** Why a research tool cannot run: the person has no key saved for its provider. */
export function researchKeyMissingReason(toolName: string): string {
  return `${toolName} needs the person's own key, saved in Settings. Use web_search and web_fetch instead, or ask the person to add the key in Settings.`;
}
