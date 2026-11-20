import { createHash } from "node:crypto";
import type { ConnectorRoute, ConnectorTool } from "@rakazo/adapter-kit";
import { AddRegistryAppRecordInputSchema, RegistryAppRecordsInputSchema } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { addRegistryAppRecord, listRegistryAppRecords, resolvePluginGrants } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { callRemoteMcpTool, listRemoteMcpTools } from "../mcp/remote-mcp.js";
import { DIRECT_TOOL_LIMIT, SELECTED_SCHEMA_MAX_BYTES } from "../tools/lazy-tool-catalog.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import {
  ADD_APP_RECORD,
  LIST_APP_RECORDS,
  marketplaceAppTools,
} from "./marketplace-app.tool-definition.js";

const MARKETPLACE_CONNECTOR = "marketplace";
const MARKETPLACE_APP_CONNECTOR = "marketplace-app";
const MARKETPLACE_TOOL_PREFIX = "marketplace__";
export const MARKETPLACE_UNAVAILABLE = "This marketplace plugin tool is unavailable.";

type Scope = Parameters<typeof resolvePluginGrants>[1];
type Grant = Awaited<ReturnType<typeof resolvePluginGrants>>[number];
type Runtime = { prisma: PrismaClient; scope: Scope; signal: AbortSignal; appAllowed: boolean };
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
): string {
  const pin = [grant.versionId, grant.grantId, grant.part, inputSchema];
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
      resourceRevision: revision(grant, tool.name, tool.inputSchema),
    },
  };
}

export async function discoverMarketplaceTools(runtime: Runtime): Promise<ConnectorTool[]> {
  if (!runtime.prisma?.registryPluginGrant?.findMany) return [];
  const grants = await resolvePluginGrants(runtime.prisma, runtime.scope);
  const groups = await Promise.all(
    grants.map(async (grant) => {
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
          signal: deadlineSignal(20_000, runtime.signal),
        });
        const unique = new Map<string, ConnectorTool>();
        for (const tool of tools) {
          if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) <= SELECTED_SCHEMA_MAX_BYTES) {
            unique.set(tool.name, marketplaceTool(grant, tool));
          }
        }
        return [...unique.values()].slice(0, DIRECT_TOOL_LIMIT);
      } catch (error) {
        runtime.signal.throwIfAborted();
        getLogger().warn("marketplace plugin discovery failed", {
          error: sanitizeConnectorError(error),
        });
        return [];
      }
    }),
  );
  return groups.flat();
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
      revision(grant, route.toolName, tool.inputSchema) === route.resourceRevision,
  );
}

export async function executeMarketplaceTool(
  runtime: Runtime,
  tool: ConnectorTool,
  args: Record<string, unknown>,
  effectKey: string,
  publishAppChange?: () => Promise<void> | undefined,
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
        signal: runtime.signal,
        authorizeTool: (liveSchema) => {
          if (digest(liveSchema) !== digest(tool.inputSchema))
            throw new Error(MARKETPLACE_UNAVAILABLE);
        },
        authorizeRequest: async () => {
          if (!(await findLiveMarketplaceGrant(runtime, tool)))
            throw new Error(MARKETPLACE_UNAVAILABLE);
        },
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
