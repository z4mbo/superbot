import {
  KEYED_PAGE_READ_TOOL_NAMES,
  KEYED_RESEARCH_TOOL_NAMES,
  KEYED_SEARCH_TOOL_NAMES,
} from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "../../tools/builtin.tool-definition.js";
import { researchKeyFakes } from "./research.test-support.js";
import { saveResearchKey } from "./research-keys.js";
import { RESEARCH_TOOL_NAMES, researchProviderDescriptors } from "./research-providers.js";
import { researchToolFromCall } from "./research-tools.js";

const ALICE = { userId: "alice", spaceId: "space-a" };
const KEY = "fake-secret-key-789";
const publicHost = async () => [{ address: "203.0.113.10", family: 4 as const }];

afterEach(() => vi.restoreAllMocks());

async function withKey(provider: string, fetch: typeof globalThis.fetch) {
  const fakes = researchKeyFakes();
  await saveResearchKey(fakes, ALICE, { provider, key: KEY });
  return {
    fakes,
    deps: {
      prisma: fakes.prisma,
      secrets: fakes.secrets,
      fetch,
      resolveHostname: publicHost,
      delay: async () => undefined,
    },
  };
}

function outcome(deps: Parameters<typeof researchToolFromCall>[0], tool: string, args: object) {
  return researchToolFromCall(deps, ALICE.userId, tool, { ...args }, new AbortController().signal);
}

async function run(deps: Parameters<typeof researchToolFromCall>[0], tool: string, args: object) {
  return (await outcome(deps, tool, args)).result;
}

describe("research providers", () => {
  it("declare one keyed catalog tool each, defined read-only beside the web tools", () => {
    const descriptors = researchProviderDescriptors();
    expect(new Set(descriptors.map((d) => d.id)).size).toBe(descriptors.length);
    expect([...RESEARCH_TOOL_NAMES].sort()).toEqual([...KEYED_RESEARCH_TOOL_NAMES].sort());
    for (const descriptor of descriptors) {
      const names: readonly string[] =
        descriptor.capability === "search" ? KEYED_SEARCH_TOOL_NAMES : KEYED_PAGE_READ_TOOL_NAMES;
      expect(names).toContain(descriptor.toolName);
      const tool = builtinAgentTools.find((candidate) => candidate.name === descriptor.toolName);
      expect(tool?.readOnly).toBe(true);
    }
  });
});

describe("research tools", () => {
  it("tells the model what to use instead when no key is saved", async () => {
    const fakes = researchKeyFakes();
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const tool of KEYED_RESEARCH_TOOL_NAMES) {
      const result = (await run({ prisma: fakes.prisma, secrets: fakes.secrets, fetch }, tool, {
        query: "q",
        url: "https://example.com/",
      })) as { error: string };
      expect(result.error).toContain("web_search and web_fetch");
      expect(result.error).toContain("Settings");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the saved key and never hands it to the model, even when echoed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ results: [{ url: "https://a.example/", title: `echo ${KEY}` }] }),
    );
    const { deps } = await withKey("exa", fetch);
    const result = await run(deps, "exa_search", { query: "q" });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("x-api-key")).toBe(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result).toEqual({
      results: [{ title: "echo [key]", url: "https://a.example/", snippet: "" }],
    });
  });

  it("answers a refused key, a blocked URL and a crash with a result, never the key", async () => {
    const warn = vi.spyOn(getLogger(), "warn");
    const refused = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: `bad ${KEY}` }, { status: 401 }),
    );
    const first = await withKey("firecrawl", refused);
    const rejected = (await run(first.deps, "firecrawl_scrape", {
      url: "https://example.com/",
    })) as { error: string };
    expect(rejected.error).toContain("rejected the saved key");

    const blocked = (await run(first.deps, "firecrawl_scrape", {
      url: "http://127.0.0.1/admin",
    })) as { error: string };
    expect(blocked.error).toMatch(/private|internal/i);
    expect(refused).toHaveBeenCalledTimes(1);

    const crash = vi.fn<typeof globalThis.fetch>(async () => {
      throw Object.assign(new Error(`socket closed for ${KEY}`), { name: "WeirdError" });
    });
    const second = await withKey("exa", crash);
    const failed = (await run(second.deps, "exa_search", { query: "q" })) as { error: string };
    expect(failed.error).toBe("Exa could not be reached.");

    for (const output of [rejected, blocked, failed, ...warn.mock.calls])
      expect(JSON.stringify(output)).not.toContain(KEY);
  });

  it("treats a key removed mid-run as missing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { fakes, deps } = await withKey("exa", fetch);
    fakes.rows.length = 0;
    const result = (await run(deps, "exa_search", { query: "q" })) as { error: string };
    expect(result.error).toContain("needs the person's own key");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an unreadable key without failing the turn", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { fakes, deps } = await withKey("exa", fetch);
    fakes.secrets.load.mockRejectedValueOnce(new Error("store down"));
    const result = (await run(deps, "exa_search", { query: "q" })) as { error: string };
    expect(result.error).toContain("could not be read right now");
  });

  it("hands the run the key to redact once it was read, and nothing without one", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ results: [] }));
    const { deps } = await withKey("exa", fetch);
    expect((await outcome(deps, "exa_search", { query: "q" })).redactions).toEqual([KEY]);
    const failing = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 401 }));
    const refused = await withKey("exa", failing);
    expect((await outcome(refused.deps, "exa_search", { query: "q" })).redactions).toEqual([KEY]);
    const none = researchKeyFakes();
    const missing = await outcome(
      { prisma: none.prisma, secrets: none.secrets, fetch },
      "exa_search",
      {
        query: "q",
      },
    );
    expect(missing.redactions).toEqual([]);
  });
});
