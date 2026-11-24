import type { ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type * as RemoteMcpModule from "../mcp/remote-mcp.js";
import { allowsE2ePluginEndpoint, e2ePluginHostsFromEnv } from "./e2e-plugin-hosts.js";
import {
  discoverMarketplaceTools,
  executeMarketplaceTool,
  marketplaceCatalogResult,
  resolveMarketplaceCatalogCall,
} from "./marketplace-runtime.js";

const TOOL_COUNT = 26;

// The fake plugin server lists 26 tools and echoes a call, but only after the product's own URL
// policy accepts the endpoint under the policy the marketplace runtime asked for.
const remote = vi.hoisted(() => ({ policies: [] as Array<boolean | undefined> }));
vi.mock("../mcp/remote-mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteMcpModule>();
  const check = async (options: RemoteMcpModule.RemoteMcpOptions) => {
    remote.policies.push(options.allowPrivateEndpoint);
    await actual.assertSafeRemoteUrl(
      options.endpoint,
      async () => [{ address: "127.0.0.1", family: 4 }],
      { allowPrivateEndpoint: options.allowPrivateEndpoint },
    );
  };
  return {
    ...actual,
    listRemoteMcpTools: async (options: RemoteMcpModule.RemoteMcpOptions) => {
      await check(options);
      return Array.from({ length: TOOL_COUNT }, (_, index) => ({
        name: `fake_tool_${index + 1}`,
        description: `Fake tool number ${index + 1}.`,
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      }));
    },
    callRemoteMcpTool: async (
      options: RemoteMcpModule.RemoteMcpOptions,
      name: string,
      args: Record<string, unknown>,
    ) => {
      await check(options);
      return { content: [{ type: "text", text: `${name} ran with ${JSON.stringify(args)}` }] };
    },
  };
});

const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };

function runtime(endpoint: string, e2ePluginHosts?: string[]) {
  const grant = {
    id: "grant-1",
    partId: "tools",
    installation: {
      id: "install-1",
      slug: "fake-mcp",
      versionId: "version-1",
      release: {
        id: "version-1",
        manifest: {
          schemaVersion: 1,
          name: "Fake MCP",
          description: "A fake plugin server.",
          parts: [{ id: "tools", kind: "mcp", transport: "streamable_http", endpoint }],
        },
      },
    },
  };
  const prisma = { registryPluginGrant: { findMany: vi.fn(async () => [grant]) } };
  return {
    prisma: prisma as unknown as PrismaClient,
    scope,
    signal: new AbortController().signal,
    appAllowed: false,
    e2ePluginHosts,
  };
}

function call(offered: ConnectorTool[], suffix: string, args: Record<string, unknown>) {
  const tool = offered.find((candidate) => candidate.name === `marketplace_${suffix}`)!;
  return { tool: tool.name, args, executionId: "call-1", route: tool.route } as ConnectorCall;
}

describe("test-only marketplace plugin hosts", () => {
  it("is off unless listed, and never applies in production", () => {
    expect(e2ePluginHostsFromEnv({})).toEqual([]);
    expect(
      e2ePluginHostsFromEnv({ SUPERBOT_E2E_ALLOW_PLUGIN_HOSTS: " 127.0.0.1, Plugins.Test " }),
    ).toEqual(["127.0.0.1", "plugins.test"]);
    expect(e2ePluginHostsFromEnv({ RAKAZO_E2E_ALLOW_PLUGIN_HOSTS: "127.0.0.1" })).toEqual([
      "127.0.0.1",
    ]);
    expect(
      e2ePluginHostsFromEnv({
        NODE_ENV: "production",
        SUPERBOT_E2E_ALLOW_PLUGIN_HOSTS: "127.0.0.1",
      }),
    ).toEqual([]);
  });

  it("allows only HTTPS endpoints on an exactly listed host", () => {
    const hosts = ["127.0.0.1", "plugins.test"];
    expect(allowsE2ePluginEndpoint("https://127.0.0.1:56140/mcp", hosts)).toBe(true);
    expect(allowsE2ePluginEndpoint("https://PLUGINS.test/mcp", hosts)).toBe(true);
    expect(allowsE2ePluginEndpoint("http://127.0.0.1:56140/mcp", hosts)).toBe(false);
    expect(allowsE2ePluginEndpoint("https://10.0.0.5/mcp", hosts)).toBe(false);
    expect(allowsE2ePluginEndpoint("https://a.plugins.test/mcp", hosts)).toBe(false);
    expect(allowsE2ePluginEndpoint("https://127.0.0.1/mcp", [])).toBe(false);
    expect(allowsE2ePluginEndpoint("https://127.0.0.1/mcp", undefined)).toBe(false);
  });

  it("keeps a loopback plugin server unreachable by default", async () => {
    remote.policies.length = 0;
    const tools = await discoverMarketplaceTools(runtime("https://127.0.0.1:56140/mcp"));
    expect(tools).toEqual({ offered: [], catalog: [] });
    expect(remote.policies).toEqual([false]);
  });

  it("keeps an unlisted private host unreachable with the allowlist set", async () => {
    remote.policies.length = 0;
    const tools = await discoverMarketplaceTools(
      runtime("https://127.0.0.1:56140/mcp", ["plugins.test"]),
    );
    expect(tools.catalog).toEqual([]);
    expect(remote.policies).toEqual([false]);
  });

  it("searches, loads and executes a tool of a listed 26-tool loopback server", async () => {
    remote.policies.length = 0;
    const run = runtime("https://127.0.0.1:56140/mcp", ["127.0.0.1"]);
    const tools = await discoverMarketplaceTools(run);
    expect(tools.catalog).toHaveLength(TOOL_COUNT);
    expect(tools.offered.map((tool) => tool.name)).toEqual([
      "marketplace_search_tools",
      "marketplace_load_tool",
      "marketplace_execute_tool",
    ]);

    const found = (await marketplaceCatalogResult(
      call(tools.offered, "search_tools", { query: "fake_tool_26" }),
      tools.catalog,
    )) as { tools: { id: string }[] };
    const id = found.tools[0]!.id;
    expect(
      await marketplaceCatalogResult(call(tools.offered, "load_tool", { id }), tools.catalog),
    ).toMatchObject({ inputSchema: { properties: { text: { type: "string" } } } });

    const execute = tools.offered.find((tool) => tool.name === "marketplace_execute_tool")!;
    const resolved = resolveMarketplaceCatalogCall(execute.route, tools.catalog, {
      id,
      arguments: { text: "hi" },
    })!;
    expect(resolved.tool.route?.toolName).toBe("fake_tool_26");
    expect(await executeMarketplaceTool(run, resolved.tool, resolved.args, "effect-1")).toEqual({
      content: [{ type: "text", text: 'fake_tool_26 ran with {"text":"hi"}' }],
    });
    expect(remote.policies).toEqual([true, true]);
  });
});
