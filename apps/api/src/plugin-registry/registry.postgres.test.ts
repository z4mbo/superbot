import { randomUUID } from "node:crypto";
import { createRouterClient, onError } from "@orpc/server";
import type { Actor, RpcInput } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import {
  addRegistryAppRecord,
  asSystem,
  createDb,
  JsonColumnMismatchError,
  listRegistryAppRecords,
  lockRegistryPluginInstallation,
  removeRegistryAppRecord,
  resolvePluginGrants,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";
import { handleRpcError } from "../rpc-errors.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const manifest = {
  schemaVersion: 1,
  name: "Release notes",
  description: "Draft release notes.",
  parts: [
    { id: "notes", kind: "skill", instructions: "Summarize the provided issues." },
    {
      id: "tracker",
      kind: "mcp",
      transport: "streamable_http",
      endpoint: "https://tracker.example.test/mcp",
    },
  ],
} satisfies RpcInput<"pluginRegistry/submit">["manifest"];

const appManifest = {
  schemaVersion: 1,
  name: "Meal log",
  description: "Track daily meals.",
  parts: [
    {
      id: "meals",
      kind: "app",
      fields: [
        { id: "meal-date", label: "Date", type: "date", required: true },
        { id: "review-date", label: "Review date", type: "date", required: false },
        { id: "calories", label: "Calories", type: "number", required: true },
        { id: "meal-name", label: "Meal", type: "text", required: false },
      ],
      summaryField: "calories",
    },
    {
      id: "reflection",
      kind: "app",
      fields: [{ id: "note", label: "Note", type: "text", required: true }],
    },
    manifest.parts[0]!,
  ],
} satisfies RpcInput<"pluginRegistry/submit">["manifest"];

describe.skipIf(!enabled)("Plugin registry (PostgreSQL)", () => {
  const tag = randomUUID();
  const org = `org-${tag}`;
  const spaceId = `space-${tag}`;
  const otherSpaceId = `other-${spaceId}`;
  const slug = `release-notes-${tag}`;
  const account = (name: string) =>
    ({
      userId: `${name}-${tag}`,
      email: `${name}-${tag}@example.test`,
      spaceId,
      isDeploymentOwner: false,
    }) satisfies Actor;
  const publisher = account("publisher");
  const admin = account("admin");
  const unverified = account("unverified");
  const installer = account("installer");
  const otherSpace = { ...installer, spaceId: otherSpaceId };
  const appOtherSpace = { ...installer, spaceId: `app-${spaceId}` };
  const botId = (actor: Actor) => `${actor.userId}:${actor.spaceId}`;
  const resolveHostname = vi.fn(async () => [{ address: "93.184.215.14", family: 4 }]);
  let db: ReturnType<typeof createDb>;
  let system: ReturnType<typeof createDb>["prisma"];
  let router: ReturnType<typeof createRouter>;

  const client = (actor: Actor | null) =>
    createRouterClient(router, {
      context: { actor },
      interceptors: [onError((error, { path }) => handleRpcError(error, path))],
    }).pluginRegistry;

  const publishApp = async (suffix: string, version = 1, releaseManifest = appManifest) => {
    const release = await client(publisher).submit({
      slug: `${slug}-${suffix}`,
      version,
      manifest: releaseManifest,
    });
    return client(admin).review({ versionId: release.id, decision: "approved" });
  };

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma, "plugin registry test fixture");
    router = createRouter({
      prisma: db.prisma,
      remoteConnectors: { resolveHostname },
      env: { adminEmails: [admin.email, unverified.email], mcpAllowPrivateEndpoint: true },
    } as unknown as RouterDeps);

    await system.organization.create({
      data: { id: org, name: "Registry fixture", slug: org, createdAt: new Date() },
    });
    for (const actor of [publisher, admin, unverified, installer]) {
      await system.user.create({
        data: {
          id: actor.userId,
          email: actor.email,
          emailVerified: actor === admin,
          name: "Registry fixture",
        },
      });
      await system.member.create({
        data: {
          id: actor.userId,
          organizationId: org,
          userId: actor.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
    }
    for (const id of [spaceId, otherSpaceId, appOtherSpace.spaceId]) {
      await system.space.create({
        data: {
          id,
          organizationId: org,
          name: "Registry Space",
          createdByUserId: publisher.userId,
        },
      });
    }
    for (const actor of [publisher, admin, unverified, installer, otherSpace, appOtherSpace]) {
      await system.spaceMember.create({
        data: {
          id: botId(actor),
          spaceId: actor.spaceId,
          organizationId: org,
          userId: actor.userId,
          createdAt: new Date(),
        },
      });
      await system.bot.create({
        data: {
          id: botId(actor),
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: "Registry bot",
          color: "blue",
        },
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await system.organization.deleteMany({ where: { id: org } });
    await system.registryPluginVersion.deleteMany({ where: { slug: { startsWith: slug } } });
    await system.registryPlugin.deleteMany({ where: { slug: { startsWith: slug } } });
    await system.user.deleteMany({
      where: { id: { in: [publisher, admin, unverified, installer].map((actor) => actor.userId) } },
    });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("enforces publisher ownership, admin review, version pinning and tenant-scoped grants", async () => {
    const submission = { slug, version: 1, manifest };
    await expect(client(null).discover({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const first = await client(publisher).submit(submission);
    expect(first.status).toBe("pending");
    expect((await client(publisher).mine({})).items).toEqual([first]);
    expect((await client(installer).mine({})).items).toEqual([]);
    expect((await client(installer).discover({ slug })).items).toEqual([]);
    await expect(client(installer).submit({ ...submission, version: 2 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(client(publisher).submit(submission)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client(publisher).install({ versionId: first.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client(unverified).submissions({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      client(publisher).review({ versionId: first.id, decision: "approved" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await client(admin).submissions({})).items).toContainEqual(first);

    const reviews = await Promise.allSettled([
      client(admin).review({ versionId: first.id, decision: "approved" }),
      client(admin).review({ versionId: first.id, decision: "approved" }),
    ]);
    expect(reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "fulfilled",
          value: expect.objectContaining({ status: "approved" }),
        }),
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "CONFLICT" }),
        }),
      ]),
    );
    expect(resolveHostname).toHaveBeenCalledWith("tracker.example.test");
    const second = await client(publisher).submit({ ...submission, version: 2 });
    await client(admin).review({ versionId: second.id, decision: "approved" });
    const rejected = await client(publisher).submit({ ...submission, version: 3 });
    await expect(
      client(admin).review({
        versionId: rejected.id,
        decision: "rejected",
        reason: "Needs a narrower capability.",
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "Needs a narrower capability." });
    const discovered = await client(installer).discover({ slug, limit: 1 });
    expect(discovered.items).toHaveLength(1);
    const next = await client(installer).discover({ slug, after: discovered.nextAfter! });
    expect([...discovered.items, ...next.items].map(({ version }) => version).sort()).toEqual([
      1, 2,
    ]);
    expect(next.nextAfter).toBeNull();

    const install = () => client(installer).install({ versionId: first.id });
    const [installed, retried] = await Promise.all([install(), install()]);
    expect(installed).toEqual(retried);
    expect(installed.grants).toEqual([]);
    await expect(client(installer).install({ versionId: second.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const ownBot = botId(installer);
    const grant = { installationId: installed.id, botId: ownBot, partIds: ["notes"] };
    const resolve = (actor: Actor, bot = botId(actor)) =>
      resolvePluginGrants(db.prisma, { ...actor, botId: bot });
    for (const actor of [otherSpace, publisher]) {
      expect((await client(actor).installations({})).items).toEqual([]);
      await expect(client(actor).setGrants(grant)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await client(actor).uninstall({ installationId: installed.id });
      await expect(
        client(installer).setGrants({ ...grant, botId: botId(actor) }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      client(installer).setGrants({ ...grant, partIds: ["unknown"] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await resolve(installer)).toEqual([]);
    await expect(client(installer).setGrants(grant)).resolves.toMatchObject({
      grants: [{ botId: ownBot, partId: "notes" }],
    });
    const [resolved] = await resolve(installer);
    expect(resolved).toEqual({
      grantId: expect.any(String),
      installationId: installed.id,
      pluginSlug: slug,
      pluginName: manifest.name,
      versionId: first.id,
      part: manifest.parts[0],
    });
    expect(await resolve(otherSpace, ownBot)).toEqual([]);
    expect(await resolve(publisher, ownBot)).toEqual([]);

    if (process.env.DATABASE_URL !== process.env.DATABASE_MIGRATION_URL) {
      await expect(
        runAsTenant(installer, () =>
          db.prisma.registryPluginGrant.create({
            data: { installationId: installed.id, partId: "notes", botId: botId(otherSpace) },
          }),
        ),
      ).rejects.toThrow(/row-level security/i);
    }

    await client(installer).setGrants({ ...grant, partIds: ["notes", "tracker"] });
    expect((await resolve(installer))[0]).toEqual(resolved);
    await client(installer).setGrants({ ...grant, partIds: [] });
    expect(await resolve(installer)).toEqual([]);
    await client(installer).setGrants(grant);
    expect((await resolve(installer))[0]?.grantId).not.toBe(resolved?.grantId);
    await client(installer).uninstall({ installationId: installed.id });
    expect(await resolve(installer)).toEqual([]);
    expect(
      await system.registryPluginGrant.count({ where: { installationId: installed.id } }),
    ).toBe(0);
    const replacement = await client(otherSpace).install({ versionId: second.id });
    await client(otherSpace).setGrants({
      ...grant,
      installationId: replacement.id,
      botId: botId(otherSpace),
    });
    await system.spaceMember.delete({ where: { id: botId(otherSpace) } });
    expect(await resolve(otherSpace)).toEqual([]);

    if (process.env.DATABASE_URL !== process.env.DATABASE_MIGRATION_URL) {
      await expect(
        runAsTenant(installer, () =>
          db.prisma.registryPluginVersion.findUnique({
            where: { id: rejected.id },
          }),
        ),
      ).resolves.toBeNull();
    }
  });

  it("switches versions atomically and invalidates grants without reviving old identities", async () => {
    const switchSlug = `${slug}-switch`;
    const publish = (version: number, releaseSlug = switchSlug) =>
      client(publisher).submit({
        slug: releaseSlug,
        version,
        manifest: { ...manifest, parts: [manifest.parts[0]!] },
      });
    const approve = async (id: string) =>
      client(admin).review({ versionId: id, decision: "approved" });
    const [first, second, third, pending, rejected, corrupt, foreign] = await Promise.all([
      publish(1),
      publish(2),
      publish(3),
      publish(4),
      publish(5),
      publish(6),
      publish(1, `${switchSlug}-other`),
    ]);
    await Promise.all([first, second, third, corrupt, foreign].map(({ id }) => approve(id)));
    await client(admin).review({ versionId: rejected.id, decision: "rejected", reason: "Fixture" });
    await system.registryPluginVersion.update({
      where: { id: corrupt.id },
      data: { manifest: {} },
    });

    const registry = client(installer);
    const installation = await registry.install({ versionId: first.id });
    const bot = botId(installer);
    const grant = { installationId: installation.id, botId: bot, partIds: ["notes"] };
    const installed = await registry.setGrants(grant);
    const resolve = () =>
      resolvePluginGrants(
        db.prisma,
        { ...installer, botId: bot },
        { installationId: installation.id },
      );
    const originalGrants = await resolve();
    const request = {
      installationId: installation.id,
      expectedVersionId: first.id,
      versionId: second.id,
    };
    await expect(client(null).switchVersion(request)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    for (const actor of [publisher, otherSpace])
      await expect(client(actor).switchVersion(request)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    await expect(
      registry.switchVersion({ ...request, expectedVersionId: third.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    for (const release of [pending, rejected, foreign])
      await expect(
        registry.switchVersion({ ...request, versionId: release.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      registry.switchVersion({ ...request, versionId: corrupt.id }),
    ).rejects.toBeInstanceOf(JsonColumnMismatchError);
    expect((await registry.installations({})).items).toContainEqual(installed);
    expect(await resolve()).toEqual(originalGrants);

    const switched = await registry.switchVersion(request);
    expect(switched).toMatchObject({
      id: installation.id,
      createdAt: installation.createdAt,
      plugin: { id: second.id },
      grants: [],
    });
    expect(await resolve()).toEqual([]);
    const granted = await registry.setGrants(grant);
    expect(await registry.switchVersion(request)).toEqual(granted);
    expect((await resolve())[0]).toMatchObject({ versionId: second.id });
    expect((await resolve())[0]?.grantId).not.toBe(originalGrants[0]?.grantId);

    const candidates = [first.id, third.id].map((versionId) => ({
      ...request,
      expectedVersionId: second.id,
      versionId,
    }));
    const switches = await Promise.allSettled(
      candidates.map((candidate) => registry.switchVersion(candidate)),
    );
    expect(switches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "fulfilled",
          value: expect.objectContaining({ grants: [] }),
        }),
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "CONFLICT" }),
        }),
      ]),
    );
    expect(await resolve()).toEqual([]);
    const pinned = (await registry.installations({})).items.find(
      ({ id }) => id === installation.id,
    );
    expect([first.id, third.id]).toContain(pinned?.plugin.id);
  });

  it("searches each approved version in the tenant context before paging", async () => {
    const searchSlug = `${slug}-search`;
    const searchToken = `search-${tag.slice(0, 8)}`;
    const publish = (version: number, name: string, description: string) =>
      client(publisher).submit({
        slug: searchSlug,
        version,
        manifest: { ...manifest, name, description, parts: [manifest.parts[0]!] },
      });
    const first = await publish(1, `Draft ${searchToken}`, "Converts units.");
    const second = await publish(2, "Units", `Tracks ${searchToken} with 100%_accuracy.`);
    const pending = await publish(3, `Pending ${searchToken}`, "Private draft.");
    const rejected = await publish(4, `Rejected ${searchToken}`, "Private draft.");
    for (const release of [first, second]) {
      await client(admin).review({ versionId: release.id, decision: "approved" });
    }
    await client(admin).review({ versionId: rejected.id, decision: "rejected", reason: "Fixture" });

    const discover = client(installer).discover;
    const query = `  ${searchToken.toUpperCase()}  `;
    const matching = await discover({ query, limit: 1 });
    expect(matching.items).toHaveLength(1);
    expect(matching.nextAfter).toBe(matching.items[0]?.id);
    const next = await discover({ query, limit: 1, after: matching.nextAfter! });
    expect(next.items).toHaveLength(1);
    expect(next.nextAfter).toBeNull();
    expect([...matching.items, ...next.items].map(({ id }) => id)).toEqual(
      [first.id, second.id].sort(),
    );

    for (const [text, ids] of [
      [searchSlug.toUpperCase(), [first.id, second.id]],
      ["converts UNITS", [first.id]],
      ["100%_ACCURACY", [second.id]],
      ["%_", [second.id]],
    ] as const) {
      expect((await discover({ query: text })).items.map(({ id }) => id)).toEqual([...ids].sort());
    }
    expect((await discover({ slug, query })).items).toEqual([]);
    for (const actor of [installer, publisher]) {
      expect((await client(actor).discover({ query })).items.map(({ id }) => id)).not.toContain(
        pending.id,
      );
      expect((await client(actor).discover({ query: "private draft" })).items).toEqual([]);
    }
  });

  it("keeps a version pending when review finds a private MCP endpoint", async () => {
    const privateSlug = `${slug}-private`;
    const release = await client(publisher).submit({
      slug: privateSlug,
      version: 1,
      manifest: {
        ...manifest,
        parts: [
          {
            id: "internal",
            kind: "mcp",
            transport: "streamable_http",
            endpoint: "https://127.0.0.1/mcp",
          },
          appManifest.parts[0]!,
        ],
      },
    });
    await expect(
      client(admin).review({ versionId: release.id, decision: "approved" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await client(admin).submissions({})).items).toContainEqual(release);
    expect((await client(installer).discover({ slug: privateSlug })).items).toEqual([]);
  });

  it("approves a loopback MCP endpoint only on a host the test-only allowlist names", async () => {
    const testRouter = createRouter({
      prisma: db.prisma,
      remoteConnectors: { resolveHostname },
      env: { adminEmails: [admin.email], e2ePluginHosts: ["127.0.0.1"] },
    } as unknown as RouterDeps);
    const testClient = (actor: Actor) =>
      createRouterClient(testRouter, {
        context: { actor },
        interceptors: [onError((error, { path }) => handleRpcError(error, path))],
      }).pluginRegistry;
    const submitMcp = (suffix: string, endpoint: string) =>
      testClient(publisher).submit({
        slug: `${slug}-e2e-${suffix}`,
        version: 1,
        manifest: {
          ...manifest,
          parts: [{ id: "fake-tools", kind: "mcp", transport: "streamable_http", endpoint }],
        },
      });

    // Plain HTTP never passes the manifest, allowlist or not.
    await expect(submitMcp("http", "http://127.0.0.1:56140/mcp")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const unlisted = await submitMcp("unlisted", "https://10.0.0.5:56140/mcp");
    await expect(
      testClient(admin).review({ versionId: unlisted.id, decision: "approved" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const listed = await submitMcp("listed", "https://127.0.0.1:56140/mcp");
    const approved = await testClient(admin).review({ versionId: listed.id, decision: "approved" });
    expect(approved.status).toBe("approved");
    const installation = await testClient(publisher).install({ versionId: approved.id });
    const granted = await testClient(publisher).setGrants({
      installationId: installation.id,
      botId: botId(publisher),
      partIds: ["fake-tools"],
    });
    expect(granted.grants.map(({ partId }) => partId)).toEqual(["fake-tools"]);
    const grants = await resolvePluginGrants(db.prisma, {
      userId: publisher.userId,
      spaceId,
      botId: botId(publisher),
    });
    expect(grants.map(({ part }) => part)).toContainEqual(
      expect.objectContaining({ kind: "mcp", endpoint: "https://127.0.0.1:56140/mcp" }),
    );
  });

  it("validates app values and pages live records with an account- and Space-scoped aggregate", async () => {
    const release = await publishApp("data");
    const registry = client(installer);
    const { id: installationId } = await registry.install({ versionId: release.id });
    const target = { installationId, partId: "meals" };
    const date = "2024-02-29";
    const tomorrow = "2024-03-01";
    const original = {
      ...target,
      operationId: randomUUID(),
      values: { "meal-date": date, "meal-name": "  Soup 🥣\u2068  ", calories: 100.1 },
    };
    const remove = { ...target, recordId: randomUUID() };
    await expect(client(null).appRecords(target)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client(null).addAppRecord(original)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client(null).removeAppRecord(remove)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    for (const other of [appOtherSpace, publisher, admin]) {
      await expect(client(other).appRecords(target)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client(other).addAppRecord(original)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(client(other).removeAppRecord(remove)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    await expect(registry.appRecords({ ...target, partId: "notes" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(registry.appRecords({ ...target, partId: "invalid" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(registry.appRecords({ ...target, date: "2023-02-29" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      registry.appRecords({ ...target, partId: "reflection", date }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const invalidValues: Array<Record<string, string | number>> = [
      { "meal-date": date },
      { "meal-date": date, calories: "1" },
      { "meal-date": "2023-02-29", calories: 1 },
      { "meal-date": date, calories: 1, undeclared: "Unknown" },
      { "meal-date": date, calories: 1, "meal-name": "\0" },
      { "meal-date": date, calories: 1, "meal-name": "x".repeat(2001) },
      { "meal-date": date, calories: 1e13 },
    ];
    for (const values of invalidValues) {
      await expect(registry.addAppRecord({ ...original, values })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(await registry.appRecords({ ...target, date })).toEqual({
      items: [],
      nextAfter: null,
      total: 0,
    });
    const [first, retry] = await Promise.all([
      registry.addAppRecord(original),
      registry.addAppRecord({
        ...original,
        operationId: original.operationId.toUpperCase(),
        values: { calories: 100.1, "meal-name": "Soup 🥣\u2068", "meal-date": date },
      }),
    ]);
    expect(first).toEqual(retry);
    expect(first.values).toEqual({
      "meal-date": date,
      "meal-name": "Soup 🥣\u2068",
      calories: 100.1,
    });
    await expect(
      registry.addAppRecord({ ...original, values: { ...original.values, calories: 100.2 } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const second = await registry.addAppRecord({
      ...target,
      operationId: randomUUID(),
      values: { "meal-date": date, calories: 200.2 },
    });
    const third = await registry.addAppRecord({
      ...target,
      operationId: randomUUID(),
      values: { "meal-date": tomorrow, "review-date": date, calories: 300 },
    });
    const reflection = { ...target, partId: "reflection" };
    const note = await registry.addAppRecord({
      ...reflection,
      operationId: original.operationId,
      values: { note: "Enjoyed the soup." },
    });
    const otherInstall = await client(publisher).install({ versionId: release.id });
    await client(publisher).addAppRecord({ ...original, installationId: otherInstall.id });
    const spaceRegistry = client(appOtherSpace);
    const spaceInstall = await spaceRegistry.install({ versionId: release.id });
    await spaceRegistry.addAppRecord({ ...original, installationId: spaceInstall.id });
    expect(await registry.appRecords(reflection)).toEqual({
      items: [note],
      nextAfter: null,
      total: null,
    });
    expect(await registry.appRecords(target)).toMatchObject({ total: 600.3, nextAfter: null });

    const firstPage = await registry.appRecords({ ...target, date, limit: 1 });
    expect(firstPage.total).toBe(300.3);
    expect(firstPage.nextAfter).toBe(firstPage.items[0]?.id);
    const nextPage = await registry.appRecords({ ...target, date, after: firstPage.nextAfter! });
    expect(nextPage.total).toBe(300.3);
    expect(nextPage.nextAfter).toBeNull();
    expect([...firstPage.items, ...nextPage.items]).toEqual(
      expect.arrayContaining([first, second]),
    );
    expect(await registry.appRecords({ ...target, date: tomorrow })).toMatchObject({
      items: [third],
    });
    await expect(registry.appRecords({ ...target, after: note.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await registry.removeAppRecord({ ...target, recordId: note.id });
    expect((await registry.appRecords(reflection)).items).toEqual([note]);

    const lastRecord = nextPage.items[0]!;
    const removed = { ...target, recordId: firstPage.nextAfter! };
    await expect(registry.removeAppRecord(removed)).resolves.toEqual({ ok: true });
    await expect(registry.removeAppRecord(removed)).resolves.toEqual({ ok: true });
    expect(await registry.appRecords({ ...target, date, after: removed.recordId })).toEqual({
      items: [lastRecord],
      total: lastRecord.values.calories,
      nextAfter: null,
    });
    const tombstone = await system.registryAppRecord.findFirst({ where: { id: removed.recordId } });
    expect(tombstone).toMatchObject({
      values: null,
      recordDate: null,
      removedAt: expect.any(Date),
    });
    await expect(
      registry.addAppRecord({
        ...target,
        operationId: tombstone!.operationId,
        values: firstPage.items[0]!.values,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    if (process.env.DATABASE_URL !== process.env.DATABASE_MIGRATION_URL) {
      const foreign = runAsTenant(publisher, () =>
        db.prisma.registryAppRecord.findMany({ where: { installationId } }),
      );
      await expect(foreign).resolves.toEqual([]);
      await expect(
        runAsTenant(publisher, () =>
          db.prisma.registryAppRecord.create({
            data: { ...target, versionId: release.id, operationId: randomUUID(), values: {} },
          }),
        ),
      ).rejects.toThrow(/row-level security/i);
    }
    await system.spaceMember.delete({ where: { id: botId(appOtherSpace) } });
    expect(
      await system.registryAppRecord.count({ where: { installationId: spaceInstall.id } }),
    ).toBe(0);
    expect(await registry.appRecords(target)).toMatchObject({
      items: expect.arrayContaining([third]),
    });
  });

  it("preserves each pinned app schema and deletes all version data on uninstall", async () => {
    const first = await publishApp("pinned");
    const second = await publishApp("pinned", 2, {
      ...appManifest,
      parts: [
        {
          id: "meals",
          kind: "app",
          fields: [{ id: "calories", label: "Notes", type: "text", required: true }],
        },
      ],
    });
    const registry = client(installer);
    const install = await registry.install({ versionId: first.id });
    const target = { installationId: install.id, partId: "meals" };
    const add = {
      ...target,
      operationId: randomUUID(),
      values: { "meal-date": "2026-11-20", calories: 100 },
    };
    const older = await registry.addAppRecord(add);
    const switchVersion = (expectedVersionId: string, versionId: string) =>
      registry.switchVersion({ installationId: install.id, expectedVersionId, versionId });
    await switchVersion(first.id, second.id);
    expect(await registry.appRecords(target)).toEqual({ items: [], nextAfter: null, total: null });
    await expect(registry.appRecords({ ...target, after: older.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      registry.addAppRecord({ ...add, values: { calories: "Reused operation" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const newer = await registry.addAppRecord({
      ...add,
      operationId: randomUUID(),
      values: { calories: "New schema" },
    });
    await switchVersion(second.id, first.id);
    expect(await registry.appRecords(target)).toEqual({
      items: [older],
      total: 100,
      nextAfter: null,
    });
    expect(await registry.addAppRecord(add)).toEqual(older);
    await switchVersion(first.id, second.id);
    expect((await registry.appRecords(target)).items).toEqual([newer]);
    await registry.uninstall({ installationId: install.id });
    await expect(registry.appRecords(target)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await system.registryAppRecord.count({ where: { installationId: install.id } })).toBe(0);
    const replacement = await registry.install({ versionId: first.id });
    expect(replacement.id).not.toBe(install.id);
    expect(
      (await registry.appRecords({ ...target, installationId: replacement.id })).items,
    ).toEqual([]);
  });

  it("checks the exact bot grant inside the same transaction as a record write", async () => {
    const release = await publishApp("bot");
    const registry = client(installer);
    const { id: installationId } = await registry.install({ versionId: release.id });
    const bot = botId(installer);
    const target = { installationId, partId: "meals" };
    const setGrant = () =>
      registry.setGrants({ installationId, botId: bot, partIds: [target.partId] });
    await setGrant();
    const base = { spaceId, userId: installer.userId, botId: bot };
    const resolve = () => resolvePluginGrants(db.prisma, base, target);
    const [grant] = await resolve();
    expect(grant).toMatchObject({ installationId, part: { kind: "app" } });
    const scope = { ...base, grantId: grant!.grantId, versionId: grant!.versionId };
    const add = {
      ...target,
      operationId: randomUUID(),
      values: { "meal-date": "2026-11-20", calories: 120 },
    };
    await expect(
      listRegistryAppRecords(db.prisma, { ...scope, botId: botId(publisher) }, target),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    const saved = await addRegistryAppRecord(db.prisma, scope, add);
    expect((await registry.appRecords(target)).items).toEqual([saved]);
    await expect(
      removeRegistryAppRecord(db.prisma, scope, { ...target, recordId: saved.id }),
    ).resolves.toEqual({ ok: true });

    const lockTaken = deferred<number>();
    const releaseLock = deferred();
    const revoking = runAsTenant(installer, () =>
      db.prisma.$transaction(async (tx) => {
        await lockRegistryPluginInstallation(tx, installer, installationId);
        const [connection] = await tx.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
        lockTaken.resolve(connection.pid);
        await releaseLock.promise;
        await tx.registryPluginGrant.deleteMany({ where: { installationId, botId: bot } });
      }),
    );
    const pid = await lockTaken.promise;
    const outcome = addRegistryAppRecord(db.prisma, scope, {
      ...add,
      operationId: randomUUID(),
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await vi.waitFor(async () => {
        const [row] = await system.$queryRaw<[{ waiting: boolean }]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid)))
          AS waiting`;
        expect(row.waiting).toBe(true);
      });
    } finally {
      releaseLock.resolve();
      await revoking;
    }
    expect(await outcome).toMatchObject({ error: { kind: "FORBIDDEN" } });
    await setGrant();
    await expect(listRegistryAppRecords(db.prisma, scope, target)).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    const [regranted] = await resolve();
    expect(
      (await listRegistryAppRecords(db.prisma, { ...scope, grantId: regranted!.grantId }, target))
        .items,
    ).toEqual([]);
  });
});
