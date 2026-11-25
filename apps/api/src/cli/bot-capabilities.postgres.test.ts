import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { asSystem, createDb, provisionMessagingIdentity, repairBotCapabilities } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const dbTests = databaseUrl ? describe : describe.skip;

dbTests("operator bot capabilities audit", { timeout: 120_000 }, () => {
  const provider = "sendblue";
  const address = "+15550007201";
  let db: ReturnType<typeof createDb>;
  let fixture: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  beforeAll(async () => {
    db = createDb(databaseUrl!);
    const prisma = asSystem(db.prisma);
    await prisma.messagingIdentity.deleteMany({ where: { provider, address } });
    fixture = await provisionMessagingIdentity(prisma, { provider, address });
  }, 120_000);
  afterAll(async () => {
    const prisma = asSystem(db.prisma);
    await prisma.messagingIdentity.deleteMany({ where: { provider, address } });
    await prisma.organization.deleteMany({ where: { id: fixture.spaceId } });
    await prisma.user.deleteMany({ where: { id: fixture.userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  const audit = async () => {
    try {
      const { stdout } = await run(
        process.execPath,
        ["--import", "tsx", "apps/api/src/cli/bot-capabilities.ts"],
        { env: process.env },
      );
      return { stdout, code: 0 };
    } catch (error) {
      const failed = error as { stdout: string; code: number };
      return { stdout: failed.stdout, code: failed.code };
    }
  };
  const line = (stdout: string) =>
    stdout.split("\n").find((entry) => entry.startsWith(`space ${fixture.spaceId}:`));

  it("counts what an old bot lacks before the repair, nothing after, and never prints content", async () => {
    const prisma = asSystem(db.prisma);
    await prisma.bot.update({
      where: { id: fixture.botId },
      data: { name: "Secret project name", instructions: "Private instructions" },
    });
    await prisma.$executeRaw`UPDATE "bots" SET "computerId" = NULL WHERE "id" = ${fixture.botId}`;
    await prisma.memoryDocument.deleteMany({ where: { botId: fixture.botId, path: "MEMORY.md" } });

    const before = await audit();
    expect(before.code).toBe(1);
    expect(line(before.stdout)).toBe(
      `space ${fixture.spaceId}: 1 bots; missing chat 0, memory index 1, computer 1; left as stored: fleet management off 0, cross-space off 0`,
    );
    expect(before.stdout).not.toMatch(/Secret project name|Private instructions/);

    // The install-wide pass the worker runs; no other test runs it, so it cannot race the audit.
    for (let page = await repairBotCapabilities(prisma, { take: 2 }); page.next; ) {
      page = await repairBotCapabilities(prisma, { after: page.next, take: 2 });
    }

    const after = await audit();
    expect(line(after.stdout)).toContain("missing chat 0, memory index 0, computer 0");
    // Other fixtures may share this database; the exit code follows the whole install's total.
    expect(after.code).toBe(after.stdout.includes("; 0 missing capabilities") ? 0 : 1);
  });

  it("takes no arguments", async () => {
    await expect(
      run(process.execPath, ["--import", "tsx", "apps/api/src/cli/bot-capabilities.ts", "fix"], {
        env: process.env,
      }),
    ).rejects.toMatchObject({ code: 2 });
  });
});
