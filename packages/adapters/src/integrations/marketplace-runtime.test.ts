import type { ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type * as RemoteMcpModule from "../mcp/remote-mcp.js";
import { DIRECT_TOOL_LIMIT } from "../tools/lazy-tool-catalog.js";
import {
  discoverMarketplaceTools,
  marketplaceCatalogResult,
  marketplaceCatalogRoute,
  marketplaceRoute,
  resolveMarketplaceCatalogCall,
} from "./marketplace-runtime.js";

// Each plugin's endpoint lists the number of tools its host name asks for.
vi.mock("../mcp/remote-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteMcpModule>()),
  listRemoteMcpTools: async ({ endpoint }: RemoteMcpModule.RemoteMcpOptions) => {
    const count = Number(new URL(endpoint).hostname.split(".")[0]!.split("-")[1]);
    return Array.from({ length: count }, (_, index) => ({
      name: `tool_${index + 1}`,
      description: `Tool number ${index + 1}.`,
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
    }));
  },
}));

const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };

/** One granted MCP plugin per entry, listing that many tools. */
function runtime(toolCounts: number[]) {
  const rows = toolCounts.map((count, index) => ({
    id: `grant-${index + 1}`,
    partId: "tools",
    installation: {
      id: `install-${index + 1}`,
      slug: `plugin-${index + 1}`,
      versionId: `version-${index + 1}`,
      release: {
        id: `version-${index + 1}`,
        manifest: {
          schemaVersion: 1,
          name: `Plugin ${index + 1}`,
          description: "A fake plugin.",
          parts: [
            {
              id: "tools",
              kind: "mcp",
              transport: "streamable_http",
              endpoint: `https://p${index + 1}-${count}.example.com/mcp`,
            },
          ],
        },
      },
    },
  }));
  const prisma = { registryPluginGrant: { findMany: vi.fn(async () => rows) } };
  return {
    prisma: prisma as unknown as PrismaClient,
    scope,
    signal: new AbortController().signal,
    appAllowed: false,
  };
}

function catalogTool(offered: ConnectorTool[], suffix: string): ConnectorTool {
  const tool = offered.find((candidate) => candidate.name === `marketplace_${suffix}`);
  if (!tool) throw new Error(`marketplace_${suffix} is not offered`);
  return tool;
}

function catalogCall(tool: ConnectorTool, args: Record<string, unknown>): ConnectorCall {
  return { tool: tool.name, args, executionId: "call-1", route: tool.route };
}

describe("marketplace tools and the lazy catalog", () => {
  it("offers a plugin's tools directly up to the direct limit", async () => {
    const tools = await discoverMarketplaceTools(runtime([DIRECT_TOOL_LIMIT]));
    expect(tools.offered).toHaveLength(DIRECT_TOOL_LIMIT);
    expect(tools.offered.every((tool) => marketplaceRoute(tool.route))).toBe(true);
    expect(tools.catalog).toEqual([]);
  });

  it("offers the catalog instead once one plugin passes the limit, and keeps every tool", async () => {
    const tools = await discoverMarketplaceTools(runtime([DIRECT_TOOL_LIMIT + 1]));
    expect(tools.offered.map((tool) => tool.name)).toEqual([
      "marketplace_search_tools",
      "marketplace_load_tool",
      "marketplace_execute_tool",
    ]);
    expect(tools.catalog.map((entry) => entry.tool.route?.toolName)).toEqual(
      Array.from({ length: DIRECT_TOOL_LIMIT + 1 }, (_, index) => `tool_${index + 1}`),
    );
    expect(tools.catalog.every((entry) => entry.group === "Plugin 1")).toBe(true);
  });

  it("finds, loads and resolves a tool past the limit to the plugin tool itself", async () => {
    const tools = await discoverMarketplaceTools(runtime([DIRECT_TOOL_LIMIT + 5]));
    const last = `tool_${DIRECT_TOOL_LIMIT + 5}`;
    const found = (await marketplaceCatalogResult(
      catalogCall(catalogTool(tools.offered, "search_tools"), { query: last }),
      tools.catalog,
    )) as { tools: { id: string; name: string }[] };
    const entry = tools.catalog.find(({ tool }) => tool.route?.toolName === last)!;
    expect(found.tools[0]).toMatchObject({ id: entry.id, name: entry.tool.name });

    const loaded = await marketplaceCatalogResult(
      catalogCall(catalogTool(tools.offered, "load_tool"), { id: entry.id }),
      tools.catalog,
    );
    expect(loaded).toMatchObject({ name: entry.tool.name, inputSchema: entry.tool.inputSchema });

    const execute = catalogTool(tools.offered, "execute_tool");
    const resolved = resolveMarketplaceCatalogCall(execute.route, tools.catalog, {
      id: entry.id,
      arguments: { value: 3 },
    });
    expect(resolved).toEqual({ tool: entry.tool, args: { value: 3 } });
    expect(marketplaceRoute(resolved?.tool.route)).toBe(true);
    // The execute tool never runs a plugin tool itself.
    expect(
      await marketplaceCatalogResult(
        catalogCall(execute, { id: entry.id, arguments: { value: 3 } }),
        tools.catalog,
      ),
    ).toEqual({ error: "This marketplace plugin tool is unavailable." });
  });

  it("keeps the prompt small across many large plugins", async () => {
    const counts = Array.from({ length: 10 }, () => DIRECT_TOOL_LIMIT + 5);
    const tools = await discoverMarketplaceTools(runtime(counts));
    expect(tools.catalog).toHaveLength(10 * (DIRECT_TOOL_LIMIT + 5));
    expect(tools.offered).toHaveLength(3);
    const offeredBytes = Buffer.byteLength(JSON.stringify(tools.offered));
    const catalogBytes = Buffer.byteLength(JSON.stringify(tools.catalog.map(({ tool }) => tool)));
    expect(offeredBytes).toBeLessThan(catalogBytes / 10);
    const search = catalogTool(tools.offered, "search_tools");
    for (let plugin = 1; plugin <= 10; plugin++) {
      expect(search.description).toContain(`Plugin ${plugin} (${DIRECT_TOOL_LIMIT + 5})`);
    }
    // Tools of a plugin listed late are still found by source.
    const listed = (await marketplaceCatalogResult(
      catalogCall(search, { group: "Plugin 10", query: `tool_${DIRECT_TOOL_LIMIT + 5}` }),
      tools.catalog,
    )) as { tools: { id: string }[] };
    const last = tools.catalog.at(-1)!;
    expect(last.group).toBe("Plugin 10");
    expect(listed.tools.map(({ id }) => id)).toEqual([last.id]);
  });

  it("counts every plugin's tools together against the limit", async () => {
    const tools = await discoverMarketplaceTools(runtime([12, 9]));
    expect(tools.offered.map((tool) => tool.name)).toContain("marketplace_execute_tool");
    expect(tools.catalog).toHaveLength(21);
  });

  it("refuses an id or arguments the run's catalog cannot resolve", async () => {
    const tools = await discoverMarketplaceTools(runtime([DIRECT_TOOL_LIMIT + 1]));
    const execute = catalogTool(tools.offered, "execute_tool");
    expect(() =>
      resolveMarketplaceCatalogCall(execute.route, tools.catalog, {
        id: "another-plugin:tool_1",
        arguments: {},
      }),
    ).toThrow("Tool is unknown or not authorized for this bot");
    expect(() =>
      resolveMarketplaceCatalogCall(execute.route, tools.catalog, {
        id: tools.catalog[0]!.id,
        arguments: [],
      }),
    ).toThrow("Tool arguments must be an object");
  });

  it("leaves every other call alone", async () => {
    const tools = await discoverMarketplaceTools(runtime([DIRECT_TOOL_LIMIT + 1]));
    const direct = tools.catalog[0]!.tool;
    const args = { id: tools.catalog[0]!.id, arguments: {} };
    expect(resolveMarketplaceCatalogCall(direct.route, tools.catalog, args)).toBeUndefined();
    const search = catalogTool(tools.offered, "search_tools");
    expect(resolveMarketplaceCatalogCall(search.route, tools.catalog, args)).toBeUndefined();
    const installed = { connectorId: "installed", toolName: "__catalog_execute" };
    expect(resolveMarketplaceCatalogCall(installed, tools.catalog, args)).toBeUndefined();
    expect(marketplaceCatalogRoute(direct.route)).toBe(false);
    expect(marketplaceCatalogRoute(installed)).toBe(false);
    expect(marketplaceCatalogRoute(search.route)).toBe(true);
  });
});
