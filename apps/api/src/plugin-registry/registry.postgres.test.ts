import { randomUUID } from "node:crypto";
import { createRouterClient, onError } from "@orpc/server";
import type { Actor, RpcInput } from "@rakazo/contracts";
import { asSystem, createDb, resolvePluginGrants, runAsTenant } from "@rakazo/db";
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
    for (const id of [spaceId, otherSpaceId]) {
      await system.space.create({
        data: {
          id,
          organizationId: org,
          name: "Registry Space",
          createdByUserId: publisher.userId,
        },
      });
    }
    for (const actor of [publisher, admin, unverified, installer, otherSpace]) {
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
        ],
      },
    });
    await expect(
      client(admin).review({ versionId: release.id, decision: "approved" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await client(admin).submissions({})).items).toContainEqual(release);
    expect((await client(installer).discover({ slug: privateSlug })).items).toEqual([]);
  });
});
