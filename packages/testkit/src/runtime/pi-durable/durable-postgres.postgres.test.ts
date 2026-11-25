// The spike's key scenarios again, on the Postgres storage a durable runtime would use: real
// child processes killed abruptly, each holding the store's lease while it writes. The lease and
// the fence each commit checks are what SQLite lacked: a second process cannot run a live call
// beside the first, and a writer that lost its lease cannot write over the one that took it.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { leaseFence, PostgresDurableStorage } from "@rakazo/adapters/durable-storage";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant, withLease } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  PostgresChildConfig,
  PostgresChildEvent,
  SpikeEndpoint,
} from "./durable-spike-fixture.js";
import {
  durableStoreLeaseKey,
  logLines,
  SPIKE_SETTINGS,
  spikeModels,
  spikeRegistry,
  summarizeTranscript,
} from "./durable-spike-fixture.js";
import type { Cleanups } from "./durable-spike-process.js";
import {
  anyRequest,
  killHard,
  settled,
  settledTranscript,
  spikeEmulator,
  spikeScenario,
  startSpikeChild,
  toolMessages,
} from "./durable-spike-process.js";
import previousVersionStore from "./durable-store-1.6.0.fixture.json" with { type: "json" };

const context = BACKGROUND_CONTEXT;
const childScript = fileURLToPath(new URL("./durable-postgres-child.ts", import.meta.url));
// Never renewed while a test runs, so a lease changes hands only when a test lapses it.
const LEASE_TTL_MS = 10 * 60_000;
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("pi-durable spike: Postgres storage under the store's lease", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const tenant = { spaceId: randomUUID(), userId: "" };
  tenant.userId = tenant.spaceId;
  const cleanups: Cleanups = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    const id = tenant.spaceId;
    await runAsSystem("durable spike fixture", async () => {
      await prisma.user.create({
        data: { id, name: "Durable spike", email: `${id}@example.test`, emailVerified: true },
      });
      await prisma.organization.create({
        data: { id, name: "Durable spike", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id, organizationId: id, name: "Durable spike", isDefault: true },
      });
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("durable spike cleanup", async () => {
      await prisma.lease.deleteMany({
        where: { key: { startsWith: durableStoreLeaseKey(`spike:${tenant.spaceId}`) } },
      });
      await prisma.organization.deleteMany({ where: { id: tenant.spaceId } });
      await prisma.user.deleteMany({ where: { id: tenant.userId } });
    });
    await prisma.$disconnect();
    await db.pool.end();
  });

  async function scenario(endpoint: SpikeEndpoint, prompt: string) {
    const { root, workdir } = await spikeScenario(cleanups);
    const config: PostgresChildConfig = {
      storeId: `spike:${tenant.spaceId}:${randomUUID()}`,
      spaceId: tenant.spaceId,
      userId: tenant.userId,
      leaseTtlMs: LEASE_TTL_MS,
      workdir: root,
      endpoints: [endpoint],
      model: { provider: endpoint.provider, modelId: endpoint.modelId },
      prompt,
      requestId: randomUUID(),
    };
    return { workdir, config };
  }

  const startChild = (config: PostgresChildConfig) =>
    startSpikeChild<PostgresChildEvent>(cleanups, childScript, config);

  /** As if the holder stopped renewing a while ago, so another process may take the lease. */
  const lapse = (storeId: string) =>
    prisma.$executeRaw`UPDATE "leases" SET "expiresAt" = now() - interval '1 minute' WHERE "key" = ${durableStoreLeaseKey(storeId)}`;

  /** The store's active transcript, read by a viewer that never writes. */
  async function readTranscript(storeId: string, endpoint: SpikeEndpoint) {
    return runAsTenant(tenant, async () => {
      const storage = await PostgresDurableStorage.open(prisma, {
        storeId,
        spaceId: tenant.spaceId,
        fence: () => Promise.reject(new Error("a viewer never writes")),
      });
      const viewer = await Harness.open(
        storage,
        { models: spikeModels([endpoint]), registry: createRegistry(), readOnly: true },
        context,
      );
      try {
        const conversation = await viewer.root(context);
        return summarizeTranscript((await conversation.context(context)).messages);
      } finally {
        await viewer.close(context);
      }
    });
  }

  it("does not run a side-effecting tool twice when the process dies while it is in flight", async () => {
    let seenByModel: ReturnType<typeof toolMessages> = [];
    const { server, endpoint } = await spikeEmulator(cleanups, [
      {
        expect: anyRequest,
        response: {
          type: "tools",
          calls: [
            { id: "call-read", name: "read_note", arguments: {} },
            { id: "call-charge", name: "charge_card", arguments: { cents: 500 } },
          ],
        },
      },
      {
        expect(request) {
          seenByModel = toolMessages(request);
        },
        response: { type: "text", text: "The charge may not have gone through." },
      },
    ]);
    const { workdir, config } = await scenario(endpoint, "Charge the customer 5 dollars.");
    const first = startChild({ ...config, hang: ["charge_card"] });
    await first.waitFor((event) => event.event === "tool-hang");
    await killHard(first);
    expect(logLines(workdir.effects)).toEqual(["charged 500"]);

    // A killed holder never releases its lease; it lapses, and the next process takes it.
    await lapse(config.storeId);
    const second = startChild(config);
    const done = await second.waitFor(settled);
    expect(await second.exited).toBe(0);
    server.assertComplete();
    expect(logLines(workdir.effects)).toEqual(["charged 500"]);
    expect(second.events.some((event) => event.event === "tool-start")).toBe(false);
    expect(seenByModel).toEqual([
      { id: "call-read", text: "Order 42 belongs to the fixture customer." },
      {
        id: "call-charge",
        text: "<harness>\n[error] Tool charge_card was interrupted and may have partially run\n</harness>",
      },
    ]);
    expect(done).toMatchObject({ status: "done" });
    expect(settledTranscript(done).at(-1)).toEqual({
      role: "assistant",
      text: "The charge may not have gone through.",
    });
  });

  it("turns a second process away while the first holds the store, so the live call runs once", async () => {
    const { server, endpoint } = await spikeEmulator(cleanups, [
      {
        expect: anyRequest,
        response: {
          type: "tool",
          id: "call-lookup",
          name: "slow_lookup",
          arguments: { order: "9" },
        },
      },
      {
        expect(request) {
          expect(toolMessages(request)).toEqual([{ id: "call-lookup", text: "order 9: shipped" }]);
        },
        response: { type: "text", text: "Order 9 has shipped." },
      },
    ]);
    const { workdir, config } = await scenario(endpoint, "Where is order 9?");
    const first = startChild({ ...config, hang: ["slow_lookup"] });
    await first.waitFor((event) => event.event === "tool-hang");

    // The first process is alive and mid-tool. A second one asks for the same store.
    const second = startChild(config);
    await second.waitFor((event) => event.event === "lease-held");
    expect(await second.exited).toBe(1);
    expect(second.events.map((event) => event.event)).toEqual(["lease-held"]);

    first.process.stdin.write("release\n");
    const firstDone = await first.waitFor(settled);
    expect(await first.exited).toBe(0);
    expect(firstDone).toMatchObject({ status: "done" });
    server.assertComplete();
    expect(logLines(workdir.reads)).toEqual(["slow_lookup 9"]);
  });

  it("fails a stalled writer whose lease lapsed, and keeps the run of the process that took over", async () => {
    const { server, endpoint } = await spikeEmulator(cleanups, [
      {
        expect: anyRequest,
        response: {
          type: "tool",
          id: "call-lookup",
          name: "slow_lookup",
          arguments: { order: "9" },
        },
      },
      { expect: anyRequest, response: { type: "text", text: "answer from the second process" } },
    ]);
    const { workdir, config } = await scenario(endpoint, "Where is order 9?");
    const first = startChild({ ...config, hang: ["slow_lookup"] });
    await first.waitFor((event) => event.event === "tool-hang");

    // The first process stalls past its lease. Another takes the lease and, as after a crash,
    // runs the interrupted replay-safe call again and finishes the run.
    const firstEnd = first.waitFor((event) => event.event === "settled" || event.event === "error");
    await lapse(config.storeId);
    const second = startChild(config);
    const secondDone = await second.waitFor(settled);
    expect(await second.exited).toBe(0);
    expect(settledTranscript(secondDone).at(-1)).toEqual({
      role: "assistant",
      text: "answer from the second process",
    });

    // The stalled process's next commit meets the fence and fails its Session, whether that
    // commit comes while its tool still hangs or once the tool returns. On SQLite the same commit
    // collided with the new owner's records.
    if (first.process.exitCode === null) first.process.stdin.write("release\n");
    expect(await firstEnd).toEqual({
      event: "error",
      message: `storage_failed: LeaseLostError: Lost the lease on ${durableStoreLeaseKey(config.storeId)}`,
    });
    expect(await first.exited).toBe(1);
    // It never asked the model again: the store holds the second process's run alone.
    expect(server.requests).toHaveLength(2);
    expect(logLines(workdir.reads)).toEqual(["slow_lookup 9", "slow_lookup 9"]);
    expect((await readTranscript(config.storeId, endpoint)).slice(1)).toEqual([
      { role: "user", text: "Where is order 9?" },
      { role: "assistant", toolCalls: ["slow_lookup"] },
      { role: "toolResult", toolName: "slow_lookup", isError: false, text: "order 9: shipped" },
      { role: "assistant", text: "answer from the second process" },
    ]);
  });

  // Before each Durable upgrade, add a fixture written by the version being replaced (the rows a
  // finished turn leaves in its store) and keep this passing for every fixture kept here.
  it("reopens a store an earlier pi-durable wrote and continues its conversation", async () => {
    const { server, endpoint } = await spikeEmulator(cleanups, [
      {
        expect(request) {
          expect(request.messages.at(-1)).toMatchObject({ role: "user", content: "Thanks." });
        },
        response: { type: "text", text: "You're welcome." },
      },
    ]);
    const { workdir } = await spikeScenario(cleanups);
    const storeId = `spike:${tenant.spaceId}:${randomUUID()}`;
    await runAsTenant(tenant, async () => {
      await prisma.$executeRaw`INSERT INTO "durable_stores" ("id", "spaceId", "formatVersion", "nextId", "nextSeq")
        VALUES (${storeId}, ${tenant.spaceId}, ${previousVersionStore.store.formatVersion},
          ${previousVersionStore.store.nextId}, ${previousVersionStore.store.nextSeq})`;
      for (const [table, rows] of Object.entries(previousVersionStore.tables)) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(NULL::"${table}", $1::json)`,
          JSON.stringify(rows.map((row) => ({ ...row, storeId }))),
        );
      }
      await withLease(
        prisma,
        durableStoreLeaseKey(storeId),
        { ttlMs: LEASE_TTL_MS },
        async (lease) => {
          const storage = await PostgresDurableStorage.open(prisma, {
            storeId,
            spaceId: tenant.spaceId,
            fence: leaseFence(lease),
          });
          const harness = await Harness.open(
            storage,
            {
              models: spikeModels([endpoint]),
              registry: spikeRegistry({ workdir }),
              settings: SPIKE_SETTINGS,
            },
            context,
          );
          try {
            const conversation = await harness.root(context);
            harness.resume();
            const turn = await conversation.submit({ type: "input", content: "Thanks." }, context);
            expect(await turn.wait(context)).toMatchObject({ status: "done" });
            expect(
              summarizeTranscript((await conversation.context(context)).messages).slice(1),
            ).toEqual([
              { role: "user", text: "What does the note say?" },
              { role: "assistant", toolCalls: ["read_note"] },
              {
                role: "toolResult",
                toolName: "read_note",
                isError: false,
                text: "Order 42 belongs to the fixture customer.",
              },
              {
                role: "assistant",
                text: "The note says order 42 belongs to the fixture customer.",
              },
              { role: "user", text: "Thanks." },
              { role: "assistant", text: "You're welcome." },
            ]);
          } finally {
            await harness.close(context);
          }
        },
      );
    });
    server.assertComplete();
  });
});
