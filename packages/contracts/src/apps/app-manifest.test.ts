import { describe, expect, it } from "vitest";
import {
  APP_STATE_MAX_BYTES,
  appManifestSchema,
  appPermissionSchema,
  appRelativePathProblem,
} from "./app-manifest.js";

const base = {
  id: "team-dashboard",
  name: "Team dashboard",
  version: "1.0.0",
  description: "Open tasks and a counter.",
  entry: "src/app.jsx",
};

describe("appManifestSchema", () => {
  it("fills defaults for a minimal manifest", () => {
    expect(appManifestSchema.parse(base)).toEqual({
      ...base,
      permissions: [],
      initialState: {},
      actions: [],
    });
  });

  it("accepts actions with inputs and effects", () => {
    const manifest = appManifestSchema.parse({
      ...base,
      permissions: ["state", "agent:read", "agent:actions"],
      initialState: { tasks: [] },
      actions: [
        {
          name: "addTask",
          description: "Add a task.",
          input: { title: { type: "string", required: true, maxLength: 120 } },
          effects: [{ op: "append", path: "tasks", assignId: true }],
        },
      ],
    });
    expect(manifest.actions[0]?.effects[0]).toEqual({
      op: "append",
      path: "tasks",
      assignId: true,
    });
  });

  it.each([
    ["an id with capitals", { id: "Team" }],
    ["a version that is not semantic", { version: "1.0" }],
    ["a version with a leading v", { version: "v1.0.0" }],
    ["an absolute entry", { entry: "/etc/app.jsx" }],
    ["an entry that climbs out", { entry: "../app.jsx" }],
    ["a backslash entry", { entry: "src\\app.jsx" }],
    ["a drive letter", { entry: "C:/app.jsx" }],
    ["a reserved Windows name", { entry: "src/con.jsx" }],
    ["an entry that is not JavaScript", { entry: "app.ts" }],
    ["an unknown permission", { permissions: ["network"] }],
    ["a repeated permission", { permissions: ["state", "state"] }],
    ["an unknown field", { homepage: "https://example.com" }],
    ["an svg icon", { icon: "icon.svg" }],
  ])("refuses %s", (_label, change) => {
    expect(appManifestSchema.safeParse({ ...base, ...change }).success).toBe(false);
  });

  it("needs the state permission for actions and for bot access", () => {
    const action = {
      name: "bump",
      description: "Add one.",
      effects: [{ op: "increment", path: "count" }],
    };
    expect(appManifestSchema.safeParse({ ...base, actions: [action] }).success).toBe(false);
    expect(appManifestSchema.safeParse({ ...base, permissions: ["agent:read"] }).success).toBe(
      false,
    );
    expect(
      appManifestSchema.safeParse({ ...base, permissions: ["state"], actions: [action] }).success,
    ).toBe(true);
  });

  it("refuses state paths and inputs that reach a prototype", () => {
    for (const path of ["__proto__", "a.constructor", "a.prototype.b", "a..b", "a-b"]) {
      expect(
        appManifestSchema.safeParse({
          ...base,
          permissions: ["state"],
          actions: [{ name: "x", description: "x", effects: [{ op: "set", path }] }],
        }).success,
      ).toBe(false);
    }
    // JSON.parse keeps "__proto__" as an own key, as an uploaded app.json would; it never
    // survives into the parsed manifest.
    const hostile = JSON.parse(
      '{"name":"x","description":"x","input":{"__proto__":{"type":"string"}},"effects":[{"op":"set","path":"a"}]}',
    );
    const parsed = appManifestSchema.parse({ ...base, permissions: ["state"], actions: [hostile] });
    expect(Object.hasOwn(parsed.actions[0]!.input, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(parsed.actions[0]!.input)).toBe(Object.prototype);
  });

  it("refuses an action named twice and an oversized initial state", () => {
    const action = { name: "x", description: "x", effects: [{ op: "set", path: "a" }] };
    expect(
      appManifestSchema.safeParse({ ...base, permissions: ["state"], actions: [action, action] })
        .success,
    ).toBe(false);
    expect(
      appManifestSchema.safeParse({
        ...base,
        initialState: { big: "x".repeat(APP_STATE_MAX_BYTES) },
      }).success,
    ).toBe(false);
  });
});

describe("appRelativePathProblem", () => {
  it("accepts nested forward-slash paths", () => {
    expect(appRelativePathProblem("src/views/main.jsx")).toBeUndefined();
  });

  it.each(["", ".", "a/./b", "a//b", "a/", "file.", "aux.txt", "LPT1"])("refuses %j", (path) => {
    expect(appRelativePathProblem(path)).toBeDefined();
  });
});

it("lists only the permissions the host enforces", () => {
  expect(appPermissionSchema.options).toEqual([
    "state",
    "agent:read",
    "agent:actions",
    "reply",
    "links",
    "clipboard",
  ]);
});
