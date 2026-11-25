import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildOptions } from "../scripts/build.mjs";

const example = (file: string) =>
  readFileSync(new URL(`../../../examples/plugins/${file}`, import.meta.url), "utf8");

let root: string;
let bundle: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "superbot-plugin-bin-"));
  bundle = path.join(root, "dist", "superbot-plugin.mjs");
  await build(await buildOptions(bundle));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Runs the bundled command under plain Node in `cwd`. Only local commands run here: a registry
 * command would reach for the computer's credential store.
 */
async function plugin(cwd: string, ...args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bundle, ...args], {
      cwd,
      env: { PATH: process.env.PATH, SUPERBOT_CONFIG_DIR: path.join(root, "settings") },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

async function project(name: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory);
  return directory;
}

describe("the bundled superbot-plugin command", () => {
  it("embeds the starters and keeps the credential store binding external", async () => {
    const text = await readFile(bundle, "utf8");
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(text).not.toContain("mcp-app-readme.md");
    expect(text).toMatch(/import\(["']@napi-rs\/keyring["']\)/);
  });

  it("prints its version and help", async () => {
    expect(await plugin(root, "--version")).toEqual({
      code: 0,
      stdout: "superbot-plugin-kit 0.1.0\n",
      stderr: "",
    });
    const help = await plugin(root, "help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: superbot-plugin [OPTIONS] <COMMAND>");
  });

  it("scaffolds and validates the MCP app from anywhere", async () => {
    const dir = await project("mcp-app");
    expect(await plugin(dir, "init", "temperature-tool", "--template", "mcp-app")).toEqual({
      code: 0,
      stdout:
        "Created plugin.json\nCreated server.ts\nCreated temperature.html\nCreated README.md\n",
      stderr: "",
    });
    expect(await plugin(dir, "validate")).toEqual({
      code: 0,
      stdout: "Manifest is valid\n",
      stderr: "",
    });
    expect(await readFile(path.join(dir, "server.ts"), "utf8")).toBe(
      example("marketplace-unit-converter/server.ts"),
    );
    expect(await readFile(path.join(dir, "temperature.html"), "utf8")).toBe(
      example("marketplace-unit-converter/temperature.html"),
    );
  });

  it("scaffolds the record app byte for byte", async () => {
    const dir = await project("record-app");
    expect((await plugin(dir, "init", "kcal-diary", "--template", "kcal-diary")).code).toBe(0);
    expect(await readFile(path.join(dir, "plugin.json"), "utf8")).toBe(
      example("kcal-diary/plugin.json"),
    );
  });

  it("exits 2 for a usage error and 1 for a failed command", async () => {
    const dir = await project("errors");
    expect(await plugin(dir, "publish", "x", "0")).toEqual({
      code: 2,
      stdout: "",
      stderr:
        "error: invalid value '0' for '<VERSION>': 0 is not in 1..=2147483647\n\nFor more information, try '--help'.\n",
    });
    const missing = await plugin(dir, "validate");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^Error: Reading registry manifest plugin\.json: /);
  });
});
