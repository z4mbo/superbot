import { createHash } from "node:crypto";
import type {
  ConnectorApp,
  ConnectorCall,
  ConnectorEvent,
  ConnectorRoute,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { AddRegistryAppRecordInputSchema, RegistryAppRecordsInputSchema } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { addRegistryAppRecord, listRegistryAppRecords, resolvePluginGrants } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { mcpToolAppResourceUri } from "../mcp/mcp-app.js";
import { callRemoteMcpTool, listRemoteMcpTools } from "../mcp/remote-mcp.js";
import type { CatalogEntry } from "../tools/lazy-tool-catalog.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  catalogGroupLabel,
  DIRECT_TOOL_LIMIT,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  loadCatalogEntry,
  SELECTED_SCHEMA_MAX_BYTES,
} from "../tools/lazy-tool-catalog.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { allowsE2ePluginEndpoint } from "./e2e-plugin-hosts.js";
import {
  ADD_APP_RECORD,
  LIST_APP_RECORDS,
  marketplaceAppTools,
} from "./marketplace-app.tool-definition.js";

const MARKETPLACE_CONNECTOR = "marketplace";
const MARKETPLACE_APP_CONNECTOR = "marketplace-app";
const MARKETPLACE_TOOL_PREFIX = "marketplace__";
// The catalog's own tools take one underscore, so none is ever taken for a plugin tool.
const MARKETPLACE_CATALOG_CONNECTOR = "marketplace-catalog";
const MARKETPLACE_CATALOG_PREFIX = "marketplace";
export const MARKETPLACE_UNAVAILABLE = "This marketplace plugin tool is unavailable.";

type Scope = Parameters<typeof resolvePluginGrants>[1];
type Grant = Awaited<ReturnType<typeof resolvePluginGrants>>[number];
type Runtime = {
  prisma: PrismaClient;
  scope: Scope;
  signal: AbortSignal;
  appAllowed: boolean;
  /** TEST ONLY: see `e2ePluginHostsFromEnv`. */
  e2ePluginHosts?: readonly string[];
};
type MarketplaceRoute = ConnectorRoute & { resourceId: string; resourceRevision: string };

export function marketplaceScope(
  run: Scope,
  bot: { id: string; userId: string; spaceId: string },
  nonOwnerChatRun: boolean,
): Scope | undefined {
  if (
    nonOwnerChatRun ||
    run.userId !== bot.userId ||
    run.spaceId !== bot.spaceId ||
    run.botId !== bot.id
  )
    return undefined;
  return { userId: run.userId, spaceId: run.spaceId, botId: bot.id };
}

export function marketplaceToolName(name: string): boolean {
  return name.startsWith(MARKETPLACE_TOOL_PREFIX);
}

export function marketplaceRoute(route: ConnectorRoute | undefined): route is MarketplaceRoute {
  return (
    route !== undefined &&
    (route.connectorId === MARKETPLACE_CONNECTOR || marketplaceAppRoute(route)) &&
    typeof route.resourceId === "string" &&
    typeof route.resourceRevision === "string"
  );
}

export function marketplaceAppRoute(route: ConnectorRoute | undefined): boolean {
  return route?.connectorId === MARKETPLACE_APP_CONNECTOR;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function resourceId(grant: Grant): string {
  return digest([grant.installationId, grant.part.id]);
}

function revision(
  grant: Grant,
  toolName: string,
  inputSchema: ConnectorTool["inputSchema"],
  appResourceUri?: string,
): string {
  const pin = [grant.versionId, grant.grantId, grant.part, inputSchema];
  if (grant.part.kind === "mcp" && appResourceUri) return digest([...pin, appResourceUri]);
  return digest(grant.part.kind === "app" ? [...pin, toolName] : pin);
}

function marketplaceTool(grant: Grant, tool: ConnectorTool): ConnectorTool {
  const resource = resourceId(grant);
  const nameHash = digest([resource, tool.name]).slice(0, 24);
  const app = grant.part.kind === "app";
  const label = (app ? `${tool.name}_${grant.part.id}` : tool.name)
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .slice(0, 24);
  return {
    name: `${MARKETPLACE_TOOL_PREFIX}${label}_${nameHash}`,
    label:
      grant.part.kind === "mcp"
        ? `${JSON.stringify(tool.name)} at ${grant.part.endpoint}`
        : tool.description,
    description: tool.description.slice(0, 500),
    inputSchema: tool.inputSchema,
    readOnly: app ? tool.readOnly : grant.part.kind === "skill",
    route: {
      connectorId: app ? MARKETPLACE_APP_CONNECTOR : MARKETPLACE_CONNECTOR,
      toolName: tool.name,
      resourceId: resource,
      resourceRevision: revision(grant, tool.name, tool.inputSchema, tool.appResourceUri),
      ...(tool.appResourceUri ? { appResourceUri: tool.appResourceUri } : {}),
    },
  };
}

/**
 * What a run offers of its marketplace tools, and every tool its catalog reaches. `catalog` is
 * empty when the tools are offered directly.
 */
export type MarketplaceTools = { offered: ConnectorTool[]; catalog: CatalogEntry[] };

export const NO_MARKETPLACE_TOOLS: MarketplaceTools = { offered: [], catalog: [] };

/**
 * Every tool the bot's plugins grant. As with the other connector sources, up to
 * DIRECT_TOOL_LIMIT of them are offered directly; above that the run offers the catalog's
 * search, load and execute tools instead, which reach every one of them.
 */
export async function discoverMarketplaceTools(runtime: Runtime): Promise<MarketplaceTools> {
  if (!runtime.prisma?.registryPluginGrant?.findMany) return NO_MARKETPLACE_TOOLS;
  const grants = await resolvePluginGrants(runtime.prisma, runtime.scope);
  const groups = await Promise.all(
    grants.map(async (grant) => {
      const tools = await discoverGrantTools(runtime, grant);
      const group = catalogGroupLabel(grant.pluginName, "plugin", grant.installationId);
      return { tools, entries: catalogEntries(tools).map((entry) => ({ ...entry, group })) };
    }),
  );
  const tools = groups.flatMap((group) => group.tools);
  if (tools.length <= DIRECT_TOOL_LIMIT) return { offered: tools, catalog: [] };
  const catalog = groups.flatMap((group) => group.entries);
  return {
    offered: lazyCatalogTools(
      MARKETPLACE_CATALOG_PREFIX,
      MARKETPLACE_CATALOG_CONNECTOR,
      "installed plugin",
      catalog,
    ),
    catalog,
  };
}

async function discoverGrantTools(runtime: Runtime, grant: Grant): Promise<ConnectorTool[]> {
  if (grant.part.kind === "app") {
    return runtime.appAllowed
      ? marketplaceAppTools(grant.part, grant.pluginSlug).map((tool) =>
          marketplaceTool(grant, tool),
        )
      : [];
  }
  if (grant.part.kind === "skill") {
    return [
      marketplaceTool(grant, {
        name: grant.part.id,
        description: `Read the ${grant.part.id} marketplace skill instructions.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    ];
  }
  try {
    const tools = await listRemoteMcpTools({
      endpoint: grant.part.endpoint,
      allowPrivateEndpoint: allowsE2ePluginEndpoint(grant.part.endpoint, runtime.e2ePluginHosts),
      signal: deadlineSignal(20_000, runtime.signal),
    });
    const unique = new Map<string, ConnectorTool>();
    for (const tool of tools) {
      if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) <= SELECTED_SCHEMA_MAX_BYTES) {
        unique.set(tool.name, marketplaceTool(grant, tool));
      }
    }
    return [...unique.values()];
  } catch (error) {
    runtime.signal.throwIfAborted();
    getLogger().warn("marketplace plugin discovery failed", {
      error: sanitizeConnectorError(error),
    });
    return [];
  }
}

/** A search, load or execute call of the marketplace catalog. */
export function marketplaceCatalogRoute(route: ConnectorRoute | undefined): boolean {
  return route?.connectorId === MARKETPLACE_CATALOG_CONNECTOR && isLazyCatalogControlRoute(route);
}

/**
 * The plugin tool a marketplace catalog execute call names, with the arguments for it, so the
 * call runs as that tool's own direct call would: the same checks, approval and audit.
 * Undefined for any other call; throws when the id names no tool in this run's catalog.
 */
export function resolveMarketplaceCatalogCall(
  route: ConnectorRoute | undefined,
  catalog: CatalogEntry[],
  args: Record<string, unknown>,
): { tool: ConnectorTool; args: Record<string, unknown> } | undefined {
  if (!marketplaceCatalogRoute(route) || route?.toolName !== CATALOG_EXECUTE) return undefined;
  const { tool } = loadCatalogEntry(catalog, args);
  const toolArgs = args.arguments;
  if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
    throw new Error("Tool arguments must be an object");
  }
  return { tool, args: toolArgs as Record<string, unknown> };
}

/**
 * A marketplace catalog search or load, answered from the tools this run discovered. An execute
 * call never runs here: it is resolved to its tool before it reaches a handler.
 */
export async function marketplaceCatalogResult(
  call: ConnectorCall,
  catalog: CatalogEntry[],
): Promise<unknown> {
  let result: unknown = { error: MARKETPLACE_UNAVAILABLE };
  try {
    for await (const event of executeLazyCatalogControl(call, catalog, refuseExecute)) {
      result = event.type === "result" ? event.data : { error: MARKETPLACE_UNAVAILABLE };
    }
  } catch (error) {
    result = { error: sanitizeConnectorError(error) };
  }
  return result;
}

async function* refuseExecute(): AsyncIterable<ConnectorEvent> {
  yield { type: "error", message: MARKETPLACE_UNAVAILABLE };
}

export async function findLiveMarketplaceGrant(runtime: Runtime, tool: ConnectorTool) {
  const { route } = tool;
  if (!marketplaceRoute(route)) return undefined;
  const app = marketplaceAppRoute(route);
  if (app && !runtime.appAllowed) return undefined;
  runtime.signal.throwIfAborted();
  const grants = await resolvePluginGrants(runtime.prisma, runtime.scope);
  runtime.signal.throwIfAborted();
  return grants.find(
    (grant) =>
      (grant.part.kind === "app") === app &&
      resourceId(grant) === route.resourceId &&
      revision(grant, route.toolName, tool.inputSchema, route.appResourceUri) ===
        route.resourceRevision,
  );
}

export async function executeMarketplaceTool(
  runtime: Runtime,
  tool: ConnectorTool,
  args: Record<string, unknown>,
  effectKey: string,
  publishAppChange?: () => Promise<void> | undefined,
  publishMcpApp?: (app: ConnectorApp, result: unknown) => Promise<void>,
): Promise<unknown> {
  const route = tool.route;
  if (!marketplaceRoute(route)) return { error: MARKETPLACE_UNAVAILABLE };
  try {
    const grant = await findLiveMarketplaceGrant(runtime, tool);
    if (!grant) return { error: MARKETPLACE_UNAVAILABLE };
    if (grant.part.kind === "skill") return { instructions: grant.part.instructions };
    if (grant.part.kind === "app") {
      const scope = { ...runtime.scope, grantId: grant.grantId, versionId: grant.versionId };
      const target = { installationId: grant.installationId, partId: grant.part.id };
      if (route.toolName === LIST_APP_RECORDS) {
        return await listRegistryAppRecords(
          runtime.prisma,
          scope,
          RegistryAppRecordsInputSchema.parse({ ...args, ...target }),
        );
      }
      if (route.toolName === ADD_APP_RECORD) {
        const input = AddRegistryAppRecordInputSchema.parse({
          values: args.values,
          ...target,
          operationId: appRecordOperationId(effectKey),
        });
        const record = await addRegistryAppRecord(runtime.prisma, scope, input);
        await bestEffort("notify marketplace app record changes", publishAppChange?.());
        return record;
      }
      return { error: MARKETPLACE_UNAVAILABLE };
    }
    return await callRemoteMcpTool(
      {
        endpoint: grant.part.endpoint,
        allowPrivateEndpoint: allowsE2ePluginEndpoint(grant.part.endpoint, runtime.e2ePluginHosts),
        signal: runtime.signal,
        authorizeTool: (liveTool) => {
          if (
            digest(liveTool.inputSchema) !== digest(tool.inputSchema) ||
            mcpToolAppResourceUri(liveTool) !== route.appResourceUri
          )
            throw new Error(MARKETPLACE_UNAVAILABLE);
        },
        authorizeRequest: async () => {
          if (!(await findLiveMarketplaceGrant(runtime, tool)))
            throw new Error(MARKETPLACE_UNAVAILABLE);
        },
        ...(publishMcpApp && route.appResourceUri
          ? { app: { server: grant.pluginName, uri: route.appResourceUri, publish: publishMcpApp } }
          : {}),
      },
      route.toolName,
      args,
    );
  } catch (error) {
    runtime.signal.throwIfAborted();
    if (
      marketplaceAppRoute(route) &&
      error instanceof ClientError &&
      (error.kind === "BAD_REQUEST" || error.kind === "CONFLICT")
    )
      return { error: error.message };
    getLogger().warn("marketplace plugin execution failed", {
      error: sanitizeConnectorError(error),
    });
    return { error: MARKETPLACE_UNAVAILABLE };
  }
}

function appRecordOperationId(effectKey: string): string {
  const hex = digest(["marketplace app record", effectKey]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
