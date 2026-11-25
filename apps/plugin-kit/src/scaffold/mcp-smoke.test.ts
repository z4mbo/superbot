import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { run } from "../cli/run.js";

const SMOKE = readFileSync(new URL("./mcp-smoke.test-support.mjs", import.meta.url), "utf8");

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("serves the scaffolded MCP app's tool over loopback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbot-plugin-smoke-"));
  directories.push(dir);
  const code = await run(["init", "temperature-tool", "--template", "mcp-app"], {
    env: {},
    cwd: dir,
    stdout: () => undefined,
    stderr: (text) => {
      throw new Error(text);
    },
  });
  expect(code).toBe(0);
  // The starter runs as written under plain Node, which strips its TypeScript types. A failed
  // assertion in the smoke script exits non-zero, which rejects with its output.
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", SMOKE], {
    cwd: dir,
    timeout: 60_000,
  });
});
