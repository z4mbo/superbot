import { describe, expect, it } from "vitest";
import {
  memoryLayerOf,
  memoryLayerPath,
  profileMemoryPath,
  profileMemoryPerson,
} from "./memory-layers.js";

describe("named memory layer paths", () => {
  it("gives each layer one well-known path, and each person their own profile", () => {
    expect(memoryLayerPath("identity", "ana")).toBe("IDENTITY.md");
    expect(memoryLayerPath("soul", "ana")).toBe("SOUL.md");
    expect(memoryLayerPath("profile", "ana")).toBe("people/ana.md");
    expect(profileMemoryPerson(profileMemoryPath("cm0abc_1-x"))).toBe("cm0abc_1-x");
  });

  it("reads a layer back from its path, and leaves other memory alone", () => {
    expect(memoryLayerOf("IDENTITY.md")).toBe("identity");
    expect(memoryLayerOf("SOUL.md")).toBe("soul");
    expect(memoryLayerOf("people/ana.md")).toBe("profile");
    // Anything in the profile folder is a profile, so it is never loaded as general memory.
    expect(memoryLayerOf("people/odd/name.txt")).toBe("profile");
    expect(profileMemoryPerson("people/odd/name.txt")).toBeUndefined();
    for (const path of ["MEMORY.md", "USER.md", "soul.md", "memory/2026-01-02.md"]) {
      expect(memoryLayerOf(path)).toBeUndefined();
    }
  });

  it("refuses an id that could leave the profile folder", () => {
    for (const id of ["", "../ana", "a/b", "ana.md"]) {
      expect(() => profileMemoryPath(id)).toThrow();
    }
  });
});
