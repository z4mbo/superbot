import type { ActiveWorkspace } from "./use-workspaces";

/**
 * Which workspace this browser is connected to. Small and free of the account service, because
 * every API request reads it, in both builds.
 */
export const ACTIVE_WORKSPACE_KEY = "superbot:cloud:active-workspace";
/** Asks the workspace list to probe the active workspace now, e.g. after a refused request. */
export const RECHECK_ACTIVE_WORKSPACE_EVENT = "superbot:cloud:recheck-active-workspace";

export type ActiveWorkspaceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): ActiveWorkspaceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readActiveWorkspace(
  storage: ActiveWorkspaceStorage | null = browserStorage(),
): ActiveWorkspace | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(ACTIVE_WORKSPACE_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { id, url } = value as Record<string, unknown>;
    return typeof id === "string" && id && typeof url === "string" && url ? { id, url } : null;
  } catch {
    return null;
  }
}

/** False when the browser keeps no storage, so the choice cannot outlive the page. */
export function writeActiveWorkspace(
  value: ActiveWorkspace | null,
  storage: ActiveWorkspaceStorage | null = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    if (value) storage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(value));
    else storage.removeItem(ACTIVE_WORKSPACE_KEY);
    return true;
  } catch {
    return false;
  }
}

let startup: { value: ActiveWorkspace | null } | undefined;

/**
 * The workspace this page was loaded for. Read once: another tab switching workspace must not move
 * this page's requests to a different server under it, so switching always reloads the page.
 */
export function startupActiveWorkspace(): ActiveWorkspace | null {
  startup ??= { value: readActiveWorkspace() };
  return startup.value;
}

export function requestActiveWorkspaceRecheck(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(RECHECK_ACTIVE_WORKSPACE_EVENT));
  }
}
