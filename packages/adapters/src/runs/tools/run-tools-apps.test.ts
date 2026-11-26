import type { AppManifestInput, AppPermission } from "@rakazo/contracts";
import { appManifestSchema } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appReleaseDigest } from "../../apps/app-bundle.js";
import { runAppPageAction } from "../../apps/app-pages.js";
import { appTools } from "./run-tools-apps.js";

const { publishMessage } = vi.hoisted(() => ({ publishMessage: vi.fn() }));
vi.mock("../assembly/run-messages.js", async (importActual) => ({
  ...(await importActual<typeof import("../assembly/run-messages.js")>()),
  publishMessage: (...args: unknown[]) => publishMessage(...args),
}));

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
  cards: [
    {
      name: "summary",
      title: "Summary",
      description: "The count so far.",
      input: { label: { type: "string", maxLength: 20 } },
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
      cards: [
        {
          name: "summary",
          title: "Summary",
          description: "The count so far.",
          input: { label: { type: "string", maxLength: 20 } },
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
      error: "pageId or app_id is required.",
    });
    expect(await appTools.run_app_action!(full.ctx, call({ pageId: "page-1" }))).toEqual({
      error: "action is required.",
    });
  });
});

describe("installed apps by app_id", () => {
  type Row = Record<string, unknown>;
  const BOT_RIGHTS: AppPermission[] = ["state", "agent:read", "agent:actions"];

  /** Rows a Prisma `where` of plain fields, `OR` and nested objects finds; a nested filter never matches here. */
  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) =>
      key === "OR" ? (value as Row[]).some((branch) => matches(row, branch)) : row[key] === value,
    );
  }

  /**
   * One app installed by user-1 in space-1, its release as the store keeps it, and the pages
   * the database holds; the run is user-1's in space-1 unless `run` says otherwise.
   */
  function installed(
    options: {
      permissions?: AppPermission[];
      granted?: AppPermission[];
      run?: { spaceId?: string; userId?: string; trigger?: string };
    } = {},
  ) {
    const permissions = options.permissions ?? BOT_RIGHTS;
    const manifest = appManifestSchema.parse(app(permissions));
    const stored = { manifest, source: "app source", code: "app code", icon: null };
    const release: Row = { id: "release-1", ...stored, digest: appReleaseDigest(stored) };
    const installs: Row[] = [
      {
        id: "install-1",
        spaceId: "space-1",
        userId: "user-1",
        kind: "app",
        source: "app:counter",
        digest: release.digest,
        config: {
          releaseId: "release-1",
          appId: "counter",
          granted: options.granted ?? permissions,
        },
        createdAt: new Date(0),
      },
    ];
    const pages: Row[] = [];
    const findPage = async ({ where }: { where: Row }) =>
      pages.find((row) => matches(row, where)) ?? null;
    const prisma = {
      capabilityInstall: {
        findFirst: vi.fn(
          async ({ where }: { where: Row }) => installs.find((row) => matches(row, where)) ?? null,
        ),
      },
      appRelease: {
        findUnique: vi.fn(async ({ where }: { where: Row }) =>
          where.id === release.id ? release : null,
        ),
      },
      page: {
        findFirst: vi.fn(findPage),
        findFirstOrThrow: vi.fn(findPage),
        create: vi.fn(async ({ data }: { data: Row }) => {
          const version = (data.versions as { create: Row }).create;
          const row: Row = {
            ...data,
            id: `page-${pages.length + 1}`,
            botId: null,
            groupId: null,
            currentVersion: 1,
            appState: null,
            appRevision: 0,
            versions: [{ id: "version-1", app: version.app }],
          };
          pages.push(row);
          return row;
        }),
        updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
          const row = pages.find((page) => matches(page, where));
          if (row) Object.assign(row, data);
          return { count: row ? 1 : 0 };
        }),
      },
    };
    const publishSpaceChange = vi.fn(async () => {});
    const ctx = {
      deps: { prisma, events: { publishSpaceChange } },
      run: {
        id: "run-1",
        spaceId: "space-1",
        userId: "user-1",
        threadId: "thread-1",
        botId: "bot-1",
        trigger: "chat",
        ...options.run,
      },
      bot: { id: "bot-1" },
      thread: { groupId: null },
      context: { signal: new AbortController().signal },
    } as never;
    return { ctx, prisma, installs, release, pages, publishSpaceChange };
  }

  beforeEach(() => {
    publishMessage.mockReset();
    publishMessage.mockResolvedValue({ id: "message-1" });
  });

  it("reads an installed app's initial state before first use, without making its page", async () => {
    const { ctx, prisma } = installed();
    expect(await appTools.read_app_state!(ctx, call({ app_id: "counter" }))).toEqual({
      app_id: "counter",
      app: "Counter",
      version: "1.0.0",
      state: { count: 0 },
      revision: 0,
      actions: [
        {
          name: "bump",
          description: "Add some.",
          input: { by: { type: "number", integer: true, min: 1, max: 5 } },
        },
      ],
      cards: [
        {
          name: "summary",
          title: "Summary",
          description: "The count so far.",
          input: { label: { type: "string", maxLength: 20 } },
        },
      ],
    });
    expect(prisma.page.create).not.toHaveBeenCalled();
    // Looked up for the run's own person in the run's Space only.
    expect(prisma.capabilityInstall.findFirst.mock.calls[0]![0].where).toMatchObject({
      userId: "user-1",
      kind: "app",
      source: "app:counter",
      OR: expect.arrayContaining([{ spaceId: "space-1" }]),
    });
  });

  it("runs an action on the page that keeps the app's state, made once from the installed version", async () => {
    const { ctx, prisma, pages, publishSpaceChange } = installed();
    const first = await appTools.run_app_action!(
      ctx,
      call({ app_id: "counter", action: "bump", input: { by: 3 } }),
    );
    expect(first).toEqual({ app_id: "counter", state: { count: 3 }, revision: 1 });
    expect(publishSpaceChange).toHaveBeenCalledWith("space-1", "apps");
    expect(prisma.page.create).toHaveBeenCalledTimes(1);
    expect(prisma.page.create.mock.calls[0]![0].data).toMatchObject({
      spaceId: "space-1",
      userId: "user-1",
      appInstallId: "install-1",
      title: "Counter",
      versions: {
        create: {
          version: 1,
          source: "app source",
          code: "app code",
          app: expect.objectContaining({ id: "counter" }),
        },
      },
    });
    // The page belongs to no bot, so no save_page reaches its code.
    expect(prisma.page.create.mock.calls[0]![0].data).not.toHaveProperty("botId");

    await appTools.run_app_action!(
      ctx,
      call({ app_id: "counter", action: "bump", input: { by: 1 } }),
    );
    expect(prisma.page.create).toHaveBeenCalledTimes(1);
    expect(await appTools.read_app_state!(ctx, call({ app_id: "counter" }))).toMatchObject({
      state: { count: 4 },
      revision: 2,
    });
    // By pageId, the bot does not reach it: the app is reached by app_id only.
    expect(await appTools.read_app_state!(ctx, call({ pageId: pages[0]!.id as string }))).toEqual({
      error: "No app with that pageId belongs to this bot or chat.",
    });
  });

  it.each([
    ["an unknown app_id", { app_id: "timer" }, {}],
    ["another person's install", { app_id: "counter" }, { run: { userId: "user-2" } }],
    ["an install in another Space", { app_id: "counter" }, { run: { spaceId: "space-2" } }],
  ] as const)("treats %s as not installed", async (_label, args, options) => {
    const { ctx, prisma, publishSpaceChange } = installed(options);
    const refused = { error: "No installed app with that app_id here. find_apps lists them." };
    expect(await appTools.read_app_state!(ctx, call(args))).toEqual(refused);
    expect(await appTools.run_app_action!(ctx, call({ ...args, action: "bump" }))).toEqual(refused);
    expect(await appTools.open_app!(ctx, call(args))).toEqual(refused);
    expect(prisma.page.create).not.toHaveBeenCalled();
    expect(publishSpaceChange).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it("treats a removed app as not installed", async () => {
    const { ctx, installs } = installed();
    installs.length = 0;
    expect(await appTools.read_app_state!(ctx, call({ app_id: "counter" }))).toEqual({
      error: "No installed app with that app_id here. find_apps lists them.",
    });
  });

  it("refuses an app whose stored version changed since it was installed, as a launch does", async () => {
    const { ctx, prisma, release } = installed();
    release.source = "changed source";
    const changed = {
      error: "This app changed since it was installed. Remove it and install it again.",
    };
    expect(await appTools.read_app_state!(ctx, call({ app_id: "counter" }))).toEqual(changed);
    expect(
      await appTools.run_app_action!(ctx, call({ app_id: "counter", action: "bump" })),
    ).toEqual(changed);
    expect(await appTools.open_app!(ctx, call({ app_id: "counter" }))).toEqual(changed);
    expect(prisma.page.create).not.toHaveBeenCalled();
  });

  it("refuses bot actions the install did not grant, even when the manifest allows them", async () => {
    const { ctx, prisma } = installed({ granted: ["state", "agent:read"] });
    expect(
      await appTools.run_app_action!(ctx, call({ app_id: "counter", action: "bump" })),
    ).toEqual({ error: "This app does not let bots run its actions.", unchanged: true });
    expect(await appTools.read_app_state!(ctx, call({ app_id: "counter" }))).not.toHaveProperty(
      "actions",
    );
    expect(prisma.page.create).not.toHaveBeenCalled();
    expect(prisma.page.updateMany).not.toHaveBeenCalled();
  });

  it("refuses bot actions the manifest keeps from bots, and a grant wider than the manifest", async () => {
    const manifestOnly = installed({ permissions: ["state", "agent:read"] });
    expect(
      await appTools.run_app_action!(manifestOnly.ctx, call({ app_id: "counter", action: "bump" })),
    ).toEqual({ error: "This app does not let bots run its actions.", unchanged: true });
    const widened = installed({ permissions: ["state", "agent:read"], granted: BOT_RIGHTS });
    expect(
      await appTools.run_app_action!(widened.ctx, call({ app_id: "counter", action: "bump" })),
    ).toEqual({
      error: "This app changed since it was installed. Remove it and install it again.",
    });
    expect(manifestOnly.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(widened.prisma.page.updateMany).not.toHaveBeenCalled();
  });

  it("refuses reading an app that keeps bots out, by its manifest or by its grant", async () => {
    for (const options of [
      { permissions: ["state"] as AppPermission[] },
      { granted: ["state", "agent:actions"] as AppPermission[] },
    ]) {
      const { ctx } = installed(options);
      expect(await appTools.read_app_state!(ctx, call({ app_id: "counter" }))).toEqual({
        error: "This app does not let bots read its state.",
      });
    }
  });

  it("opens an installed app with the same page card a saved page posts", async () => {
    const { ctx, prisma } = installed();
    expect(await appTools.open_app!(ctx, call({ app_id: "counter" }))).toEqual({
      app_id: "counter",
      title: "Counter",
      opened: true,
    });
    expect(publishMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "run-1", threadId: "thread-1" }),
      "bot",
      [{ kind: "page", pageId: "page-1", version: 1, title: "Counter" }],
    );
    // Opening again shows the same page, with the state kept on it.
    await appTools.open_app!(ctx, call({ app_id: "counter" }));
    expect(prisma.page.create).toHaveBeenCalledTimes(1);
    expect(publishMessage.mock.calls[1]![3]).toEqual([
      { kind: "page", pageId: "page-1", version: 1, title: "Counter" },
    ]);
  });

  it("opens an app even when the app keeps bots out of its state", async () => {
    const { ctx } = installed({ permissions: ["state"] });
    expect(await appTools.open_app!(ctx, call({ app_id: "counter" }))).toMatchObject({
      opened: true,
    });
  });

  it("shows one of the app's cards with its checked input, as data on the page block", async () => {
    const { ctx } = installed();
    expect(
      await appTools.open_app!(
        ctx,
        call({ app_id: "counter", card: "summary", input: { label: "Today" } }),
      ),
    ).toMatchObject({ opened: true, card: "summary" });
    expect(publishMessage).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "bot", [
      expect.objectContaining({
        kind: "page",
        card: { name: "summary", input: { label: "Today" } },
      }),
    ]);
    publishMessage.mockClear();
    for (const args of [
      { app_id: "counter", card: "weekly" },
      { app_id: "counter", card: "summary", input: { label: "x".repeat(21) } },
      { app_id: "counter", card: "summary", input: { owner: "someone" } },
      { app_id: "counter", input: { label: "Today" } },
    ])
      expect(await appTools.open_app!(ctx, call(args))).toHaveProperty("error");
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it("says when there is no chat to open the app in", async () => {
    const { ctx } = installed({ run: { trigger: "subagent" } });
    publishMessage.mockResolvedValue(null);
    expect(await appTools.open_app!(ctx, call({ app_id: "counter" }))).toEqual({
      error: "Apps open only in a chat with the user.",
    });
  });

  it("takes one reference, and app_id for open_app", async () => {
    const { ctx } = installed();
    expect(
      await appTools.read_app_state!(ctx, call({ pageId: "page-1", app_id: "counter" })),
    ).toEqual({ error: "Pass pageId or app_id, not both." });
    expect(await appTools.open_app!(ctx, call({}))).toEqual({
      error: "app_id is required; card is a card name and input an object.",
    });
  });

  it("keeps the engine to the grant it is given on the stored manifest", async () => {
    const { ctx } = context({
      app: app(BOT_RIGHTS),
      appState: { count: 2 },
      appRevision: 5,
    });
    const prisma = (ctx as { deps: { prisma: never } }).deps.prisma;
    const request = { by: "agent" as const, action: "bump", input: {} };
    expect(
      await runAppPageAction(prisma, { id: "page-1" }, request, { granted: ["state"] }),
    ).toEqual({
      ok: false,
      reason: "forbidden",
      error: "This app does not let bots run its actions.",
    });
    expect(
      await runAppPageAction(prisma, { id: "page-1" }, request, { granted: BOT_RIGHTS }),
    ).toMatchObject({ ok: true, state: { count: 3 } });
  });
});
