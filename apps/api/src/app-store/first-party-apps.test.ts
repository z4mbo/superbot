import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckedAppBundle } from "@rakazo/adapters";
import { AppFunctionCallError, appFunctionRuntime } from "@rakazo/adapters";
import { parseActionInput } from "@rakazo/plugin-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { FIRST_PARTY_APPS, firstPartyBundle } from "./first-party-apps.js";

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples");

/** Records as the platform keeps them, in memory: ids in order, a date filter, and remove. */
function memoryRecords() {
  const rows: Array<Record<string, unknown>> = [];
  let next = 0;
  return {
    rows,
    async call(op: string, args: unknown[]): Promise<unknown> {
      const [collection, value] = args as [string, Record<string, unknown>];
      if (collection !== "entries") throw new AppFunctionCallError("unknown collection");
      if (op === "db.insert") {
        next += 1;
        const row = { ...value, id: `e${next}`, createdAt: "", updatedAt: "" };
        rows.push(row);
        return row;
      }
      if (op === "db.list") {
        const where = (value.where ?? {}) as { date?: string };
        return { items: rows.filter((row) => row.date === where.date), nextCursor: null };
      }
      if (op === "db.remove") {
        const at = rows.findIndex((row) => row.id === value);
        if (at >= 0) rows.splice(at, 1);
        return { removed: at >= 0 };
      }
      throw new AppFunctionCallError(`unexpected ${op}`);
    },
  };
}

describe("first-party apps", () => {
  it.each(FIRST_PARTY_APPS)("%s passes the checks a submitted app does", async (id) => {
    const checked = await firstPartyBundle(path.join(examples, id));
    expect(checked.ok ? [] : checked.errors).toEqual([]);
  });
});

describe("Food Diary", () => {
  let bundle: CheckedAppBundle;
  const records = memoryRecords();

  beforeAll(async () => {
    const checked = await firstPartyBundle(path.join(examples, "food-diary"));
    if (!checked.ok) throw new Error(checked.errors.join("\n"));
    bundle = checked.bundle;
  });

  /** Runs one action as the platform does: its input checked first, then its function. */
  async function run(name: string, input: Record<string, unknown>) {
    const action = bundle.manifest.actions.find((entry) => entry.name === name)!;
    const parsed = parseActionInput(action, input);
    if (!parsed.ok) return { ok: false as const, error: parsed.error };
    const engine = await appFunctionRuntime();
    return engine.run({
      source: bundle.server!,
      file: "server.js",
      name: action.run!,
      input: parsed.input,
      context: { now: "2026-11-26T12:00:00.000Z", today: "2026-11-26", timeZone: "UTC" },
      capabilities: { db: true, readOnly: action.readOnly === true, fetch: false },
      host: records,
    });
  }

  it("offers the actions and inputs the nutrition coach uses", () => {
    const byName = Object.fromEntries(
      bundle.manifest.actions.map((action) => [action.name, action]),
    );
    expect(bundle.manifest.name).toBe("Food Diary");
    expect(Object.keys(byName.day!.input)).toEqual(["date"]);
    expect(byName.day!.readOnly).toBe(true);
    expect(Object.keys(byName.addEntry!.input).sort()).toEqual(
      ["carbs", "date", "fat", "food", "grams", "kcal", "meal", "protein"].sort(),
    );
    expect(byName.addEntry!.input.meal).toMatchObject({
      enum: ["breakfast", "lunch", "dinner", "snack"],
    });
    expect(bundle.manifest.cards?.map((card) => card.name)).toEqual(["day"]);
  });

  it("logs food and totals the day by meal", async () => {
    const yogurt = await run("addEntry", {
      food: "Greek yogurt",
      grams: 150,
      meal: "breakfast",
      kcal: 146,
      protein: 15,
      carbs: 6,
      fat: 6,
    });
    expect(yogurt).toMatchObject({
      ok: true,
      result: { entry: { food: "Greek yogurt", meal: "breakfast" }, totals: { kcal: 146 } },
    });
    // Without calories, the macros give them; without a meal, it is a snack; without a day, today.
    const banana = await run("addEntry", { food: "Banana", grams: 120, carbs: 27, protein: 1 });
    expect(banana).toMatchObject({
      ok: true,
      result: { entry: { meal: "snack", date: "2026-11-26", kcal: 112 } },
    });
    await run("addEntry", { food: "Soup", grams: 300, date: "2026-11-25", kcal: 200 });
    const day = await run("day", {});
    expect(day).toMatchObject({
      ok: true,
      result: {
        date: "2026-11-26",
        count: 2,
        totals: { kcal: 258, protein: 16, carbs: 33, fat: 6, grams: 270 },
        meals: [
          { meal: "breakfast", entries: [{ food: "Greek yogurt" }] },
          { meal: "snack", entries: [{ food: "Banana" }] },
        ],
      },
    });
    expect(await run("day", { date: "2026-11-25" })).toMatchObject({
      ok: true,
      result: { count: 1, totals: { kcal: 200 } },
    });
  });

  it("removes an entry by its id", async () => {
    const day = await run("day", {});
    const id = (day as { result: { meals: Array<{ entries: Array<{ id: string }> }> } }).result
      .meals[0]!.entries[0]!.id;
    expect(await run("removeEntry", { id })).toEqual({ ok: true, result: { removed: true } });
  });

  it.each([
    ["a day that is not one", "day", { date: "2026-02-30" }],
    ["a day in another shape", "day", { date: "26/11/2026" }],
    ["a meal it does not know", "addEntry", { food: "Tea", grams: 200, meal: "brunch" }],
    ["food without grams", "addEntry", { food: "Tea" }],
    ["negative grams", "addEntry", { food: "Tea", grams: -1 }],
    ["a blank food", "addEntry", { food: "  ", grams: 10 }],
  ])("refuses %s", async (_label, name, input) => {
    expect(await run(name, input)).toMatchObject({ ok: false });
  });
});
