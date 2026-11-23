import type { AppManifestInput } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appTools } from "./run-tools-apps.js";

const app = (permissions: AppManifestInput["permissions"]): AppManifestInput => ({
  id: "counter",
  name: "Counter",
  version: "1.0.0",
  description: "Counts.",
  entry: "app.jsx",
  permissions,
  initialState: { count: 0 },
  actions: [
    {
      name: "bump",
      description: "Add some.",
      input: { by: { type: "number", integer: true, min: 1, max: 5 } },
      effects: [{ op: "increment", path: "count", from: "by", by: 1 }],
    },
  ],
});

type Row = { app: unknown; appState: unknown; appRevision: number } | null;

function context(row: Row, moved: number[] = [1]) {
  const updateMany = vi.fn(async () => ({ count: moved.shift() ?? 1 }));
  const findFirst = vi.fn(async (_query: { where: Record<string, unknown> }) =>
    row
      ? {
          id: "page-1",
          spaceId: "space-1",
          title: "Counter",
          appState: row.appState,
          appRevision: row.appRevision,
          versions: [{ id: "version-1", app: row.app }],
        }
      : null,
  );
  const publishSpaceChange = vi.fn(async () => {});
  const ctx = {
    deps: { prisma: { page: { findFirst, updateMany } }, events: { publishSpaceChange } },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1" },
    bot: { id: "bot-1" },
    thread: { groupId: null },
  } as never;
  return { ctx, findFirst, updateMany, publishSpaceChange };
}

const call = (args: Record<string, unknown>) =>
  ({ args, finish: async (result: unknown) => result }) as never;

describe("read_app_state", () => {
  it("reads an app that lets bots read it, with the actions it lets bots run", async () => {
    const { ctx, findFirst } = context({
      app: app(["state", "agent:read", "agent:actions"]),
      appState: { count: 2 },
      appRevision: 5,
    });
    expect(await appTools.read_app_state!(ctx, call({ pageId: "page-1" }))).toEqual({
      pageId: "page-1",
      app: "Counter",
      version: "1.0.0",
      state: { count: 2 },
      revision: 5,
      actions: [
        {
          name: "bump",
          description: "Add some.",
          input: { by: { type: "number", integer: true, min: 1, max: 5 } },
        },
      ],
    });
    // Only this bot's own pages are in reach.
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      id: "page-1",
      spaceId: "space-1",
      userId: "user-1",
      OR: [{ botId: "bot-1" }],
    });
  });

  it("starts from the manifest's initial state and hides actions bots may not run", async () => {
    const { ctx } = context({ app: app(["state", "agent:read"]), appState: null, appRevision: 0 });
    const result = (await appTools.read_app_state!(ctx, call({ pageId: "page-1" }))) as Record<
      string,
      unknown
    >;
    expect(result.state).toEqual({ count: 0 });
    expect(result).not.toHaveProperty("actions");
  });

  it("refuses an app that does not let bots read it, a plain page and a missing page", async () => {
    for (const row of [
      { app: app(["state"]), appState: { secret: "x" }, appRevision: 1 },
      { app: null, appState: null, appRevision: 0 },
      null,
    ]) {
      const { ctx } = context(row);
      const result = (await appTools.read_app_state!(ctx, call({ pageId: "page-1" }))) as Record<
        string,
        unknown
      >;
      expect(result).toEqual({ error: expect.any(String) });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });
});

describe("run_app_action", () => {
  let full: ReturnType<typeof context>;
  beforeEach(() => {
    full = context({
      app: app(["state", "agent:read", "agent:actions"]),
      appState: { count: 2 },
      appRevision: 5,
    });
  });

  it("runs a declared action on the revision it read and signals open apps", async () => {
    const result = await appTools.run_app_action!(
      full.ctx,
      call({ pageId: "page-1", action: "bump", input: { by: 3 } }),
    );
    expect(result).toEqual({ pageId: "page-1", state: { count: 5 }, revision: 6 });
    expect(full.updateMany).toHaveBeenCalledWith({
      where: { id: "page-1", appRevision: 5 },
      data: { appState: { count: 5 }, appRevision: 6 },
    });
    expect(full.publishSpaceChange).toHaveBeenCalledWith("space-1", "apps");
  });

  it("tries again on a fresh read when another write landed first, then gives up", async () => {
    const raced = context(
      { app: app(["state", "agent:actions"]), appState: { count: 2 }, appRevision: 5 },
      [0, 0, 0],
    );
    const result = await appTools.run_app_action!(
      raced.ctx,
      call({ pageId: "page-1", action: "bump" }),
    );
    expect(raced.updateMany).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ error: expect.stringContaining("try again"), unchanged: true });
    expect(raced.publishSpaceChange).not.toHaveBeenCalled();
  });

  it.each([
    ["an app that keeps bots out", ["state", "agent:read"], "bump", {}],
    ["an app with no state", [], "bump", {}],
    ["an undeclared action", ["state", "agent:actions"], "wipe", {}],
    ["an action named like an object method", ["state", "agent:actions"], "constructor", {}],
    ["an input out of range", ["state", "agent:actions"], "bump", { by: 50 }],
    ["an undeclared input", ["state", "agent:actions"], "bump", { by: 1, admin: true }],
    ["a prototype input", ["state", "agent:actions"], "bump", JSON.parse('{"__proto__":{"x":1}}')],
  ] as const)("refuses %s and changes nothing", async (_label, permissions, action, input) => {
    const stored = { count: 2 };
    const manifest = app([...permissions] as AppManifestInput["permissions"]);
    if (permissions.length === 0) manifest.actions = [];
    const { ctx, updateMany, publishSpaceChange } = context({
      app: manifest,
      appState: stored,
      appRevision: 5,
    });
    const result = await appTools.run_app_action!(ctx, call({ pageId: "page-1", action, input }));
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(updateMany).not.toHaveBeenCalled();
    expect(publishSpaceChange).not.toHaveBeenCalled();
    expect(stored).toEqual({ count: 2 });
  });

  it("asks for the page and the action", async () => {
    expect(await appTools.run_app_action!(full.ctx, call({ action: "bump" }))).toEqual({
      error: "pageId is required.",
    });
    expect(await appTools.run_app_action!(full.ctx, call({ pageId: "page-1" }))).toEqual({
      error: "action is required.",
    });
  });
});
