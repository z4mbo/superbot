import { createRouterClient } from "@orpc/server";
import type * as Adapters from "@rakazo/adapters";
import { listResearchKeys, removeResearchKey, saveResearchKey } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type * as Db from "@rakazo/db";
import { recordSecurityEvent } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

const saved = [{ id: "search-provider", label: "Search Co", capability: "search", saved: true }];

vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof Adapters>()),
  listResearchKeys: vi.fn(async () => saved),
  saveResearchKey: vi.fn(async () => saved),
  removeResearchKey: vi.fn(async () => saved),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  recordSecurityEvent: vi.fn(async () => undefined),
}));

const actor: Actor = {
  spaceId: "space-test",
  userId: "user-test",
  email: "user@example.test",
  isDeploymentOwner: false,
};

function client() {
  const router = createRouter({
    prisma: { $queryRaw: vi.fn().mockResolvedValue([{ bypass: null }]) },
    env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
    dataDir: "/tmp/research-keys-test",
  } as unknown as RouterDeps);
  return createRouterClient(router, { context: { actor } }).researchKeys;
}

beforeEach(() => vi.clearAllMocks());

describe("research key routes", () => {
  it("lists the signed-in account's own keys, saved or not, without any key", async () => {
    await expect(client().list()).resolves.toEqual(saved);
    expect(vi.mocked(listResearchKeys).mock.calls[0]?.[1]).toBe("user-test");
  });

  it("saves and removes a key for the signed-in account only, and audits both", async () => {
    await client().save({ provider: "search-provider", key: " fake-research-key " });
    expect(vi.mocked(saveResearchKey).mock.calls[0]?.slice(1)).toEqual([
      expect.objectContaining({ userId: "user-test", spaceId: "space-test" }),
      { provider: "search-provider", key: "fake-research-key" },
    ]);
    await client().remove({ provider: "search-provider" });
    expect(vi.mocked(removeResearchKey).mock.calls[0]?.slice(1)).toEqual([
      expect.objectContaining({ userId: "user-test" }),
      "search-provider",
    ]);
    const audited = vi.mocked(recordSecurityEvent).mock.calls.map((call) => call[0]);
    expect(audited.map((event) => event.type)).toEqual([
      "credential.changed",
      "credential.deleted",
    ]);
    expect(JSON.stringify(audited)).not.toContain("fake-research-key");
  });

  it.each([
    { provider: "search-provider", key: "   " },
    { provider: "", key: "fake-research-key" },
    { provider: "search-provider", key: "k".repeat(4097) },
    { provider: "p".repeat(65), key: "fake-research-key" },
  ])("refuses malformed input before it reaches the store", async (input) => {
    await expect(client().save(input)).rejects.toThrow();
    expect(saveResearchKey).not.toHaveBeenCalled();
  });
});
