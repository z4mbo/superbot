import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const cliPackage = fileURLToPath(new URL("../../", import.meta.url));

/** The bundled command under plain Node, as the installed bin runs it on each platform. */
describe("the built superbot command", { timeout: 120_000 }, () => {
  let bundle: string;
  let settings: string;

  beforeAll(async () => {
    bundle = path.join(cliPackage, "dist", `bin-test-${process.pid}`, "superbot.js");
    await run(process.execPath, [path.join(cliPackage, "build.mjs"), bundle], { cwd: cliPackage });
    settings = await mkdtemp(path.join(tmpdir(), "superbot-bin-"));
  }, 120_000);

  afterAll(async () => {
    await rm(path.dirname(bundle), { recursive: true, force: true });
    await rm(settings, { recursive: true, force: true });
  });

  const superbot = (args: string[]) =>
    run(process.execPath, [bundle, ...args], {
      env: { PATH: process.env.PATH ?? "", SUPERBOT_CONFIG_DIR: settings },
    });

  it("prints its version and help, and saves the default server", async () => {
    expect((await superbot(["--version"])).stdout).toBe("superbot-cli 0.1.0\n");
    expect((await superbot(["--help"])).stdout).toContain(
      "Usage: superbot [OPTIONS] [AGENT] [COMMAND]",
    );
    expect((await superbot(["server"])).stdout).toBe("http://127.0.0.1:5173/\n");
    expect((await superbot(["server", "https://superbot.example.test"])).stdout).toBe(
      "https://superbot.example.test/\n",
    );
    expect(await readFile(path.join(settings, "server.txt"), "utf8")).toBe(
      "https://superbot.example.test/\n",
    );
    await expect(superbot(["send"])).rejects.toMatchObject({ code: 2 });
  });
});
