import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AddRegistryAppRecordInput,
  RegistryAppPart,
  RegistryAppRecord,
  RegistryAppRecords,
  RegistryAppRecordsInput,
  RemoveRegistryAppRecordInput,
} from "@rakazo/contracts";
import {
  AddRegistryAppRecordInputSchema,
  RegistryAppDateSchema,
  RegistryAppNumberSchema,
  RegistryAppRecordsInputSchema,
  RegistryAppTextSchema,
  RegistryAppValuesSchema,
  RemoveRegistryAppRecordInputSchema,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { ZodType } from "zod";
import { readJsonColumn } from "../database/json-column.js";
import { runAsTenant } from "../database/row-security.js";
import type {
  PrismaClient,
  RegistryAppRecord as StoredRecord,
} from "../generated/prisma/client.js";
import { Prisma } from "../generated/prisma/client.js";
import { lockRegistryPluginInstallation, readRegistryPluginManifest } from "./plugin-registry.js";

/**
 * Pass the authenticated installer for direct access. Bot calls also need the original
 * grant identity, from an authoritative run for that installer and their bot.
 */
export type RegistryAppScope = { spaceId: string; userId: string } & (
  | { botId?: never; grantId?: never; versionId?: never }
  | { botId: string; grantId: string; versionId: string }
);

type AppKey = { installationId: string; partId: string; versionId: string };

async function withInstalledApp<T>(
  prisma: PrismaClient,
  scope: RegistryAppScope,
  { installationId, partId }: Pick<AppKey, "installationId" | "partId">,
  work: (tx: Prisma.TransactionClient, key: AppKey, part: RegistryAppPart) => Promise<T>,
): Promise<T> {
  return runAsTenant(scope, () =>
    prisma.$transaction(async (tx) => {
      await lockRegistryPluginInstallation(tx, scope, installationId);
      const installation = await tx.registryPluginInstall.findFirst({
        where: {
          id: installationId,
          spaceId: scope.spaceId,
          userId: scope.userId,
          release: { status: "approved" },
        },
        include: { release: true },
      });
      if (!installation) throw new ClientError("NOT_FOUND", "Plugin installation not found");
      const key = { installationId, partId, versionId: installation.versionId };
      if (scope.botId !== undefined) await lockBotGrant(tx, scope, key);
      const part = readRegistryPluginManifest(installation.release).parts.find(
        (entry) => entry.id === partId,
      );
      if (part?.kind !== "app") throw new ClientError("NOT_FOUND", "Installed app part not found");
      return work(tx, key, part);
    }),
  );
}

async function lockBotGrant(
  tx: Prisma.TransactionClient,
  scope: Extract<RegistryAppScope, { botId: string }>,
  key: AppKey,
) {
  if (scope.versionId !== key.versionId)
    throw new ClientError("FORBIDDEN", "The bot no longer has this app grant");
  // Row locks cover bot archival and grant deletion as well as the normal registry RPCs.
  const [bot] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "bots"
    WHERE "id" = ${scope.botId} AND "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId}
      AND "archivedAt" IS NULL
    FOR SHARE`;
  if (!bot) throw new ClientError("FORBIDDEN", "The bot no longer has this app grant");
  const [grant] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "registry_plugin_grants"
    WHERE "id" = ${scope.grantId} AND "botId" = ${bot.id}
      AND "installationId" = ${key.installationId} AND "partId" = ${key.partId}
    FOR SHARE`;
  if (!grant) throw new ClientError("FORBIDDEN", "The bot no longer has this app grant");
}

function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ClientError("BAD_REQUEST", "Invalid app record request");
  return parsed.data;
}

const fieldSchemas = {
  text: RegistryAppTextSchema,
  number: RegistryAppNumberSchema,
  date: RegistryAppDateSchema,
};

function validateAppValues(part: RegistryAppPart, values: RegistryAppRecord["values"]) {
  const known = new Set(part.fields.map(({ id }) => id));
  if (Object.keys(values).some((id) => !known.has(id)))
    throw new ClientError("BAD_REQUEST", "App record contains an unknown field");

  for (const { id, type, required } of part.fields) {
    if (!Object.hasOwn(values, id)) {
      if (required) throw new ClientError("BAD_REQUEST", `Missing required field "${id}"`);
    } else if (!fieldSchemas[type].safeParse(values[id]).success) {
      throw new ClientError("BAD_REQUEST", `Invalid ${type} value for field "${id}"`);
    }
  }
}

function recordDto(row: Pick<StoredRecord, "id" | "values" | "createdAt">): RegistryAppRecord {
  return {
    id: row.id,
    values: readJsonColumn(
      RegistryAppValuesSchema,
      row.values,
      { table: "registry_app_records", column: "values", id: row.id },
      "reject",
    ),
    createdAt: row.createdAt.toISOString(),
  };
}

function firstDateField(part: RegistryAppPart) {
  return part.fields.find(({ type }) => type === "date")?.id;
}

/** Pages newest first. Totals cover all matching rows, including those before the cursor. */
export async function listRegistryAppRecords(
  prisma: PrismaClient,
  scope: RegistryAppScope,
  input: RegistryAppRecordsInput,
): Promise<RegistryAppRecords> {
  const request = parseInput(RegistryAppRecordsInputSchema, input);
  return withInstalledApp(prisma, scope, request, async (tx, key, part) => {
    const { after, date, limit } = request;
    if (date !== undefined && firstDateField(part) === undefined)
      throw new ClientError("BAD_REQUEST", "This app has no date field");
    const cursor = after
      ? await tx.registryAppRecord.findFirst({
          where: { ...key, id: after },
          select: { id: true, createdAt: true },
        })
      : null;
    if (after && !cursor) throw new ClientError("BAD_REQUEST", "Invalid app record cursor");

    const rows = await tx.registryAppRecord.findMany({
      where: {
        ...key,
        removedAt: null,
        recordDate: date,
        OR: cursor
          ? [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ]
          : undefined,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit).map(recordDto);
    const total = part.summaryField ? await summaryTotal(tx, key, part.summaryField, date) : null;
    return { items, total, nextAfter: rows.length > limit ? items.at(-1)!.id : null };
  });
}

async function summaryTotal(
  tx: Prisma.TransactionClient,
  key: AppKey,
  summaryField: string,
  date: string | undefined,
) {
  const [result] = await tx.$queryRaw<[{ total: string }]>`
    SELECT COALESCE(SUM(("values" ->> ${summaryField}::text)::numeric), 0)::text AS total
    FROM "registry_app_records"
    WHERE "installationId" = ${key.installationId} AND "versionId" = ${key.versionId}
      AND "partId" = ${key.partId} AND "removedAt" IS NULL
      ${date === undefined ? Prisma.empty : Prisma.sql`AND "recordDate" = ${date}`}`;
  return Number(result.total);
}

function usedOperation() {
  return new ClientError("CONFLICT", "This app record operation has already been used");
}

/** Replays an existing live record only when the original payload and version match. */
export async function addRegistryAppRecord(
  prisma: PrismaClient,
  scope: RegistryAppScope,
  input: AddRegistryAppRecordInput,
): Promise<RegistryAppRecord> {
  const request = parseInput(AddRegistryAppRecordInputSchema, input);
  return withInstalledApp(prisma, scope, request, async (tx, key, part) => {
    const { operationId, values } = request;
    validateAppValues(part, values);
    const previous = await tx.registryAppRecord.findFirst({ where: { ...key, operationId } });
    if (previous) {
      if (previous.removedAt !== null) throw usedOperation();
      const record = recordDto(previous);
      if (!isDeepStrictEqual(record.values, values)) throw usedOperation();
      return record;
    }
    const dateField = firstDateField(part);
    const date = dateField === undefined ? undefined : values[dateField];
    const [created] = await tx.$queryRaw<Array<Pick<StoredRecord, "id" | "values" | "createdAt">>>`
      INSERT INTO "registry_app_records"
        ("id", "installationId", "versionId", "partId", "operationId", "values", "recordDate")
      VALUES (${randomUUID()}::uuid, ${key.installationId}, ${key.versionId}, ${key.partId},
              ${operationId}::uuid, ${JSON.stringify(values)}::jsonb, ${typeof date === "string" ? date : null})
      ON CONFLICT ("installationId", "partId", "operationId") DO NOTHING
      RETURNING "id", "values", "createdAt"`;
    if (!created) throw usedOperation();
    return recordDto(created);
  });
}

/** Erases record content while retaining its retry identity until uninstall. */
export async function removeRegistryAppRecord(
  prisma: PrismaClient,
  scope: RegistryAppScope,
  input: RemoveRegistryAppRecordInput,
): Promise<{ ok: true }> {
  const request = parseInput(RemoveRegistryAppRecordInputSchema, input);
  return withInstalledApp(prisma, scope, request, async (tx, key) => {
    await tx.registryAppRecord.updateMany({
      where: { ...key, id: request.recordId, removedAt: null },
      data: { removedAt: new Date(), values: Prisma.DbNull, recordDate: null },
    });
    return { ok: true };
  });
}
