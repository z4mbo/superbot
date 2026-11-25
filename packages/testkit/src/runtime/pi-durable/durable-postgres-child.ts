// Child process for the durable spike on Postgres: takes the store's lease, opens the Postgres
// storage under it, starts or resumes one run, and reports on stdout so the parent test can kill
// it at a chosen moment. Like the SQLite child, the same command starts and resumes a run.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { leaseFence, PostgresDurableStorage } from "@rakazo/adapters/durable-storage";
import { createDb, LeaseHeldError, runAsTenant, withLease } from "@rakazo/db";
import type { PostgresChildConfig, PostgresChildEvent } from "./durable-spike-fixture.js";
import {
  durableStoreLeaseKey,
  SPIKE_EVENT_PREFIX,
  SPIKE_SETTINGS,
  spikeModels,
  spikeRegistry,
  spikeWorkdir,
  summarizeTranscript,
} from "./durable-spike-fixture.js";

function emit(event: PostgresChildEvent) {
  process.stdout.write(`${SPIKE_EVENT_PREFIX}${JSON.stringify(event)}\n`);
}

async function main(db: ReturnType<typeof createDb>) {
  const config = JSON.parse(process.argv[2] ?? "") as PostgresChildConfig;
  const context = BACKGROUND_CONTEXT;
  // A line on stdin lets hanging tools return; the open stdin keeps the process alive meanwhile.
  const release = new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });
  const tenant = { spaceId: config.spaceId, userId: config.userId };
  await runAsTenant(tenant, () =>
    withLease(
      db.prisma,
      durableStoreLeaseKey(config.storeId),
      { ttlMs: config.leaseTtlMs },
      async (lease) => {
        const storage = await PostgresDurableStorage.open(db.prisma, {
          storeId: config.storeId,
          spaceId: config.spaceId,
          fence: leaseFence(lease),
        });
        const harness = await Harness.open(
          storage,
          {
            models: spikeModels(config.endpoints),
            registry: spikeRegistry({
              workdir: spikeWorkdir(config.workdir),
              hang: config.hang,
              release,
              guardInterrupted: config.guardInterrupted,
              onEvent: emit,
            }),
            settings: SPIKE_SETTINGS,
            onReport: (report) =>
              emit({ event: "error", message: `${report.kind}: ${report.error}` }),
          },
          context,
        );
        // The lease ends the Harness: a holder that lost it stops instead of working on.
        lease.signal.addEventListener("abort", () => void harness.close(context), { once: true });
        const root = await harness.root(context, { agent: { model: config.model } });
        harness.resume();
        emit({ event: "ready", node: process.versions.node });
        const submission = await root.submit(
          { type: "input", content: config.prompt, requestId: config.requestId },
          context,
        );
        const settled = await submission.wait(context);
        const view = await root.context(context);
        emit({
          event: "settled",
          status: settled.status,
          ...(settled.status === "unanswered" ? { reason: String(settled.reason) } : {}),
          transcript: summarizeTranscript(view.messages),
        });
        await harness.close(context);
      },
    ),
  );
}

const db = createDb(process.env.DATABASE_URL!);
main(db)
  .catch((error: unknown) => {
    if (error instanceof LeaseHeldError) emit({ event: "lease-held" });
    else emit({ event: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    process.stdin.destroy();
    await db.prisma.$disconnect();
    await db.pool.end();
  });
