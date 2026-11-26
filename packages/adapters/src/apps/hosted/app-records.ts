import { randomUUID } from "node:crypto";
import type {
  AppCollection,
  AppData,
  AppRecord,
  AppRecordFilter,
  AppRecordQuery,
} from "@rakazo/contracts";
import {
  APP_DATA_LIST_DEFAULT,
  APP_DATA_RECORD_MAX_BYTES,
  APP_DATA_RECORDS_MAX,
  APP_DATA_TOTAL_MAX_BYTES,
  appRecordQuerySchema,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { JsonColumnMismatchError, readJsonColumn, reportJsonColumnOnce } from "@rakazo/db";
import { parseFields } from "@rakazo/plugin-sdk";
import * as z from "zod";
import { AppFunctionCallError, jsonBytes } from "../functions/app-function-runtime.js";

/**
 * An installed app's records: what its server functions reach through `ctx.db`. Every call is
 * bound to one install in one Space, so nothing here can name another install's rows or another
 * Space's (and row security refuses them to anyone but the install's person), and every write is
 * checked against the collection the installed manifest declares and against the install's
 * quotas. Refusals are AppFunctionCallErrors, which the function sees and may handle.
 */

type Db = Pick<PrismaClient, "appRecord">;
type Row = {
  id: string;
  installId: string;
  spaceId: string;
  collection: string;
  fields: unknown;
  createdAt: Date;
  updatedAt: Date;
};

const RecordDataSchema = z.record(z.string(), z.json());
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const INDEX_COLUMNS = [
  { text: "s0", number: "n0" },
  { text: "s1", number: "n1" },
  { text: "s2", number: "n2" },
] as const;

/** What changed in a run, so the caller knows whether to tell open views. */
export type RecordWrites = { count: number };

function refuse(message: string): never {
  throw new AppFunctionCallError(message);
}

/** The column an indexed field's values are kept in, and how a value is stored there. */
function indexColumn(collection: AppCollection, field: string) {
  const position = (collection.index ?? []).indexOf(field);
  const declared = collection.fields[field];
  if (position < 0 || !declared) return null;
  const columns = INDEX_COLUMNS[position]!;
  return declared.type === "number"
    ? { column: columns.number, type: "number" as const }
    : { column: columns.text, type: declared.type };
}

function indexValues(collection: AppCollection, data: Record<string, unknown>) {
  const values: Record<string, string | number | null> = {};
  for (const field of collection.index ?? []) {
    const index = indexColumn(collection, field)!;
    const value = data[field];
    values[index.column] =
      value === undefined || value === null
        ? null
        : index.type === "boolean"
          ? String(value)
          : (value as string | number);
  }
  return values;
}

function toRecord(row: Row): AppRecord | null {
  let data: Record<string, unknown>;
  try {
    data = readJsonColumn(
      RecordDataSchema,
      row.fields,
      {
        table: "app_records",
        column: "fields",
        id: `${row.installId}/${row.spaceId}/${row.collection}/${row.id}`,
      },
      "reject",
    );
  } catch (error) {
    if (!(error instanceof JsonColumnMismatchError)) throw error;
    reportJsonColumnOnce("App record left out", error.row);
    return null;
  }
  return {
    ...data,
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rangeFor(
  name: string,
  index: { column: string; type: "string" | "number" | "boolean" },
  filter: AppRecordFilter,
): Record<string, unknown> {
  const fits = (value: unknown) =>
    index.type === "number" ? typeof value === "number" : typeof value === "string";
  if (typeof filter !== "object") {
    if (index.type === "boolean") {
      if (typeof filter !== "boolean") refuse(`${name} is true or false.`);
      return { [index.column]: String(filter) };
    }
    if (!fits(filter)) refuse(`${name} is a ${index.type}.`);
    return { [index.column]: filter };
  }
  if (index.type === "boolean") refuse(`${name} is true or false; it has no range.`);
  for (const value of Object.values(filter))
    if (!fits(value)) refuse(`${name} is a ${index.type}; its range must be too.`);
  return { [index.column]: filter };
}

export class AppRecords {
  readonly writes: RecordWrites = { count: 0 };

  constructor(
    private readonly db: Db,
    private readonly scope: { installId: string; spaceId: string },
    private readonly data: AppData,
    private readonly options: { readOnly: boolean; newId?: () => string } = { readOnly: false },
  ) {}

  private collection(name: unknown): { name: string; collection: AppCollection } {
    if (typeof name !== "string" || !Object.hasOwn(this.data.collections, name))
      refuse(
        `This app has no collection named ${String(name)}. It has: ${Object.keys(this.data.collections).join(", ")}.`,
      );
    return { name, collection: this.data.collections[name]! };
  }

  private writable(name: string) {
    if (this.options.readOnly) refuse(`A read-only action cannot change ${name}.`);
  }

  private checked(name: string, collection: AppCollection, value: unknown, partial: boolean) {
    const parsed = parseFields(collection.fields, value, {
      owner: name,
      takes: "has no field",
      partial,
    });
    if (!parsed.ok) refuse(parsed.error);
    return parsed.input;
  }

  private key(collection: string, id: unknown) {
    if (typeof id !== "string" || !ID.test(id)) refuse("A record id is the id a record was given.");
    return { installId_spaceId_collection_id: { ...this.scope, collection, id } };
  }

  /** The install's quotas in this Space, counted inside the caller's transaction. */
  private async assertRoom(addBytes: number, addRecords: number) {
    const totals = await this.db.appRecord.aggregate({
      where: this.scope,
      _count: { _all: true },
      _sum: { bytes: true },
    });
    if (totals._count._all + addRecords > APP_DATA_RECORDS_MAX)
      refuse(`This app keeps at most ${APP_DATA_RECORDS_MAX} records; remove some first.`);
    if ((totals._sum.bytes ?? 0) + addBytes > APP_DATA_TOTAL_MAX_BYTES)
      refuse(`This app's records are full (${APP_DATA_TOTAL_MAX_BYTES} bytes); remove some first.`);
  }

  private sized(data: Record<string, unknown>) {
    const bytes = jsonBytes(data);
    if (bytes > APP_DATA_RECORD_MAX_BYTES)
      refuse(`A record takes at most ${APP_DATA_RECORD_MAX_BYTES} bytes; this one is ${bytes}.`);
    return bytes;
  }

  async insert(name: unknown, value: unknown): Promise<AppRecord> {
    const { name: collectionName, collection } = this.collection(name);
    this.writable(collectionName);
    const data = this.checked(collectionName, collection, value, false);
    const bytes = this.sized(data);
    await this.assertRoom(bytes, 1);
    const now = new Date();
    const row = await this.db.appRecord.create({
      data: {
        ...this.scope,
        collection: collectionName,
        id: this.options.newId?.() ?? randomUUID().replaceAll("-", "").slice(0, 20),
        fields: data as Prisma.InputJsonObject,
        bytes,
        ...indexValues(collection, data),
        createdAt: now,
        updatedAt: now,
      },
    });
    this.writes.count += 1;
    return toRecord(row)!;
  }

  async get(name: unknown, id: unknown): Promise<AppRecord | null> {
    const { name: collectionName } = this.collection(name);
    const row = await this.db.appRecord.findUnique({ where: this.key(collectionName, id) });
    return row ? toRecord(row) : null;
  }

  async list(
    name: unknown,
    value: unknown,
  ): Promise<{ items: AppRecord[]; nextCursor: string | null }> {
    const { name: collectionName, collection } = this.collection(name);
    const parsed = appRecordQuerySchema.safeParse(value ?? {});
    if (!parsed.success)
      refuse(
        `list takes { where, order, limit, cursor }: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
      );
    const query: AppRecordQuery = parsed.data;
    const indexed = (collection.index ?? []).join(", ") || "none";
    const where: Prisma.AppRecordWhereInput = { ...this.scope, collection: collectionName };
    for (const [field, filter] of Object.entries(query.where ?? {})) {
      const index = indexColumn(collection, field);
      if (!index)
        refuse(
          `list filters only on indexed fields of ${collectionName} (${indexed}), not ${field}.`,
        );
      Object.assign(where, rangeFor(field, index, filter));
    }
    const order =
      typeof query.order === "string"
        ? { by: query.order, direction: "asc" as const }
        : query.order;
    const direction = order?.direction ?? "asc";
    let column = "createdAt";
    if (order && order.by !== "createdAt") {
      if (order.by === "updatedAt") column = "updatedAt";
      else {
        const index = indexColumn(collection, order.by);
        if (!index)
          refuse(
            `list sorts by createdAt, updatedAt or an indexed field (${indexed}), not ${order.by}.`,
          );
        column = index.column;
      }
    }
    const limit = query.limit ?? APP_DATA_LIST_DEFAULT;
    const rows = await this.db.appRecord.findMany({
      where,
      orderBy: [{ [column]: direction }, { id: direction }],
      take: limit + 1,
      ...(query.cursor ? { cursor: this.key(collectionName, query.cursor), skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      items: page.flatMap((row) => toRecord(row) ?? []),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async update(name: unknown, id: unknown, changes: unknown): Promise<AppRecord> {
    const { name: collectionName, collection } = this.collection(name);
    this.writable(collectionName);
    const key = this.key(collectionName, id);
    const row = await this.db.appRecord.findUnique({ where: key });
    const current = row ? toRecord(row) : null;
    if (!row || !current) refuse(`${collectionName} has no record ${String(id)}.`);
    const given = this.checked(collectionName, collection, changes, true);
    const { id: _id, createdAt: _created, updatedAt: _updated, ...kept } = current;
    // The merged record is checked whole, so a change never leaves a required field out.
    const data = this.checked(collectionName, collection, { ...kept, ...given }, false);
    const bytes = this.sized(data);
    await this.assertRoom(bytes - (row.bytes ?? 0), 0);
    const updated = await this.db.appRecord.update({
      where: key,
      data: {
        fields: data as Prisma.InputJsonObject,
        bytes,
        ...indexValues(collection, data),
        updatedAt: new Date(),
      },
    });
    this.writes.count += 1;
    return toRecord(updated)!;
  }

  /** Removing a record that is already gone succeeds, so a retried call lands the same way. */
  async remove(name: unknown, id: unknown): Promise<{ removed: boolean }> {
    const { name: collectionName } = this.collection(name);
    this.writable(collectionName);
    if (typeof id !== "string" || !ID.test(id)) return { removed: false };
    const removed = await this.db.appRecord.deleteMany({
      where: { ...this.scope, collection: collectionName, id },
    });
    if (removed.count) this.writes.count += 1;
    return { removed: removed.count > 0 };
  }

  /** Answers one `ctx.db` call a function made. */
  call(op: string, args: unknown[]): Promise<unknown> {
    switch (op) {
      case "db.insert":
        return this.insert(args[0], args[1]);
      case "db.get":
        return this.get(args[0], args[1]);
      case "db.list":
        return this.list(args[0], args[1]);
      case "db.update":
        return this.update(args[0], args[1], args[2]);
      case "db.remove":
        return this.remove(args[0], args[1]);
      default:
        return Promise.reject(new AppFunctionCallError(`Unknown call ${op}.`));
    }
  }
}
