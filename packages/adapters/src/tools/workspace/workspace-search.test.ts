import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DesktopSandboxProvider } from "../../providers/computer/desktop/desktop-sandbox.js";
import type { RunWorkspace } from "../workspace-file-tools.js";
import {
  expandBraces,
  globFromTool,
  searchCommandArgv,
  searchFilesFromTool,
} from "./workspace-search.js";

const context = {
  operationId: "1",
  traceId: "1",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
} as AdapterContext;

function workspaceFor(
  computer: ComputerRef,
  computerMode: ComputerMode = "dedicated",
  runSecrets: string[] = [],
): RunWorkspace {
  return {
    botId: "bot-1",
    computerMode,
    computer: async () => computer,
    markDirty: () => {},
    context,
    runSecrets,
  };
}

describe("search command", () => {
  it("passes the pattern and path as arguments, never as shell text", () => {
    const argv = searchCommandArgv({
      pattern: "-rf $(reboot)",
      target: "src",
      limit: 5,
      ignoreCase: false,
      names: ["*.ts"],
    });
    expect(argv.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(argv[2]).not.toContain("reboot");
    expect(argv.slice(3)).toEqual(["rakazo-search", "-rf $(reboot)", "src", "5", "0", "*.ts"]);
  });

  it("expands brace alternatives for name filters", () => {
    expect(expandBraces("*.{ts,tsx}")).toEqual(["*.ts", "*.tsx"]);
    expect(expandBraces("{a,b}.{x,y}")).toEqual(["a.x", "a.y", "b.x", "b.y"]);
    expect(expandBraces("plain.md")).toEqual(["plain.md"]);
  });

  it("stops a slow search and says so", async () => {
    const sandbox = {
      async *execute() {
        yield { type: "stderr" as const, data: "command timed out\n" };
        yield { type: "exit" as const, code: 124 };
      },
    } as unknown as SandboxProvider;
    const computer = { id: "c", botId: "bot-1", kind: "docker", providerRef: "c" } as ComputerRef;
    await expect(
      searchFilesFromTool(
        sandbox,
        workspaceFor(computer),
        { pattern: "(a+)+$" },
        {
          nativeShell: false,
        },
      ),
    ).resolves.toEqual({ error: expect.stringContaining("search stopped"), path: "" });
  });

  it("ends options before the pattern wherever ripgrep or grep reads it", () => {
    const script = searchCommandArgv({
      pattern: "x",
      target: ".",
      limit: 1,
      ignoreCase: false,
      names: [],
    })[2]!;
    const reads = script.split("\n").filter((line) => line.includes(`"$pattern"`));
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const line of reads) expect(line).toContain('-- "$pattern"');
  });

  it("reads ripgrep's output into capped matches with paths as the bot names them", async () => {
    const argv: string[][] = [];
    const long = `const value = "${"a".repeat(400)}";`;
    const stdout = [
      `bots/bot-1/src/app.ts\u00001:${long}`,
      "bots/bot-1/src/app.ts\u00002:token=TOPSECRET",
      "bots/bot-1/src/view.tsx\u000010:<Foo />",
      "",
    ].join("\n");
    const sandbox = {
      async *execute(_computer: ComputerRef, request: { argv: string[] }) {
        argv.push(request.argv);
        yield { type: "stdout" as const, data: stdout };
        yield { type: "exit" as const, code: 0 };
      },
    } as unknown as SandboxProvider;
    const computer = { id: "c", botId: "bot-1", kind: "docker", providerRef: "c" } as ComputerRef;
    const result = await searchFilesFromTool(
      sandbox,
      workspaceFor(computer, "team", ["TOPSECRET"]),
      { pattern: "a", path: "src", max_matches: 2, case_sensitive: false, glob: "*.ts" },
      { nativeShell: false },
    );
    // The script prints one line past the limit so the result can say there were more.
    expect(argv[0]!.slice(3)).toEqual(["rakazo-search", "a", "bots/bot-1/src", "2", "1", "*.ts"]);
    expect(result).toEqual({
      path: "src",
      pattern: "a",
      matches: [
        { file: "src/app.ts", line: 1, text: `${long.slice(0, 200)}…` },
        { file: "src/app.ts", line: 2, text: "token=[redacted]" },
      ],
      truncated: true,
    });
  });

  it("is refused on a computer with its own native shell", async () => {
    const computer = { id: "c", botId: "bot-1", kind: "desktop", providerRef: "c" } as ComputerRef;
    await expect(
      searchFilesFromTool(
        {} as SandboxProvider,
        workspaceFor(computer),
        { pattern: "x" },
        {
          nativeShell: true,
        },
      ),
    ).resolves.toEqual({ error: expect.stringContaining("unavailable on this computer") });
  });
});

// The local desktop computer runs these scripts with the host's bash, GNU find and grep, and rg
// when it is installed, so they run where the Linux computer image would.
describe.skipIf(process.platform !== "linux")("search_files and glob on a real folder", () => {
  let root: string;
  let desktop: DesktopSandboxProvider;
  let computer: ComputerRef;
  let home: string;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "rakazo-search-"));
    desktop = new DesktopSandboxProvider({ root: path.join(root, "homes") });
    computer = await desktop.provision({ botId: "search", homePath: "/unused" }, context);
    home = computer.providerRef!;
    const files: Record<string, string> = {
      "src/app.ts": "const Foo = 1;\nfoo();\nexport { Foo };\n",
      "src/view.tsx": "export const View = () => <Foo />;\n",
      "src/deep/util.ts": "// TODO: tidy\n",
      "docs/readme.md": "Foo docs\n-flag value\n",
      "many.txt": Array.from({ length: 8 }, (_, index) => `hit ${index}`).join("\n"),
      "node_modules/pkg/index.ts": "Foo in a dependency\n",
      ".hidden/secret.ts": "Foo hidden\n",
      ".git/config": "Foo git\n",
      "token.txt": "key=TOPSECRET\n",
    };
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(home, name)), { recursive: true });
      writeFileSync(path.join(home, name), content);
    }
    mkdirSync(path.join(root, "outside"));
    writeFileSync(path.join(root, "outside", "x.ts"), "Foo outside\n");
    symlinkSync(path.join(root, "outside"), path.join(home, "escape"));
  });

  afterAll(async () => {
    await desktop.destroy(computer, context);
    rmSync(root, { recursive: true, force: true });
  });

  const search = (args: Record<string, unknown>, secrets: string[] = []) =>
    searchFilesFromTool(desktop, workspaceFor(computer, "dedicated", secrets), args, {
      nativeShell: false,
    });
  const glob = (args: Record<string, unknown>, nativeShell = false) =>
    globFromTool(desktop, workspaceFor(computer), args, { nativeShell });

  it("returns file, line and text, skipping hidden files and node_modules", async () => {
    await expect(search({ pattern: "Foo" })).resolves.toEqual({
      path: "",
      pattern: "Foo",
      matches: [
        { file: "docs/readme.md", line: 1, text: "Foo docs" },
        { file: "src/app.ts", line: 1, text: "const Foo = 1;" },
        { file: "src/app.ts", line: 3, text: "export { Foo };" },
        { file: "src/view.tsx", line: 1, text: "export const View = () => <Foo />;" },
      ],
      truncated: false,
    });
  });

  it("filters by file name, path and case", async () => {
    const named = await search({ pattern: "foo", glob: "*.{ts,tsx}", case_sensitive: false });
    expect(named).toMatchObject({
      matches: [
        { file: "src/app.ts", line: 1 },
        { file: "src/app.ts", line: 2 },
        { file: "src/app.ts", line: 3 },
        { file: "src/view.tsx", line: 1 },
      ],
    });
    await expect(search({ pattern: "foo", path: "src" })).resolves.toMatchObject({
      matches: [{ file: "src/app.ts", line: 2, text: "foo();" }],
    });
    await expect(search({ pattern: "Foo", glob: "src/*.ts" })).resolves.toHaveProperty("error");
  });

  it("searches for a pattern that begins with a dash", async () => {
    await expect(search({ pattern: "-flag" })).resolves.toMatchObject({
      matches: [{ file: "docs/readme.md", line: 2, text: "-flag value" }],
    });
  });

  it("caps matches and says the result was truncated", async () => {
    const result = (await search({ pattern: "^hit", max_matches: 3 })) as {
      matches: unknown[];
      truncated: boolean;
    };
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("redacts run secrets from matching lines", async () => {
    const result = await search({ pattern: "key=" }, ["TOPSECRET"]);
    expect(JSON.stringify(result)).not.toContain("TOPSECRET");
  });

  it("refuses an invalid pattern and paths outside the workspace", async () => {
    await expect(search({ pattern: "(" })).resolves.toMatchObject({
      error: expect.stringContaining("invalid pattern"),
    });
    await expect(search({ pattern: "Foo", path: "../.." })).resolves.toMatchObject({
      error: expect.stringContaining("escapes"),
    });
    await expect(search({ pattern: "Foo", path: "escape" })).resolves.toMatchObject({
      error: "the path leaves the workspace",
    });
    await expect(search({ pattern: "Foo", path: "missing" })).resolves.toMatchObject({
      error: "no such file or folder",
    });
  });

  it("finds files by glob, skipping .git and node_modules", async () => {
    await expect(glob({ pattern: "**/*.{ts,tsx}" })).resolves.toEqual({
      path: "",
      pattern: "**/*.{ts,tsx}",
      files: ["src/app.ts", "src/deep/util.ts", "src/view.tsx"],
      truncated: false,
    });
    await expect(glob({ pattern: "*.ts", path: "src" })).resolves.toMatchObject({
      files: ["src/app.ts"],
    });
    await expect(glob({ pattern: ".hidden/*.ts" })).resolves.toMatchObject({
      files: [".hidden/secret.ts"],
    });
    await expect(glob({ pattern: "**/config" })).resolves.toMatchObject({ files: [] });
  });

  it("caps glob results and refuses a path that leaves the workspace", async () => {
    await expect(glob({ pattern: "**/*", max_results: 2 })).resolves.toMatchObject({
      files: ["docs/readme.md", "many.txt"],
      truncated: true,
    });
    await expect(glob({ pattern: "*.ts", path: "escape" })).resolves.toMatchObject({
      error: "the path leaves the workspace",
    });
  });

  it("walks with the file API on a computer with its own native shell", async () => {
    await expect(glob({ pattern: "**/*.{ts,tsx}" }, true)).resolves.toEqual({
      path: "",
      pattern: "**/*.{ts,tsx}",
      files: ["src/app.ts", "src/deep/util.ts", "src/view.tsx"],
      truncated: false,
    });
  });
});
