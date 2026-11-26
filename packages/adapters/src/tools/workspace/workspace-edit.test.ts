import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSandboxProvider } from "../../providers/computer/desktop/desktop-sandbox.js";
import { FakeSandboxProvider } from "../../providers/computer/fake/fake-sandbox.js";
import type { RunWorkspace } from "../workspace-file-tools.js";
import { editFileFromTool } from "./workspace-edit.js";

const context = {
  operationId: "1",
  traceId: "1",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
} as AdapterContext;

function workspaceFor(computer: ComputerRef, computerMode: ComputerMode = "dedicated") {
  let dirty = 0;
  const workspace: RunWorkspace = {
    botId: "bot-1",
    computerMode,
    computer: async () => computer,
    markDirty: () => {
      dirty += 1;
    },
    context,
    runSecrets: [],
  };
  return { workspace, dirtyCount: () => dirty };
}

async function fakeComputer(files: Record<string, string | Uint8Array>, executable = false) {
  const sandbox = new FakeSandboxProvider();
  const computer = await sandbox.provision({ botId: "bot-1", homePath: "/unused" }, context);
  for (const [filePath, content] of Object.entries(files)) {
    await sandbox.writeFile(
      computer,
      {
        path: filePath,
        content: typeof content === "string" ? new TextEncoder().encode(content) : content,
        executable,
      },
      context,
    );
  }
  const read = (filePath: string) =>
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      sandbox.boxes.get(computer.id)!.files.get(filePath)!.content,
    );
  return { sandbox: sandbox as SandboxProvider & FakeSandboxProvider, computer, read };
}

describe("edit_file", () => {
  it("replaces one exact string and returns no file text", async () => {
    const { sandbox, computer, read } = await fakeComputer({ "src/app.ts": "let x = 1;\n" });
    const { workspace, dirtyCount } = workspaceFor(computer);
    const result = await editFileFromTool(sandbox, workspace, {
      path: "src/app.ts",
      old_string: "x = 1",
      new_string: "x = 2",
    });
    expect(result).toEqual({ ok: true, path: "src/app.ts", replacements: 1, bytes: 11 });
    expect(read("src/app.ts")).toBe("let x = 2;\n");
    expect(dirtyCount()).toBe(1);
  });

  it("leaves the file alone when the string is missing or not unique", async () => {
    const { sandbox, computer, read } = await fakeComputer({ "a.txt": "x x\n" });
    const { workspace, dirtyCount } = workspaceFor(computer);
    await expect(
      editFileFromTool(sandbox, workspace, { path: "a.txt", old_string: "y", new_string: "z" }),
    ).resolves.toEqual({ error: expect.stringContaining("not found"), path: "a.txt" });
    await expect(
      editFileFromTool(sandbox, workspace, { path: "a.txt", old_string: "x", new_string: "z" }),
    ).resolves.toEqual({ error: expect.stringContaining("matches 2 places"), path: "a.txt" });
    await expect(
      editFileFromTool(sandbox, workspace, {
        path: "a.txt",
        old_string: "x",
        new_string: "z",
        replace_all: true,
      }),
    ).resolves.toMatchObject({ ok: true, replacements: 2 });
    expect(read("a.txt")).toBe("z z\n");
    expect(dirtyCount()).toBe(1);
  });

  it("applies a patch and reports a mismatched one", async () => {
    const { sandbox, computer, read } = await fakeComputer({ "n.txt": "one\ntwo\nthree\n" });
    const { workspace } = workspaceFor(computer);
    await expect(
      editFileFromTool(sandbox, workspace, {
        path: "n.txt",
        patch: "@@ -1,2 +1,2 @@\n one\n-TWO\n+2\n",
      }),
    ).resolves.toEqual({ error: expect.stringContaining("hunk 1"), path: "n.txt" });
    await expect(
      editFileFromTool(sandbox, workspace, {
        path: "n.txt",
        patch: "--- a/n.txt\n+++ b/n.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n",
      }),
    ).resolves.toMatchObject({ ok: true, hunks: 1 });
    expect(read("n.txt")).toBe("one\n2\nthree\n");
  });

  it("takes exactly one kind of edit", async () => {
    const { sandbox, computer } = await fakeComputer({ "n.txt": "one\n" });
    const { workspace } = workspaceFor(computer);
    await expect(
      editFileFromTool(sandbox, workspace, {
        path: "n.txt",
        old_string: "one",
        new_string: "1",
        patch: "@@ -1 +1 @@\n-one\n+1\n",
      }),
    ).resolves.toEqual({ error: expect.stringContaining("not both"), path: "n.txt" });
    await expect(editFileFromTool(sandbox, workspace, { path: "n.txt" })).resolves.toHaveProperty(
      "error",
    );
    await expect(
      editFileFromTool(sandbox, workspace, { path: "n.txt", old_string: "one" }),
    ).resolves.toEqual({ error: expect.stringContaining("new_string"), path: "n.txt" });
  });

  it("refuses binary and non-UTF-8 files", async () => {
    const { sandbox, computer } = await fakeComputer({
      "image.bin": new Uint8Array([0x89, 0x50, 0x00, 0x47]),
      "latin1.txt": new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
    });
    const { workspace } = workspaceFor(computer);
    for (const filePath of ["image.bin", "latin1.txt"]) {
      await expect(
        editFileFromTool(sandbox, workspace, { path: filePath, old_string: "P", new_string: "Q" }),
      ).resolves.toEqual({ error: expect.stringContaining("not UTF-8 text"), path: filePath });
    }
  });

  it("refuses a path that climbs out of the workspace", async () => {
    const { sandbox, computer } = await fakeComputer({ "a.txt": "a\n" });
    for (const mode of ["dedicated", "team"] as const) {
      const { workspace } = workspaceFor(computer, mode);
      await expect(
        editFileFromTool(sandbox, workspace, {
          path: "../../etc/passwd",
          old_string: "root",
          new_string: "toor",
        }),
      ).resolves.toEqual({ error: expect.stringContaining("escapes"), path: "../../etc/passwd" });
    }
  });

  it("edits a Team Computer file in the bot's folder and keeps its executable bit", async () => {
    const { sandbox, computer, read } = await fakeComputer(
      { "bots/bot-1/run.sh": "#!/bin/sh\necho hi\n" },
      true,
    );
    const { workspace } = workspaceFor(computer, "team");
    await expect(
      editFileFromTool(sandbox, workspace, {
        path: "run.sh",
        old_string: "echo hi",
        new_string: "echo bye",
      }),
    ).resolves.toMatchObject({ ok: true, path: "run.sh" });
    expect(read("bots/bot-1/run.sh")).toBe("#!/bin/sh\necho bye\n");
    expect(sandbox.boxes.get(computer.id)!.files.get("bots/bot-1/run.sh")!.executable).toBe(true);
  });

  it("keeps a byte order mark and CRLF endings", async () => {
    const { sandbox, computer, read } = await fakeComputer({ "w.txt": "﻿a\r\nb\r\n" });
    const { workspace } = workspaceFor(computer);
    await editFileFromTool(sandbox, workspace, {
      path: "w.txt",
      old_string: "a\nb",
      new_string: "a\nB",
    });
    expect(read("w.txt")).toBe("﻿a\r\nB\r\n");
  });
});

describe("edit_file on a local computer", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a link that leads out of the workspace and leaves its target alone",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "rakazo-edit-"));
      roots.push(root);
      const outside = path.join(root, "outside.txt");
      writeFileSync(outside, "secret = 1\n");
      const desktop = new DesktopSandboxProvider({ root: path.join(root, "homes") });
      const computer = await desktop.provision({ botId: "edit", homePath: "/unused" }, context);
      try {
        symlinkSync(outside, path.join(computer.providerRef!, "link.txt"));
        const { workspace } = workspaceFor(computer);
        await expect(
          editFileFromTool(desktop, workspace, {
            path: "link.txt",
            old_string: "secret = 1",
            new_string: "secret = 2",
          }),
        ).resolves.toEqual({ error: expect.stringContaining("escapes"), path: "link.txt" });
        expect(readFileSync(outside, "utf8")).toBe("secret = 1\n");
      } finally {
        await desktop.destroy(computer, context);
      }
    },
  );
});
