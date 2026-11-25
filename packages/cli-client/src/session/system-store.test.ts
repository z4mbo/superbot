import { describe, expect, it } from "vitest";
import { isNoSystemStore, keychainStore, NoSystemStoreError } from "./system-store.js";

describe("system store", () => {
  it("falls back only when no credential store can be reached", () => {
    expect(isNoSystemStore(new Error("Platform failure: no secret service"))).toBe(true);
    expect(isNoSystemStore(new Error("Couldn't access platform storage: locked"))).toBe(true);
    expect(isNoSystemStore(new Error("No matching credential found"))).toBe(false);
    expect(isNoSystemStore(new Error("Entry is matched by 2 credentials: []"))).toBe(false);
    expect(
      isNoSystemStore(
        new Error("Value of 'password' is longer than the platform limit of 9 chars"),
      ),
    ).toBe(false);
    expect(isNoSystemStore("Platform failure: not an error")).toBe(false);
  });

  it("reports an unsupported platform as an error rather than falling back", async () => {
    const store = keychainStore("aix");
    const error = await store.get("service", "account").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NoSystemStoreError);
  });
});
