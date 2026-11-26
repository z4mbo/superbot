import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../cli/run.js";
import { appSubmission } from "./app-scaffold.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "superbot-app-init-"));
  directories.push(directory);
  return directory;
}

async function plugin(cwd: string, argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    env: { SUPERBOT_CONFIG_DIR: path.join(cwd, "..", "no-settings") },
    cwd,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe("app-init", () => {
  it("writes a hosted-data app named after its folder that passes the app check", async () => {
    const cwd = await temporaryDirectory();
    const made = await plugin(cwd, ["app-init", "meal-log", "--name", "Meal log"]);
    expect(made).toMatchObject({ code: 0, stderr: "" });
    expect(made.stdout.trim().split("\n")).toEqual([
      `Created ${path.join("meal-log", "app.json")}`,
      `Created ${path.join("meal-log", "app.jsx")}`,
      `Created ${path.join("meal-log", "server.js")}`,
    ]);
    const manifest = JSON.parse(await readFile(path.join(cwd, "meal-log", "app.json"), "utf8"));
    expect(manifest).toMatchObject({
      id: "meal-log",
      name: "Meal log",
      version: "0.1.0",
      server: "server.js",
      permissions: ["data", "agent:read", "agent:actions"],
    });
    expect(Object.keys(manifest.data.collections)).toEqual(["entries"]);
    expect(await readFile(path.join(cwd, "meal-log", "app.jsx"), "utf8")).toContain(
      'title={"Meal log"}',
    );
    expect(await plugin(cwd, ["app-check", "meal-log"])).toMatchObject({
      code: 0,
      stdout: "Meal log 0.1.0 is valid\n",
    });
    // What app-publish sends is the folder as written, checked the same way.
    const input = await appSubmission("meal-log", cwd);
    expect(input.manifest).toEqual(manifest);
    expect(input.files.map((file) => file.path)).toEqual(["app.jsx", "server.js"]);
  });

  it("refuses a folder name that cannot be an app id, and never overwrites", async () => {
    const cwd = await temporaryDirectory();
    expect(await plugin(cwd, ["app-init", "Meal_Log"])).toMatchObject({ code: 1 });
    await mkdir(path.join(cwd, "meal-log"));
    await writeFile(path.join(cwd, "meal-log", "server.js"), "// mine\n");
    expect(await plugin(cwd, ["app-init", "meal-log"])).toMatchObject({ code: 1 });
    expect(await readFile(path.join(cwd, "meal-log", "server.js"), "utf8")).toBe("// mine\n");
  });

  it("reports what app-check finds wrong", async () => {
    const cwd = await temporaryDirectory();
    await plugin(cwd, ["app-init", "broken"]);
    await writeFile(path.join(cwd, "broken", "server.js"), "export function day() {}\n");
    const checked = await plugin(cwd, ["app-check", "broken"]);
    expect(checked.code).toBe(1);
    expect(checked.stderr.split("\n")).toContain(
      // Quotes are escaped as every message the tool prints is.
      'Error: server.js: exports no function \\"addEntry\\", which addEntry runs.',
    );
  });
});
