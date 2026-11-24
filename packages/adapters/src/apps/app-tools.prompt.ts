/** What find_apps answers when nothing matches, so the bot neither guesses an app nor retries. */
export function noAppsFound(query: string | undefined): string {
  return query?.trim()
    ? "No installed app matches. The user can add apps in Integrations."
    : "No apps are installed in this Space. The user can add apps in Integrations.";
}

/** What a tool given an app_id answers when this person has no such app installed here. */
export const APP_NOT_INSTALLED = "No installed app with that app_id here. find_apps lists them.";
