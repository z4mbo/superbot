import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DesktopSandboxProvider } from "../../providers/computer/desktop/desktop-sandbox.js";
import type { RunWorkspace } from "../workspace-file-tools.js";
import type { ProcessLaunch } from "./background-processes.js";
import {
  PROCESS_OUTPUT_TAIL_BYTES,
  PROCESS_REGISTRY,
  parseProcessRecords,
  processManageFromTool,
  startProcessArgv,
} from "./background-processes.js";

const context = {
  operationId: "1",
  traceId: "1",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
} as AdapterContext;

function workspaceFor(computer: ComputerRef, runSecrets: string[] = []): RunWorkspace {
  return {
    botId: "bot-1",
    computerMode: "dedicated",
    computer: async () => computer,
    markDirty: () => {},
    context,
    runSecrets,
  };
}

describe("process_manage commands", () => {
  it("passes the command as an argument, never as script text", () => {
    const argv = startProcessArgv({
      registry: "/home/bot/.rakazo/processes",
      id: "0123456789ab",
      startedAt: "2026-11-26T00:00:00.000Z",
      command: "npm run dev; rm -rf $(pwd)",
      launch: { kind: "native", shell: "/bin/zsh" },
    });
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(argv[2]).not.toContain("npm run dev");
    expect(argv.slice(3)).toEqual([
      "rakazo-process",
      "/home/bot/.rakazo/processes",
      "0123456789ab",
      "2026-11-26T00:00:00.000Z",
      "npm run dev; rm -rf $(pwd)",
      "/bin/zsh",
      "-lc",
    ]);
  });

  it("reads records and the output tail the status script prints", () => {
    const stdout = [
      "0123456789ab",
      "exited",
      "0\n",
      "41\n",
      "2026-11-26T00:00:00.000Z",
      "npm test",
      "last line\n",
    ].join("\0");
    expect(parseProcessRecords(stdout, true)).toEqual([
      {
        id: "0123456789ab",
        status: "exited",
        exitCode: 0,
        pid: 41,
        startedAt: "2026-11-26T00:00:00.000Z",
        command: "npm test",
        output: "last line\n",
      },
    ]);
    // An unrecognised status reads as stopped, and a field that is not an id ends the list.
    const listed = ["fedcba987654", "odd", "", "", "", "watch", "../etc", "running"].join("\0");
    expect(parseProcessRecords(listed, false)).toEqual([
      { id: "fedcba987654", status: "stopped", command: "watch" },
    ]);
  });

  it("is refused where background processes are unavailable", async () => {
    const computer = { id: "c", botId: "bot-1", kind: "desktop", providerRef: "c" } as ComputerRef;
    await expect(
      processManageFromTool(
        {} as SandboxProvider,
        workspaceFor(computer),
        { action: "list" },
        {
          launch: undefined,
          cwd: undefined,
        },
      ),
    ).resolves.toEqual({ error: expect.stringContaining("unavailable on this computer") });
  });

  it("refuses an unknown action and an id it never issued", async () => {
    const computer = { id: "c", botId: "bot-1", kind: "docker", providerRef: "c" } as ComputerRef;
    const options = { launch: { kind: "native", shell: "sh" } as ProcessLaunch, cwd: undefined };
    const sandbox = {} as SandboxProvider;
    await expect(
      processManageFromTool(sandbox, workspaceFor(computer), { action: "restart" }, options),
    ).resolves.toEqual({ error: expect.stringContaining("action must be one of") });
    for (const id of ["1234", "../../etc", "12345", undefined]) {
      await expect(
        processManageFromTool(sandbox, workspaceFor(computer), { action: "kill", id }, options),
      ).resolves.toEqual({ error: expect.stringContaining("id must be a process id") });
    }
  });
});

// The local desktop computer runs the scripts with the host's sh, ps and awk, as the Linux
// computer image would. Each process is a short shell loop, never anything on the network.
describe.skipIf(process.platform !== "linux")("process_manage on a real computer", () => {
  let root: string;
  let desktop: DesktopSandboxProvider;
  let computer: ComputerRef;
  // A plain shell as the launcher, so no login profile on the host adds to the output.
  const options = {
    launch: { kind: "launcher", argv: ["sh", "-c"] } as ProcessLaunch,
    cwd: undefined,
  };
  const manage = (args: Record<string, unknown>, secrets: string[] = []) =>
    processManageFromTool(desktop, workspaceFor(computer, secrets), args, options) as Promise<
      Record<string, unknown>
    >;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "rakazo-processes-"));
    desktop = new DesktopSandboxProvider({ root: path.join(root, "homes") });
    computer = await desktop.provision({ botId: "processes", homePath: "/unused" }, context);
  });

  afterAll(async () => {
    await desktop.destroy(computer, context);
    rmSync(root, { recursive: true, force: true });
  });

  it("starts a process, checks it from a later call, and stops it", async () => {
    const started = await manage({
      action: "start",
      command: "echo ready; while true; do sleep 1; done",
    });
    expect(started).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      status: "running",
    });
    const { id, pid } = started as { id: string; pid: number };
    expect(alive(pid)).toBe(true);
    expect(existsSync(path.join(computer.providerRef!, PROCESS_REGISTRY, id, "pid"))).toBe(true);

    await vi.waitFor(async () => {
      await expect(manage({ action: "check", id })).resolves.toMatchObject({
        id,
        status: "running",
        pid,
        output: "ready\n",
      });
    });
    // A later run reaches the same record through the registry in the bot's folder.
    const later = await processManageFromTool(
      desktop,
      workspaceFor(computer),
      { action: "list" },
      options,
    );
    expect(later).toMatchObject({
      processes: expect.arrayContaining([expect.objectContaining({ id, status: "running" })]),
    });

    await expect(manage({ action: "kill", id })).resolves.toEqual({ id, status: "killed" });
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    await expect(manage({ action: "check", id })).resolves.toMatchObject({ id, status: "killed" });
    await expect(manage({ action: "kill", id })).resolves.toMatchObject({
      id,
      status: "not running",
    });
  });

  it("reports the exit code and only the end of a long output", async () => {
    const started = await manage({
      action: "start",
      command: `i=0; while [ $i -lt 2000 ]; do echo "line $i"; i=$((i + 1)); done; exit 3`,
    });
    const { id } = started as { id: string };
    await vi.waitFor(async () => {
      await expect(manage({ action: "check", id })).resolves.toMatchObject({
        status: "exited",
        exitCode: 3,
      });
    });
    const checked = (await manage({ action: "check", id })) as { output: string };
    expect(checked.output.length).toBeLessThanOrEqual(PROCESS_OUTPUT_TAIL_BYTES);
    expect(checked.output.endsWith("line 1999\n")).toBe(true);
    expect(checked.output).not.toContain("line 0\n");
  });

  it("refuses to check or stop an id it did not start", async () => {
    await expect(manage({ action: "check", id: "0123456789ab" })).resolves.toEqual({
      error: expect.stringContaining("no process with this id"),
      id: "0123456789ab",
    });
    await expect(manage({ action: "kill", id: "0123456789ab" })).resolves.toEqual({
      error: expect.stringContaining("no process with this id"),
      id: "0123456789ab",
    });
  });

  it("redacts run secrets from the command and its output", async () => {
    const started = await manage({ action: "start", command: "echo token=TOPSECRET" }, [
      "TOPSECRET",
    ]);
    expect(started.command).toBe("echo token=[redacted]");
    const { id } = started as { id: string };
    await vi.waitFor(async () => {
      await expect(manage({ action: "check", id }, ["TOPSECRET"])).resolves.toMatchObject({
        status: "exited",
        command: "echo token=[redacted]",
        output: "token=[redacted]\n",
      });
    });
  });
});
