import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../cli/run.js";
import { readManifestFile } from "../manifest/manifest-file.js";
import { scaffold } from "./scaffold.js";

const example = (file: string) =>
  readFileSync(new URL(`../../../../examples/plugins/${file}`, import.meta.url), "utf8");

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "superbot-plugin-init-"));
  directories.push(directory);
  return directory;
}

/** Runs the command line in `cwd`, as the installed command would run there. */
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

const read = (directory: string, file: string) => readFile(path.join(directory, file), "utf8");

describe("init", () => {
  it("scaffolds and validates without overwriting", async () => {
    const dir = await temporaryDirectory();
    await scaffold("plugin.json", "release-notes", "Release notes", "skill", dir);
    const original = await read(dir, "plugin.json");
    await expect(
      scaffold("plugin.json", "another-plugin", undefined, "skill", dir),
    ).rejects.toThrow("plugin.json already exists");
    expect(await read(dir, "plugin.json")).toBe(original);
    expect((await readManifestFile("plugin.json", dir)).name).toBe("Release notes");
  });

  it("scaffolds and validates the MCP app", async () => {
    const dir = await temporaryDirectory();
    expect(await plugin(dir, ["init", "temperature-tool", "--template", "mcp-app"])).toEqual({
      code: 0,
      stdout:
        "Created plugin.json\nCreated server.ts\nCreated temperature.html\nCreated README.md\n",
      stderr: "",
    });
    expect(await plugin(dir, ["validate"])).toEqual({
      code: 0,
      stdout: "Manifest is valid\n",
      stderr: "",
    });
    expect(JSON.parse(await read(dir, "plugin.json"))).toEqual(
      JSON.parse(example("marketplace-unit-converter/manifest.json")),
    );
    expect(await read(dir, "temperature.html")).toBe(
      example("marketplace-unit-converter/temperature.html"),
    );
    expect(await read(dir, "server.ts")).toBe(example("marketplace-unit-converter/server.ts"));
    expect(await read(dir, "README.md")).toContain("# Temperature converter MCP app");
  });

  it("scaffolds the record app byte for byte and validates edits", async () => {
    const dir = await temporaryDirectory();
    expect((await plugin(dir, ["init", "kcal-diary", "--template", "kcal-diary"])).code).toBe(0);
    expect(await read(dir, "plugin.json")).toBe(example("kcal-diary/plugin.json"));
    expect(await readdir(dir)).toEqual(["plugin.json"]);
    expect(await plugin(dir, ["validate"])).toMatchObject({
      code: 0,
      stdout: "Manifest is valid\n",
    });

    const manifest = JSON.parse(await read(dir, "plugin.json"));
    manifest.parts[0].summaryField = "meal";
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
    const refused = await plugin(dir, ["validate"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(
      "Error: Reading registry manifest plugin.json: parts[0].summaryField: Part 1 totals “meal”, which isn\\'t one of its number fields.\n",
    );
  });

  it("scaffolds the app beside a custom manifest", async () => {
    const dir = await temporaryDirectory();
    const project = path.join(dir, "project");
    await mkdir(project);
    const result = await plugin(dir, [
      "init",
      "temperature-tool",
      "--template",
      "mcp-app",
      "--name",
      "Temperature tool",
      "--manifest",
      "project/custom.json",
    ]);
    expect(result.stdout).toBe(
      "Created project/custom.json\nCreated project/server.ts\nCreated project/temperature.html\nCreated project/README.md\n",
    );
    expect(JSON.parse(await read(project, "custom.json")).name).toBe("Temperature tool");
    expect((await readdir(project)).sort()).toEqual([
      "README.md",
      "custom.json",
      "server.ts",
      "temperature.html",
    ]);
    expect(await readdir(dir)).toEqual(["project"]);
  });

  it("preserves existing files when scaffolding fails", async () => {
    const dir = await temporaryDirectory();
    await writeFile(path.join(dir, "README.md"), "Current project instructions");
    const result = await plugin(dir, ["init", "temperature-tool", "--template", "mcp-app"]);
    expect(result).toEqual({ code: 1, stdout: "", stderr: "Error: README.md already exists\n" });
    expect(await read(dir, "README.md")).toBe("Current project instructions");
    expect(await readdir(dir)).toEqual(["README.md"]);
  });

  it("refuses two starter files at one path and a manifest folder that does not exist", async () => {
    const dir = await temporaryDirectory();
    const result = await plugin(dir, [
      "init",
      "temperature-tool",
      "--template",
      "mcp-app",
      "--manifest",
      "server.ts",
    ]);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "Error: Multiple template files would use server.ts\n",
    });
    expect(await readdir(dir)).toEqual([]);

    const missing = await plugin(dir, ["init", "x", "--manifest", "absent/plugin.json"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^Error: Creating absent\/plugin\.json: /);
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps the skill default and a custom manifest path", async () => {
    const dir = await temporaryDirectory();
    const result = await plugin(dir, ["init", "release-notes", "--manifest", "skill.json"]);
    expect(result).toEqual({ code: 0, stdout: "Created skill.json\n", stderr: "" });
    expect(await readdir(dir)).toEqual(["skill.json"]);
    const manifest = JSON.parse(await read(dir, "skill.json"));
    expect(manifest.name).toBe("release notes");
    expect(manifest.parts[0].kind).toBe("skill");
    expect(await read(dir, "skill.json")).toBe(`{
  "schemaVersion": 1,
  "name": "release notes",
  "description": "Summarize the main points in the supplied text.",
  "parts": [
    {
      "kind": "skill",
      "id": "summary",
      "instructions": "Summarize the supplied text in three bullet points."
    }
  ]
}
`);
  });

  it("accepts the scaffold alias and refuses an invalid slug or name", async () => {
    const dir = await temporaryDirectory();
    expect(await plugin(dir, ["scaffold", "Bad_Slug"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "Error: Use 1 to 64 lowercase ASCII letters or digits separated by single hyphens\n",
    });
    expect(
      await plugin(dir, ["scaffold", "ok", "--template", "kcal-diary", "--name", " "]),
    ).toEqual({ code: 1, stdout: "", stderr: "Error: name: Give the plugin a name.\n" });
    expect(await readdir(dir)).toEqual([]);
  });
});
