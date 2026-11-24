import { describe, expect, it, vi } from "vitest";
import {
  BOTS_SIDEBAR_DEFAULT_WIDTH,
  botsSidebarWidthStorageKey,
  clampBotsSidebarWidth,
  maximumBotsSidebarWidth,
  readBotsSidebarWidth,
  writeBotsSidebarWidth,
} from "./bots-sidebar-width-pref";

describe("bots sidebar width preference", () => {
  it("remembers expanded widths independently for each user and clamps invalid limits", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    try {
      expect(readBotsSidebarWidth("first")).toBe(BOTS_SIDEBAR_DEFAULT_WIDTH);
      writeBotsSidebarWidth("first", 420);
      expect(readBotsSidebarWidth("first")).toBe(420);
      expect(readBotsSidebarWidth("second")).toBe(BOTS_SIDEBAR_DEFAULT_WIDTH);
      writeBotsSidebarWidth("second", 900);
      expect(readBotsSidebarWidth("second")).toBe(480);
      store.set(botsSidebarWidthStorageKey("first")!, "NaN");
      expect(readBotsSidebarWidth("first")).toBe(BOTS_SIDEBAR_DEFAULT_WIDTH);
      expect(maximumBotsSidebarWidth(768)).toBe(448);
      expect(clampBotsSidebarWidth(480, maximumBotsSidebarWidth(768))).toBe(448);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows resizing without storage access", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("Storage unavailable");
      },
      setItem() {
        throw new Error("Storage unavailable");
      },
    });
    try {
      expect(readBotsSidebarWidth("user")).toBe(BOTS_SIDEBAR_DEFAULT_WIDTH);
      expect(() => writeBotsSidebarWidth("user", 400)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
