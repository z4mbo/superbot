export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
export const SLACK_INSTALL_CALLBACK_PATH = "/messaging/slack/callback";

const BOT_CONVERSATION_PATH = /^\/app\/[A-Za-z0-9_-]+$/;

// A Space invite link, or an organization invitation's Join page.
const INVITE_PATH = /^\/(invite|join)\/[A-Za-z0-9_-]{1,200}$/;

export function isBotConversationLink(pathname: string, search: string): boolean {
  return BOT_CONVERSATION_PATH.test(pathname) && new URLSearchParams(search).has("threadId");
}

/** The page sign-in or sign-up may return to; anything else is ignored, so `next` can't redirect off the app. */
export function signInNext(next: string | null): string | null {
  if (!next) return null;
  const queryStart = next.indexOf("?");
  if (
    queryStart !== -1 &&
    isBotConversationLink(next.slice(0, queryStart), next.slice(queryStart))
  ) {
    return next;
  }
  // A connector sign-in started on another device lands here signed out; finish it after sign-in.
  if (
    next === "/workspaces" ||
    next === "/integrations/setup" ||
    next === "/admin/apps" ||
    // Sign-in links made before the app review page moved there.
    next === "/admin/plugins" ||
    next === "/admin/access" ||
    // The model-connection email opens the connect step.
    next === "/onboarding/model" ||
    // The agent-import email opens the import.
    next === "/app?import" ||
    next.startsWith(`${MCP_OAUTH_CALLBACK_PATH}?`) ||
    next.startsWith(`${SLACK_INSTALL_CALLBACK_PATH}?`) ||
    INVITE_PATH.test(next)
  ) {
    return next;
  }
  return null;
}

/** Where a new account starts: an invite it came for, otherwise onboarding. */
export function newAccountDestination(next: string | null): string {
  return next && INVITE_PATH.test(next) ? next : "/workspaces";
}
