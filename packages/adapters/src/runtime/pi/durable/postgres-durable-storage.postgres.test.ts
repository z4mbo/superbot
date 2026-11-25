import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId, Storage } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { commitWrites, registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { deferred } from "@rakazo/core/test-async";
import type { HeldLease, PrismaClient } from "@rakazo/db";
import { createDb, LeaseLostError, runAsSystem, runAsTenant, withLease } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DurableStoreFormatError,
  leaseFence,
  PostgresDurableStorage,
} from "./postgres-durable-storage.js";

const context = BACKGROUND_CONTEXT;
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("PostgresDurableStorage (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const tenants: Array<{ spaceId: string; userId: string }> = [];
  let sequence = 0;
  const run = randomUUID();
  const nextStoreId = () => `durable-test:${run}:${++sequence}`;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    for (let index = 0; index < 2; index++) tenants.push(await seedTenant(prisma));
  });

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("durable storage test cleanup", async () => {
      const ids = tenants.map((tenant) => tenant.userId);
      await prisma.organization.deleteMany({ where: { id: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      await prisma.lease.deleteMany({ where: { key: { startsWith: `durable-store:${run}` } } });
    });
    await prisma.$disconnect();
    await db.pool.end();
  });

  const tenant = () => tenants[0]!;
  const leaseKey = (storeId: string) => `durable-store:${storeId.slice("durable-test:".length)}`;

  /** Holds the store's lease until `release`, handing the lease out once taken. */
  function holdLease(storeId: string) {
    const taken = deferred<HeldLease>();
    const release = deferred<void>();
    const held = withLease(prisma, leaseKey(storeId), { ttlMs: 60_000 }, async (lease) => {
      taken.resolve(lease);
      await release.promise;
    }).catch((error: unknown) => error);
    return { lease: taken.promise, release: () => release.resolve(), held };
  }

  /** As if the holder stopped renewing a while ago, so another process may take the lease. */
  const lapse = (storeId: string) =>
    prisma.$executeRaw`UPDATE "leases" SET "expiresAt" = now() - interval '1 minute' WHERE "key" = ${leaseKey(storeId)}`;

  const open = (storeId: string, lease: HeldLease, spaceId = tenant().spaceId) =>
    PostgresDurableStorage.open(prisma, { storeId, spaceId, fence: leaseFence(lease) });

  registerStorageConformance(
    { describe, expect, it },
    "Durable's storage conformance suite",
    (use) =>
      runAsTenant(tenant(), async () => {
        const storeId = nextStoreId();
        await withLease(prisma, leaseKey(storeId), { ttlMs: 60_000 }, async (lease) => {
          const storage = await open(storeId, lease);
          try {
            await use(storage);
          } finally {
            await storage.close();
          }
        });
      }),
  );

  it("fails the commits of a writer that lost its lease, and keeps the new holder's", () =>
    runAsTenant(tenant(), async () => {
      const storeId = nextStoreId();
      const first = holdLease(storeId);
      const stale = await open(storeId, await first.lease);
      await createRoot(stale);
      const staleEntry = await stale.mintId<EntryId>();

      await lapse(storeId);
      const second = holdLease(storeId);
      const current = await open(storeId, await second.lease);
      const currentEntry = await current.mintId<EntryId>();
      await commitWrites(current, [entryWrite(currentEntry, "from the new holder")], context);

      await expect(
        commitWrites(stale, [entryWrite(staleEntry, "from the stale writer")], context),
      ).rejects.toBeInstanceOf(LeaseLostError);
      const page = await current.scanEntries(
        { conversationId: ROOT_CONVERSATION_ID },
        10,
        undefined,
        context,
      );
      expect(page.items.map((item) => item.data)).toEqual([{ text: "from the new holder" }]);

      await Promise.all([stale.close(), current.close()]);
      first.release();
      second.release();
      await Promise.all([first.held, second.held]);
    }));

  it("hands out ids and seqs above everything stored after a reopen", () =>
    runAsTenant(tenant(), async () => {
      const storeId = nextStoreId();
      await withLease(prisma, leaseKey(storeId), { ttlMs: 60_000 }, async (lease) => {
        const before = await open(storeId, lease);
        await createRoot(before);
        // Minted but never stored: a crash loses it, and the next writer must not reuse it.
        await before.mintId();
        const entry = await before.mintId<EntryId>();
        const seq = await commitWrites(before, [entryWrite(entry, "kept")], context);
        await before.close();

        const after = await open(storeId, lease);
        expect(await after.mintId()).toBeGreaterThan(entry);
        const next = await commitWrites(
          after,
          [entryWrite(await after.mintId<EntryId>(), "next")],
          context,
        );
        expect(next).toBeGreaterThan(seq);
        expect((await after.entry(entry, context))?.entry.data).toEqual({ text: "kept" });
        await after.close();
      });
    }));

  it("reads strings back exactly, lone surrogates and NUL included", () =>
    runAsTenant(tenant(), async () => {
      const storeId = nextStoreId();
      await withLease(prisma, leaseKey(storeId), { ttlMs: 60_000 }, async (lease) => {
        const storage = await open(storeId, lease);
        await createRoot(storage);
        const id = await storage.mintId<EntryId>();
        const text = "a\u0000b\ud800c\udfffé😀";
        await commitWrites(storage, [entryWrite(id, text, `kind-${text}`)], context);
        const stored = await storage.entry(id, context);
        expect(stored?.entry).toMatchObject({ kind: `kind-${text}`, data: { text } });
        await storage.close();
      });
    }));

  it("refuses a store a newer release wrote, so a rollback cannot misread it", () =>
    runAsTenant(tenant(), async () => {
      const storeId = nextStoreId();
      await withLease(prisma, leaseKey(storeId), { ttlMs: 60_000 }, async (lease) => {
        await (await open(storeId, lease)).close();
        await prisma.$executeRaw`UPDATE "durable_stores" SET "formatVersion" = "formatVersion" + 1 WHERE "id" = ${storeId}`;
        await expect(open(storeId, lease)).rejects.toThrow(
          new DurableStoreFormatError("Durable store format 2 is newer than supported version 1"),
        );
      });
    }));

  it("keeps a store to its Space", async () => {
    const storeId = nextStoreId();
    await runAsTenant(tenant(), () =>
      withLease(prisma, leaseKey(storeId), { ttlMs: 60_000 }, async (lease) => {
        const storage = await open(storeId, lease);
        await createRoot(storage);
        await storage.close();
      }),
    );
    const other = tenants[1]!;
    await runAsTenant(other, async () => {
      await withLease(prisma, `${leaseKey(storeId)}:other`, { ttlMs: 60_000 }, async (lease) => {
        await expect(open(storeId, lease, other.spaceId)).rejects.toThrow(
          `Durable store ${storeId} belongs to another Space`,
        );
      });
      expect(
        await prisma.$queryRaw`SELECT 1 FROM "durable_conversations"
        WHERE "storeId" = ${storeId}`,
      ).toEqual([]);
    });
  });
});

function createRoot(storage: Storage) {
  return commitWrites(
    storage,
    [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
    context,
  );
}

function entryWrite(id: EntryId, text: string, kind = "message") {
  return {
    type: "entry" as const,
    value: { id, conversationId: ROOT_CONVERSATION_ID, kind, data: { text } },
  };
}

async function seedTenant(prisma: PrismaClient) {
  const id = randomUUID();
  await runAsSystem("durable storage test fixture", async () => {
    await prisma.user.create({
      data: { id, name: "Durable test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Durable test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Durable test", isDefault: true },
    });
  });
  return { spaceId: id, userId: id };
}
