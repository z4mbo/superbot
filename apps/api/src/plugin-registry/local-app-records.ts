import type { RegistryAppRecord } from "@rakazo/contracts";
import { LOCAL_APP_PAGE_SIZE, LOCAL_APP_RECORD_LIMIT } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import {
  addRegistryAppRecord,
  listRegistryAppRecords,
  resolvePluginGrantPage,
  resolvePluginGrants,
} from "@rakazo/db";
import type { RouterContext } from "../routes/context.js";

const MAX_RECORD_BYTES = 24 * 1024;
type Grant = Awaited<ReturnType<typeof resolvePluginGrants>>[number];

function asApp({ part, installationId, grantId, versionId, pluginName }: Grant) {
  if (part.kind !== "app") return [];
  return [{ pin: { installationId, partId: part.id, grantId, versionId }, pluginName, part }];
}

function boundedRecords(records: RegistryAppRecord[]) {
  const items: RegistryAppRecord[] = [];
  let remaining = MAX_RECORD_BYTES - 1;
  for (const record of records) {
    remaining -= Buffer.byteLength(JSON.stringify(record)) + 1;
    if (remaining < 0) break;
    items.push(record);
  }
  return items;
}

const unavailable = () => new ClientError("FORBIDDEN", "This agent's app access is unavailable");

export function localAppRecordsRoutes({ deps: { prisma }, authed }: RouterContext) {
  const rpc = authed.localAppRecords;
  return {
    localAppRecords: {
      list: rpc.list.handler(async ({ context: { actor }, input: { botId, after } }) => {
        const scope = { userId: actor.userId, spaceId: actor.spaceId, botId };
        const bot = await prisma.bot.findFirst({
          where: { id: botId, userId: scope.userId, spaceId: scope.spaceId, archivedAt: null },
          select: { id: true },
        });
        if (!bot) throw unavailable();
        const { grants, nextAfter } = await resolvePluginGrantPage(
          prisma,
          scope,
          LOCAL_APP_PAGE_SIZE,
          after,
        );
        return { items: grants.flatMap(asApp), nextAfter };
      }),
      context: rpc.context.handler(async ({ context: { actor }, input }) => {
        const { botId, app: pin, date } = input;
        const { installationId, partId, grantId, versionId } = pin;
        const scope = { userId: actor.userId, spaceId: actor.spaceId, botId };
        const [app] = (
          await resolvePluginGrants(prisma, scope, { id: grantId, installationId, partId })
        ).flatMap(asApp);
        if (!app || app.pin.versionId !== versionId) throw unavailable();
        const records = await listRegistryAppRecords(
          prisma,
          { ...scope, grantId, versionId },
          { installationId, partId, date, limit: LOCAL_APP_RECORD_LIMIT },
        );
        const items = boundedRecords(records.items);
        return {
          app,
          items,
          total: records.total,
          hasMore: records.nextAfter !== null || items.length < records.items.length,
        };
      }),
      add: rpc.add.handler(({ context: { actor }, input }) => {
        const { botId, app, operationId, values } = input;
        const { installationId, partId, grantId, versionId } = app;
        return addRegistryAppRecord(
          prisma,
          { spaceId: actor.spaceId, userId: actor.userId, botId, grantId, versionId },
          { installationId, partId, operationId, values },
        );
      }),
    },
  };
}
