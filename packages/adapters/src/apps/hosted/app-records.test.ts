import type { AppData } from "@rakazo/contracts";
import {
  APP_DATA_RECORD_MAX_BYTES,
  APP_DATA_RECORDS_MAX,
  APP_DATA_TOTAL_MAX_BYTES,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { AppFunctionCallError } from "../functions/app-function-runtime.js";
import { AppRecords } from "./app-records.js";

const data: AppData = {
  collections: {
    entries: {
      fields: {
        date: { type: "string", required: true, maxLength: 10 },
        food: { type: "string", required: true, maxLength: 4000 },
        grams: { type: "number", min: 0 },
        done: { type: "boolean" },
      },
      index: ["date", "grams", "done"],
    },
  },
};

const SCOPE = { installId: "install-1", spaceId: "space-1" };

/** The calls the store makes, answered as an empty install of the given size would be. */
function fakeDb(totals: { count?: number; bytes?: number } = {}) {
  const row = (args: { data: Record<string, unknown> }) => ({
    ...args.data,
    createdAt: new Date("2026-11-26T10:00:00Z"),
    updatedAt: new Date("2026-11-26T10:00:00Z"),
  });
  const appRecord = {
    aggregate: vi.fn(async () => ({
      _count: { _all: totals.count ?? 0 },
      _sum: { bytes: totals.bytes ?? 0 },
    })),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => row(args)),
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  };
  return { appRecord } as unknown as ConstructorParameters<typeof AppRecords>[0] & {
    appRecord: typeof appRecord;
  };
}

async function refused(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppFunctionCallError);
  return (error as Error).message;
}

describe("AppRecords", () => {
  it("stores a checked record under this install and Space, with its indexed fields", async () => {
    const db = fakeDb();
    const records = new AppRecords(db, SCOPE, data, { readOnly: false, newId: () => "r1" });
    const saved = await records.insert("entries", { date: "2026-11-26", food: "Rice", grams: 90 });
    expect(saved).toMatchObject({ id: "r1", date: "2026-11-26", food: "Rice", grams: 90 });
    expect(db.appRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        installId: "install-1",
        spaceId: "space-1",
        collection: "entries",
        id: "r1",
        s0: "2026-11-26",
        n1: 90,
        s2: null,
      }),
    });
    expect(db.appRecord.aggregate).toHaveBeenCalledWith(expect.objectContaining({ where: SCOPE }));
    expect(records.writes.count).toBe(1);
  });

  it.each([
    ["a collection the app does not declare", "meals", { date: "2026-11-26", food: "x" }],
    ["a field the collection does not declare", "entries", { date: "d", food: "x", owner: "y" }],
    ["a value of the wrong type", "entries", { date: "d", food: "x", grams: "lots" }],
    ["a missing required field", "entries", { food: "x" }],
    ["a value past its limit", "entries", { date: "2026-11-26-extra", food: "x" }],
    ["a key that reaches a prototype", "entries", JSON.parse('{"__proto__":{"x":1}}')],
    ["something that is not an object", "entries", ["x"]],
  ])("refuses %s without writing", async (_label, collection, value) => {
    const db = fakeDb();
    const records = new AppRecords(db, SCOPE, data);
    await refused(records.insert(collection, value));
    expect(db.appRecord.create).not.toHaveBeenCalled();
  });

  it("keeps a read-only action from writing", async () => {
    const db = fakeDb();
    const records = new AppRecords(db, SCOPE, data, { readOnly: true });
    await refused(records.insert("entries", { date: "2026-11-26", food: "Rice" }));
    await refused(records.update("entries", "r1", { food: "Rice" }));
    await refused(records.remove("entries", "r1"));
    expect(db.appRecord.create).not.toHaveBeenCalled();
    expect(db.appRecord.deleteMany).not.toHaveBeenCalled();
  });

  it("holds each record, and the install's records together, to their limits", async () => {
    const big = { date: "2026-11-26", food: "x".repeat(4000), grams: 1 };
    const records = new AppRecords(fakeDb(), SCOPE, {
      collections: {
        entries: {
          fields: Object.fromEntries(
            Array.from({ length: 5 }, (_, i) => [`f${i}`, { type: "string", maxLength: 4000 }]),
          ),
        },
      },
    });
    const huge = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`f${i}`, "x".repeat(4000)]),
    );
    expect(await refused(records.insert("entries", huge))).toContain(
      String(APP_DATA_RECORD_MAX_BYTES),
    );
    const full = new AppRecords(fakeDb({ count: APP_DATA_RECORDS_MAX }), SCOPE, data);
    expect(await refused(full.insert("entries", big))).toContain(String(APP_DATA_RECORDS_MAX));
    const heavy = new AppRecords(fakeDb({ bytes: APP_DATA_TOTAL_MAX_BYTES }), SCOPE, data);
    expect(await refused(heavy.insert("entries", big))).toContain(String(APP_DATA_TOTAL_MAX_BYTES));
  });

  it("lists only this install's records, filtering and sorting on indexed fields alone", async () => {
    const db = fakeDb();
    const records = new AppRecords(db, SCOPE, data);
    await records.list("entries", { where: { date: "2026-11-26", grams: { gte: 10 } } });
    expect(db.appRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...SCOPE, collection: "entries", s0: "2026-11-26", n1: { gte: 10 } },
      }),
    );
    await refused(records.list("entries", { where: { food: "Rice" } }));
    await refused(records.list("entries", { order: "food" }));
    await refused(records.list("entries", { where: { date: 5 } }));
    await refused(records.list("entries", { where: { done: { gt: "a" } } }));
    await refused(records.list("entries", { limit: 10_000 }));
  });

  it("names records only by an id it gave, within this install and Space", async () => {
    const db = fakeDb();
    const records = new AppRecords(db, SCOPE, data);
    await refused(records.get("entries", "../other"));
    await refused(records.get("entries", { id: "r1" }));
    await records.get("entries", "r1");
    expect(db.appRecord.findUnique).toHaveBeenCalledWith({
      where: { installId_spaceId_collection_id: { ...SCOPE, collection: "entries", id: "r1" } },
    });
    expect(await records.remove("entries", { not: "an id" })).toEqual({ removed: false });
    await records.remove("entries", "r1");
    expect(db.appRecord.deleteMany).toHaveBeenCalledWith({
      where: { ...SCOPE, collection: "entries", id: "r1" },
    });
  });

  it("answers only the calls it knows", async () => {
    const records = new AppRecords(fakeDb(), SCOPE, data);
    await refused(records.call("db.drop", ["entries"]));
  });
});
