// Operator-only: `docker compose exec api node dist/cli/memory-review.js <botId>` runs one bot's
// nightly memory review now instead of at about 03:00. It prints the queued run's id, or why
// nothing was queued (exit code 1); the worker picks the run up like any other.
import {
  contentKeyProviderFromEnv,
  GraphileJobPublisher,
  queueNightlyMemoryReviewNow,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { createDb, runAsSystem } from "@rakazo/db";
import { loadEnv } from "../env.js";

const [botId, ...extra] = process.argv.slice(2);
if (!botId?.trim() || extra.length) {
  process.stderr.write("Usage: memory-review.js <botId>\n");
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const env = loadEnv();
const { prisma, pool } = createDb(env.databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
const jobs = new GraphileJobPublisher(pool, prisma);
try {
  const outcome = await runAsSystem("run a bot's memory review now", () =>
    queueNightlyMemoryReviewNow({ prisma, jobs }, botId.trim()),
  );
  if ("runId" in outcome) {
    process.stdout.write(`Queued memory review run ${outcome.runId}\n`);
  } else {
    process.stderr.write(`No memory review queued: ${outcome.skipped}\n`);
    process.exitCode = 1;
  }
} finally {
  await jobs.close();
  await prisma.$disconnect();
  await pool.end();
}
