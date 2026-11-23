import type { AppManifestInput } from "@rakazo/contracts";
import { APP_STATE_MAX_BYTES, appManifestSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { applyAppAction, parseActionInput } from "./app-state.js";

function manifest(actions: AppManifestInput["actions"], permissions = ["state"] as const) {
  return appManifestSchema.parse({
    id: "test-app",
    name: "Test",
    version: "1.0.0",
    description: "Test app.",
    entry: "app.jsx",
    permissions: [...permissions],
    actions,
  });
}

let ids = 0;
const options = { newId: () => `id${++ids}` };

const tasks = manifest([
  {
    name: "add",
    description: "Add.",
    input: { title: { type: "string", required: true, maxLength: 10 }, owner: { type: "string" } },
    effects: [{ op: "append", path: "tasks", assignId: true, max: 3 }],
  },
  {
    name: "rename",
    description: "Rename.",
    input: { id: { type: "string", required: true }, title: { type: "string" } },
    effects: [{ op: "update", path: "tasks" }],
  },
  {
    name: "toggle",
    description: "Toggle.",
    input: { id: { type: "string", required: true } },
    effects: [{ op: "toggle", path: "tasks", field: "done" }],
  },
  {
    name: "remove",
    description: "Remove.",
    input: { id: { type: "string", required: true } },
    effects: [{ op: "remove", path: "tasks" }],
  },
  {
    name: "bump",
    description: "Bump.",
    input: { by: { type: "number", integer: true, min: 1, max: 5 } },
    effects: [{ op: "increment", path: "stats.count", from: "by", by: 1 }],
  },
  {
    name: "status",
    description: "Status.",
    input: { status: { type: "string", enum: ["ok", "late"], required: true } },
    effects: [
      { op: "set", path: "status", from: "status" },
      { op: "toggle", path: "flags.changed" },
    ],
  },
  { name: "reset", description: "Reset.", effects: [{ op: "set", path: "tasks", value: [] }] },
]);

describe("applyAppAction", () => {
  it("runs each kind of effect", () => {
    ids = 0;
    let state: Record<string, unknown> = {};
    const run = (name: string, input?: unknown) => {
      const outcome = applyAppAction(tasks, state, name, input, options);
      if (!outcome.ok) throw new Error(outcome.error);
      state = outcome.state;
    };
    run("add", { title: "One" });
    run("add", { title: "Two", owner: "Sam" });
    run("rename", { id: "id1", title: "First" });
    run("toggle", { id: "id2" });
    run("bump", { by: 2 });
    run("bump");
    run("status", { status: "late" });
    expect(state).toEqual({
      tasks: [
        { id: "id1", title: "First" },
        { id: "id2", title: "Two", owner: "Sam", done: true },
      ],
      stats: { count: 3 },
      status: "late",
      flags: { changed: true },
    });
    run("remove", { id: "id1" });
    // Removing again is the same as removing once.
    run("remove", { id: "id1" });
    expect(state.tasks).toEqual([{ id: "id2", title: "Two", owner: "Sam", done: true }]);
    run("reset");
    expect(state.tasks).toEqual([]);
  });

  it("keeps only the newest items past max", () => {
    let state: Record<string, unknown> = {};
    for (const title of ["a", "b", "c", "d"]) {
      const outcome = applyAppAction(tasks, state, "add", { title }, options);
      if (outcome.ok) state = outcome.state;
    }
    expect((state.tasks as { title: string }[]).map((task) => task.title)).toEqual(["b", "c", "d"]);
  });

  it("never changes the state it was given", () => {
    const state = Object.freeze({ tasks: Object.freeze([]) });
    const outcome = applyAppAction(tasks, state, "add", { title: "x" }, options);
    expect(outcome.ok).toBe(true);
    expect(state.tasks).toEqual([]);
  });

  it("refuses an app without the state permission", () => {
    const stateless = { ...tasks, permissions: [] };
    expect(applyAppAction(stateless, {}, "reset", {}, options)).toEqual({
      ok: false,
      error: "This app keeps no state.",
    });
  });

  it.each([
    ["an undeclared action", "drop", {}],
    ["an action named like an object method", "toString", {}],
    ["an action named __proto__", "__proto__", {}],
    ["a non-string action name", { name: "add" }, {}],
    ["an undeclared input", "add", { title: "x", admin: true }],
    ["a missing required input", "add", {}],
    ["text that is too long", "add", { title: "x".repeat(11) }],
    ["a wrong type", "add", { title: 5 }],
    ["a value outside the enum", "status", { status: "done" }],
    ["a number out of range", "bump", { by: 9 }],
    ["a fractional number for an integer", "bump", { by: 1.5 }],
    ["NaN", "bump", { by: Number.NaN }],
    ["an input that is a list", "add", ["x"]],
    ["an input that is a string", "add", "x"],
    ["an update for an item that does not exist", "rename", { id: "nope" }],
  ])("refuses %s", (_label, name, input) => {
    const outcome = applyAppAction(tasks, { tasks: [] }, name, input, options);
    expect(outcome.ok).toBe(false);
  });

  it("refuses inputs that try to reach a prototype", () => {
    for (const json of [
      '{"title":"x","__proto__":{"polluted":true}}',
      '{"title":"x","constructor":{"prototype":{"polluted":true}}}',
    ]) {
      const outcome = applyAppAction(tasks, {}, "add", JSON.parse(json), options);
      expect(outcome.ok).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses an input object made by a class", () => {
    class Sneaky {
      title = "x";
    }
    expect(applyAppAction(tasks, {}, "add", new Sneaky(), options).ok).toBe(false);
  });

  it("does not follow a stored __proto__ key", () => {
    const state = JSON.parse('{"stats":{"__proto__":{"count":1}}}');
    const outcome = applyAppAction(tasks, state, "bump", { by: 1 }, options);
    expect(outcome).toEqual({ ok: true, state: expect.anything() });
    if (outcome.ok) expect((outcome.state.stats as { count: number }).count).toBe(1);
    expect(({} as Record<string, unknown>).count).toBeUndefined();
  });

  it("refuses to walk through something that is not an object", () => {
    const outcome = applyAppAction(tasks, { stats: "full" }, "bump", { by: 1 }, options);
    expect(outcome).toEqual({
      ok: false,
      error: "stats.count does not lead to a value in the app's state.",
    });
  });

  it("refuses a change that would make the state too large", () => {
    const big = manifest([
      {
        name: "grow",
        description: "Grow.",
        input: { text: { type: "string", maxLength: 4000 } },
        effects: [{ op: "append", path: "log", from: "text" }],
      },
    ]);
    let state: Record<string, unknown> = {};
    let outcome = applyAppAction(big, state, "grow", { text: "x".repeat(4000) }, options);
    while (outcome.ok) {
      state = outcome.state;
      outcome = applyAppAction(big, state, "grow", { text: "x".repeat(4000) }, options);
    }
    expect(outcome.error).toContain(String(APP_STATE_MAX_BYTES));
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(APP_STATE_MAX_BYTES);
  });
});

it("skips optional inputs that were not given and keeps the declared ones", () => {
  const action = tasks.actions[0]!;
  expect(parseActionInput(action, { title: "x", owner: null })).toEqual({
    ok: true,
    input: { title: "x" },
  });
});
