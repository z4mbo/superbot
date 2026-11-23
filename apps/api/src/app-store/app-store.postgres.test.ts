import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import { findInstalledApps } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

const source = "export default function App() {\n  return <Text>Fixture app</Text>;\n}\n";

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    manifest: {
      id: `fixture-app-${randomUUID().slice(0, 8)}`,
      name: "Fixture app",
      version: "1.0.0",
      description: "An app made for tests.",
      entry: "app.jsx",
      permissions: ["clipboard", "links"],
      ...overrides,
    },
    files: [{ path: "app.jsx", content: source, encoding: "utf8" as const }],
  };
}

describe.skipIf(!enabled)("app store lifecycle (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const suffix = randomUUID();
  const actors: Actor[] = [];
  const admin = () => actors[0]!;
  const author = () => actors[1]!;
  const other = () => actors[2]!;
  const publishSpaceChange = vi.fn().mockResolvedValue(undefined);
  const client = (actor: Actor) =>
    createRouterClient(
      createRouter({
        prisma,
        events: { notify: vi.fn(), publishSpaceChange },
        env: {
          webOrigin: "http://localhost:5173",
          defaultProvider: "fake",
          defaultModel: "fake",
          adminEmails: [admin().email],
        },
        dataDir: "/tmp/app-store-db-test",
      } as unknown as RouterDeps),
      { context: { actor } },
    );
  const as = (actor: () => Actor, fn: () => Promise<void>) => () => runAsTenant(actor(), fn);

  /** Submits as the author and approves as the admin; returns the listing. */
  async function publish(input = bundle()) {
    const submitted = await runAsTenant(author(), () => client(author()).apps.submit(input));
    await runAsTenant(admin(), () =>
      client(admin()).marketplace.review({ id: submitted.submissionId, decision: "approve" }),
    );
    const catalog = await runAsTenant(author(), () =>
      client(author()).apps.catalog({ query: input.manifest.id }),
    );
    const listing = catalog.find((entry) => entry.releaseId === submitted.releaseId);
    if (!listing) throw new Error("the approved app is not listed");
    return listing;
  }

  beforeAll(() =>
    runAsSystem("app store fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = db.prisma;
      for (const role of ["admin", "author", "other"]) {
        const organizationId = `app-org-${role}-${suffix}`;
        await prisma.organization.create({
          data: { id: organizationId, name: role, slug: organizationId, createdAt: new Date() },
        });
        const userId = `app-${role}-${suffix}`;
        const spaceId = `app-space-${role}-${suffix}`;
        const email = `${userId}@example.test`;
        await prisma.user.create({
          data: { id: userId, name: role, email, emailVerified: true },
        });
        await prisma.space.create({
          data: {
            id: spaceId,
            organizationId,
            name: "General",
            isDefault: true,
            createdByUserId: userId,
          },
        });
        actors.push({ spaceId, userId, email, isDeploymentOwner: false });
      }
    }),
  );
  afterAll(() =>
    runAsSystem("app store fixture", async () => {
      if (!prisma) return;
      await prisma.organization.deleteMany({ where: { id: { endsWith: suffix } } });
      await prisma.user.deleteMany({ where: { id: { in: actors.map((actor) => actor.userId) } } });
      await prisma.$disconnect();
      await db.pool.end();
    }),
  );

  it(
    "lists an app only after review, then installs, launches and uninstalls it",
    as(author, async () => {
      const input = bundle();
      const submitted = await client(author()).apps.submit(input);
      expect(await client(author()).apps.catalog({ query: input.manifest.id })).toEqual([]);
      await runAsTenant(admin(), async () => {
        const pending = await client(admin()).marketplace.submissions({ status: "pending" });
        expect(pending.find((row) => row.id === submitted.submissionId)?.app).toEqual({
          appId: input.manifest.id,
          version: "1.0.0",
          permissions: ["clipboard", "links"],
        });
        await client(admin()).marketplace.review({
          id: submitted.submissionId,
          decision: "approve",
        });
      });
      const [listing] = await client(author()).apps.catalog({ query: input.manifest.id });
      expect(listing).toMatchObject({ name: "Fixture app", permissions: ["clipboard", "links"] });

      const rpc = client(author());
      const install = await rpc.apps.install({
        releaseId: listing!.releaseId,
        digest: listing!.digest,
        grant: ["links", "clipboard"],
      });
      expect(install.granted).toEqual(["clipboard", "links"]);
      expect(publishSpaceChange).toHaveBeenCalledWith(author().spaceId, "apps");
      expect((await rpc.apps.installed()).map((row) => row.id)).toEqual([install.id]);
      // Apps keep to their own list; the plugin list is unchanged for older clients.
      expect((await rpc.capabilities.list()).some((row) => row.id === install.id)).toBe(false);

      const launch = await rpc.apps.launch({ id: install.id });
      expect(launch).toMatchObject({ appId: input.manifest.id, granted: ["clipboard", "links"] });
      expect(launch.code).toContain("Fixture app");

      await expect(rpc.apps.install({ ...listing!, grant: listing!.permissions })).rejects.toThrow(
        "already installed",
      );
      await rpc.apps.uninstall({ id: install.id });
      expect(await rpc.apps.installed()).toEqual([]);
      await expect(rpc.apps.launch({ id: install.id })).rejects.toThrow("not installed");
    }),
  );

  it("refuses a grant beyond what the app asks for, short of it, or for other content", async () => {
    const listing = await publish();
    await runAsTenant(other(), async () => {
      const rpc = client(other());
      const base = { releaseId: listing.releaseId, digest: listing.digest };
      await expect(
        rpc.apps.install({ ...base, grant: ["clipboard", "links", "state"] }),
      ).rejects.toMatchObject({ message: "Allow only the permissions this app asks for." });
      await expect(rpc.apps.install({ ...base, grant: ["clipboard"] })).rejects.toMatchObject({
        message: "Allow every permission this app asks for to install it.",
      });
      await expect(
        rpc.apps.install({
          ...base,
          digest: `sha256:${"0".repeat(64)}`,
          grant: listing.permissions,
        }),
      ).rejects.toMatchObject({ kind: "CONFLICT" });
      expect(await rpc.apps.installed()).toEqual([]);
    });
  });

  it("does not install a version that is still in review", async () => {
    const input = bundle();
    const submitted = await runAsTenant(author(), () => client(author()).apps.submit(input));
    await runAsTenant(other(), async () => {
      await expect(
        client(other()).apps.install({
          releaseId: submitted.releaseId,
          digest: "sha256:x",
          grant: ["clipboard", "links"],
        }),
      ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    });
  });

  it("refuses to run an app whose stored manifest was changed to ask for more", async () => {
    const listing = await publish();
    const install = await runAsTenant(other(), () =>
      client(other()).apps.install({ ...listing, grant: listing.permissions }),
    );
    await runAsSystem("tamper with a stored app version", async () => {
      const release = await prisma.appRelease.findUniqueOrThrow({
        where: { id: listing.releaseId },
      });
      await prisma.appRelease.update({
        where: { id: release.id },
        data: {
          manifest: {
            ...(release.manifest as Record<string, unknown>),
            permissions: ["clipboard", "links", "state", "agent:actions"],
          },
        },
      });
    });
    await runAsTenant(other(), async () => {
      await expect(client(other()).apps.launch({ id: install.id })).rejects.toMatchObject({
        kind: "CONFLICT",
        message: "This app changed since it was installed. Remove it and install it again.",
      });
    });
  });

  it("refuses to run an app whose recorded grant was widened past its manifest", async () => {
    const listing = await publish(bundle({ permissions: ["clipboard"] }));
    const install = await runAsTenant(other(), () =>
      client(other()).apps.install({ ...listing, grant: ["clipboard"] }),
    );
    await runAsSystem("tamper with an app install", async () => {
      const row = await prisma.capabilityInstall.findUniqueOrThrow({ where: { id: install.id } });
      await prisma.capabilityInstall.update({
        where: { id: row.id },
        data: {
          config: { ...(row.config as Record<string, unknown>), granted: ["clipboard", "links"] },
        },
      });
    });
    await runAsTenant(other(), async () => {
      await expect(client(other()).apps.launch({ id: install.id })).rejects.toMatchObject({
        kind: "CONFLICT",
      });
    });
  });

  it("does not let another person launch or remove someone's install", async () => {
    const listing = await publish();
    const install = await runAsTenant(other(), () =>
      client(other()).apps.install({ ...listing, grant: listing.permissions }),
    );
    await runAsTenant(author(), async () => {
      await expect(client(author()).apps.launch({ id: install.id })).rejects.toMatchObject({
        kind: "NOT_FOUND",
      });
      await client(author()).apps.uninstall({ id: install.id });
    });
    await runAsTenant(other(), async () => {
      expect((await client(other()).apps.installed()).map((row) => row.id)).toContain(install.id);
    });
  });

  it("keeps an app id with its first author and each version published once", async () => {
    const input = bundle();
    await runAsTenant(author(), () => client(author()).apps.submit(input));
    await runAsTenant(author(), async () => {
      await expect(client(author()).apps.submit(input)).rejects.toMatchObject({
        kind: "CONFLICT",
        message: "Version 1.0.0 is already published. Raise the version.",
      });
    });
    await runAsTenant(other(), async () => {
      await expect(
        client(other()).apps.submit({
          ...input,
          manifest: { ...input.manifest, version: "2.0.0" },
        }),
      ).rejects.toMatchObject({
        kind: "CONFLICT",
        message: expect.stringContaining("Another author"),
      });
    });
  });

  it("refuses an invalid bundle with every problem, before storing anything", async () => {
    await runAsTenant(author(), async () => {
      const input = bundle({ entry: "../app.jsx" });
      await expect(client(author()).apps.submit(input)).rejects.toMatchObject({
        kind: "BAD_REQUEST",
      });
      const stored = await runAsSystem("check nothing was stored", () =>
        prisma.appRelease.count({ where: { appId: input.manifest.id } }),
      );
      expect(stored).toBe(0);
    });
  });

  it("lets a bot find installed apps, with actions only where bots may run them", async () => {
    const actions = [
      {
        name: "addTask",
        description: "Add a task.",
        input: { title: { type: "string", required: true } },
        effects: [{ op: "append", path: "tasks", assignId: true }],
      },
    ];
    const runnable = await publish(
      bundle({ name: "Runnable", permissions: ["state", "agent:actions"], actions }),
    );
    const privateApp = await publish(
      bundle({ name: "Private", permissions: ["state"], actions, initialState: { tasks: [] } }),
    );
    const changed = await publish(bundle({ name: "Changed", permissions: [] }));
    await runAsTenant(other(), async () => {
      for (const listing of [runnable, privateApp, changed])
        await client(other()).apps.install({ ...listing, grant: listing.permissions });
    });
    await runAsSystem("tamper with a stored app version", () =>
      prisma.appRelease.update({ where: { id: changed.releaseId }, data: { source: "changed" } }),
    );
    const found = await runAsTenant(other(), () => findInstalledApps(prisma, other(), undefined));
    // Earlier tests installed other apps in the same Space.
    const named = found.apps.filter((app) => ["Runnable", "Private", "Changed"].includes(app.name));
    expect(named.map((app) => [app.name, app.actions?.map((action) => action.name)])).toEqual([
      ["Runnable", ["addTask"]],
      ["Private", undefined],
    ]);
    const none = await runAsTenant(author(), () => findInstalledApps(prisma, author(), "timer"));
    expect(none).toMatchObject({ apps: [], note: expect.stringContaining("No installed app") });
  });
});
