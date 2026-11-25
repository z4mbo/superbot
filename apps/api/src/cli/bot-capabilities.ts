// Operator check: bot-capabilities.js prints, per Space, how many live bots lack what a bot created
// today gets (ids and counts only) and exits 1 while any do. It reads and never writes.
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { auditBotCapabilities, createDb, runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { renderBotCapabilityAudit } from "../bots/bot-capability-audit.js";
import { loadEnv } from "../env.js";

if (process.argv.length > 2) {
  process.stderr.write("Usage: bot-capabilities.js\n");
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const env = loadEnv();
const { prisma, pool } = createDb(env.databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
try {
  const report = renderBotCapabilityAudit(
    await runAsSystem("count bots missing what creation gives", () => auditBotCapabilities(prisma)),
  );
  process.stdout.write(report.text);
  if (report.missing > 0) process.exitCode = 1;
} finally {
  await bestEffort("disconnect database client", prisma.$disconnect());
  await bestEffort("close database pool", pool.end());
}
