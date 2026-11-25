import { describe, expect, it } from "vitest";
import {
  ACTIVE_WORKSPACE_KEY,
  readActiveWorkspace,
  writeActiveWorkspace,
} from "./active-workspace.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const blocked = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("SecurityError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("active workspace storage", () => {
  it("round-trips the chosen workspace and clears it", () => {
    const storage = memoryStorage();
    expect(readActiveWorkspace(storage)).toBeNull();
    expect(writeActiveWorkspace({ id: "w1", url: "https://a.example" }, storage)).toBe(true);
    expect(readActiveWorkspace(storage)).toEqual({ id: "w1", url: "https://a.example" });
    expect(writeActiveWorkspace(null, storage)).toBe(true);
    expect(storage.items.has(ACTIVE_WORKSPACE_KEY)).toBe(false);
  });

  it.each([
    ["not json"],
    ['"text"'],
    ["{}"],
    ['{"id":"","url":"https://a.example"}'],
    ['{"id":1}'],
  ])("reads %s as none", (value) => {
    expect(readActiveWorkspace(memoryStorage({ [ACTIVE_WORKSPACE_KEY]: value }))).toBeNull();
  });

  it("tolerates missing or blocked storage", () => {
    expect(readActiveWorkspace(null)).toBeNull();
    expect(readActiveWorkspace(blocked)).toBeNull();
    expect(writeActiveWorkspace({ id: "w1", url: "https://a.example" }, null)).toBe(false);
    expect(writeActiveWorkspace({ id: "w1", url: "https://a.example" }, blocked)).toBe(false);
  });
});
