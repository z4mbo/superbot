import { describe, expect, it } from "vitest";
import { appNetworkHostProblem } from "./app-data.js";
import { appManifestSchema, appNeedsInstall } from "./app-manifest.js";

const base = {
  id: "food-log",
  name: "Food log",
  version: "1.0.0",
  description: "Logs food.",
  entry: "src/app.jsx",
};

const hosted = {
  ...base,
  server: "src/server.js",
  permissions: ["data", "agent:read", "agent:actions", "network"],
  data: {
    collections: {
      entries: {
        fields: { date: { type: "string", required: true }, kcal: { type: "number" } },
        index: ["date"],
      },
    },
  },
  network: { hosts: ["api.example.com"] },
  actions: [
    { name: "add", description: "Add.", input: { kcal: { type: "number" } }, run: "add" },
    { name: "day", description: "A day.", run: "day", readOnly: true },
  ],
  cards: [{ name: "summary", title: "Summary", description: "The day's totals." }],
};

function problems(manifest: unknown): string[] {
  const parsed = appManifestSchema.safeParse(manifest);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe("hosted apps", () => {
  it("accepts data, functions, network and cards together", () => {
    const manifest = appManifestSchema.parse(hosted);
    expect(manifest.actions.map((action) => action.run)).toEqual(["add", "day"]);
    expect(appNeedsInstall(manifest)).toBe(true);
  });

  it("adds no keys to a manifest that does not use them, so its digest is unchanged", () => {
    expect(Object.keys(appManifestSchema.parse(base)).sort()).toEqual([
      "actions",
      "description",
      "entry",
      "id",
      "initialState",
      "name",
      "permissions",
      "version",
    ]);
    expect(appNeedsInstall(appManifestSchema.parse(base))).toBe(false);
  });

  it.each([
    [
      "an action with both effects and run",
      {
        ...hosted,
        actions: [{ name: "x", description: "x", run: "x", effects: [{ op: "set", path: "a" }] }],
      },
    ],
    ["an action with neither", { ...hosted, actions: [{ name: "x", description: "x" }] }],
    [
      "a read-only action backed by effects",
      {
        ...hosted,
        permissions: [...hosted.permissions, "state"],
        actions: [
          { name: "x", description: "x", readOnly: true, effects: [{ op: "set", path: "a" }] },
        ],
      },
    ],
    ["a run action without a server file", { ...hosted, server: undefined }],
    ["collections without the data permission", { ...hosted, permissions: ["network"] }],
    ["the data permission without collections", { ...hosted, data: undefined }],
    ["hosts without the network permission", { ...hosted, permissions: ["data"] }],
    [
      "a reserved field name",
      { ...hosted, data: { collections: { entries: { fields: { id: { type: "string" } } } } } },
    ],
    [
      "an index on an undeclared field",
      {
        ...hosted,
        data: { collections: { entries: { fields: { a: { type: "string" } }, index: ["b"] } } },
      },
    ],
    [
      "too many indexed fields",
      {
        ...hosted,
        data: {
          collections: {
            entries: {
              fields: {
                a: { type: "string" },
                b: { type: "string" },
                c: { type: "string" },
                d: { type: "string" },
              },
              index: ["a", "b", "c", "d"],
            },
          },
        },
      },
    ],
    ["a card named twice", { ...hosted, cards: [hosted.cards[0], hosted.cards[0]] }],
    [
      "a reserved function name",
      { ...hosted, actions: [{ name: "x", description: "x", run: "then" }] },
    ],
  ])("refuses %s", (_label, manifest) => {
    expect(problems(manifest).length).toBeGreaterThan(0);
  });

  it("refuses effects without the state permission", () => {
    expect(
      problems({
        ...hosted,
        actions: [{ name: "x", description: "x", effects: [{ op: "set", path: "a" }] }],
      }),
    ).toContain('Effects change the app\'s state, so they need the "state" permission.');
  });
});

describe("appNetworkHostProblem", () => {
  it.each(["api.example.com", "a.b.example.co.uk", "x1.io"])("accepts %s", (host) => {
    expect(appNetworkHostProblem(host)).toBeUndefined();
  });

  it.each([
    "*.example.com",
    "example",
    "127.0.0.1",
    "[::1]",
    "api.example.com:8443",
    "API.example.com",
    "localhost",
    "printer.local",
    "metadata.google.internal",
    "https://api.example.com",
    "api.example.com.",
    "1.2.3.4",
  ])("refuses %s", (host) => {
    expect(appNetworkHostProblem(host)).toBeDefined();
  });
});
