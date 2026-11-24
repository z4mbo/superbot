import { readStoredString, writeStoredString } from "./stored-preference";

export const BOTS_SIDEBAR_DEFAULT_WIDTH = 280;
export const BOTS_SIDEBAR_MIN_WIDTH = 240;
export const BOTS_SIDEBAR_MAX_WIDTH = 480;
const MIN_CHAT_WIDTH = 320;

export function botsSidebarWidthStorageKey(userId: string | null | undefined): string | null {
  return userId ? `rakazo:bots-sidebar-width:${userId}` : null;
}

export function maximumBotsSidebarWidth(viewportWidth: number): number {
  return Math.max(
    BOTS_SIDEBAR_MIN_WIDTH,
    Math.min(BOTS_SIDEBAR_MAX_WIDTH, viewportWidth - MIN_CHAT_WIDTH),
  );
}

export function clampBotsSidebarWidth(width: number, maximum = BOTS_SIDEBAR_MAX_WIDTH) {
  return Math.max(BOTS_SIDEBAR_MIN_WIDTH, Math.min(maximum, width));
}

export function readBotsSidebarWidth(userId: string | null | undefined): number {
  const key = botsSidebarWidthStorageKey(userId);
  if (!key) return BOTS_SIDEBAR_DEFAULT_WIDTH;
  const saved = Number(readStoredString(key));
  return Number.isFinite(saved) && saved >= BOTS_SIDEBAR_MIN_WIDTH
    ? clampBotsSidebarWidth(saved)
    : BOTS_SIDEBAR_DEFAULT_WIDTH;
}

export function writeBotsSidebarWidth(userId: string | null | undefined, width: number): void {
  const key = botsSidebarWidthStorageKey(userId);
  if (!key || !Number.isFinite(width)) return;
  writeStoredString(key, String(clampBotsSidebarWidth(width)));
}
