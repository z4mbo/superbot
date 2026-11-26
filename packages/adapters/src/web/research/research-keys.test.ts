import { ClientError } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { researchKeyFakes } from "./research.test-support.js";
import {
  listResearchKeys,
  loadResearchKey,
  removeResearchKey,
  savedResearchTools,
  saveResearchKey,
} from "./research-keys.js";

const ALICE = { userId: "alice", spaceId: "space-a" };
const BOB = { userId: "bob", spaceId: "space-a" };

describe("research keys", () => {
  it("lists every provider from its descriptor, none saved at first", async () => {
    const { prisma } = researchKeyFakes();
    expect(await listResearchKeys(prisma, ALICE.userId)).toEqual([
      { id: "exa", label: "Exa", capability: "search", saved: false },
      { id: "firecrawl", label: "Firecrawl", capability: "page_read", saved: false },
    ]);
  });

  it("saves a sealed account-level key and never returns it", async () => {
    const fakes = researchKeyFakes();
    const listed = await saveResearchKey(fakes, ALICE, { provider: "exa", key: " fake-key-1 " });
    expect(listed.find((provider) => provider.id === "exa")?.saved).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("fake-key-1");
    expect(fakes.rows).toHaveLength(1);
    expect(fakes.rows[0]).toMatchObject({
      userId: "alice",
      spaceId: null,
      kind: "research-key:exa",
    });
    expect(fakes.rows[0]!.ciphertext).not.toContain("fake-key-1");
    expect(await loadResearchKey(fakes, ALICE.userId, "exa")).toBe("fake-key-1");
    expect(await savedResearchTools(fakes.prisma, ALICE.userId)).toEqual(new Set(["exa_search"]));
  });

  it("replaces the saved key and drops the old row", async () => {
    const fakes = researchKeyFakes();
    await saveResearchKey(fakes, ALICE, { provider: "firecrawl", key: "fake-old" });
    await saveResearchKey(fakes, ALICE, { provider: "firecrawl", key: "fake-new" });
    expect(fakes.rows).toHaveLength(1);
    expect(await loadResearchKey(fakes, ALICE.userId, "firecrawl")).toBe("fake-new");
    // An inline store is only told the old value is gone; nothing remote was written.
    expect(fakes.secrets.delete).toHaveBeenCalledTimes(1);
  });

  it("removes a key, and removing one that is not saved does nothing", async () => {
    const fakes = researchKeyFakes();
    await saveResearchKey(fakes, ALICE, { provider: "exa", key: "fake-key-1" });
    await saveResearchKey(fakes, ALICE, { provider: "firecrawl", key: "fake-key-2" });
    const listed = await removeResearchKey(fakes, ALICE, "exa");
    expect(listed.map((provider) => [provider.id, provider.saved])).toEqual([
      ["exa", false],
      ["firecrawl", true],
    ]);
    expect(await loadResearchKey(fakes, ALICE.userId, "exa")).toBeUndefined();
    await expect(removeResearchKey(fakes, ALICE, "exa")).resolves.toHaveLength(2);
    expect(await savedResearchTools(fakes.prisma, ALICE.userId)).toEqual(
      new Set(["firecrawl_scrape"]),
    );
  });

  it("keeps one account's key away from another account", async () => {
    const fakes = researchKeyFakes();
    await saveResearchKey(fakes, ALICE, { provider: "exa", key: "fake-key-1" });
    expect((await listResearchKeys(fakes.prisma, BOB.userId)).every((p) => !p.saved)).toBe(true);
    expect(await loadResearchKey(fakes, BOB.userId, "exa")).toBeUndefined();
    expect(await savedResearchTools(fakes.prisma, BOB.userId)).toEqual(new Set());
    await removeResearchKey(fakes, BOB, "exa");
    expect(await loadResearchKey(fakes, ALICE.userId, "exa")).toBe("fake-key-1");
  });

  it("ignores a Space-level row and a row sealed for another provider", async () => {
    const fakes = researchKeyFakes();
    await saveResearchKey(fakes, ALICE, { provider: "exa", key: "fake-key-1" });
    fakes.rows[0]!.kind = "research-key:firecrawl";
    expect(await loadResearchKey(fakes, ALICE.userId, "firecrawl")).toBeUndefined();
    fakes.rows[0]!.kind = "research-key:exa";
    fakes.rows[0]!.spaceId = "space-a";
    expect(await loadResearchKey(fakes, ALICE.userId, "exa")).toBeUndefined();
  });

  it("refuses an unknown provider and a key with spaces as client errors", async () => {
    const fakes = researchKeyFakes();
    await expect(
      saveResearchKey(fakes, ALICE, { provider: "other", key: "fake" }),
    ).rejects.toBeInstanceOf(ClientError);
    await expect(
      saveResearchKey(fakes, ALICE, { provider: "exa", key: "two words" }),
    ).rejects.toBeInstanceOf(ClientError);
    await expect(removeResearchKey(fakes, ALICE, "other")).rejects.toBeInstanceOf(ClientError);
    expect(fakes.secrets.put).not.toHaveBeenCalled();
  });
});
