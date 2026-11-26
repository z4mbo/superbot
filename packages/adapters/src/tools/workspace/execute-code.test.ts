import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DesktopSandboxProvider } from "../../providers/computer/desktop/desktop-sandbox.js";
import {
  EXECUTE_CODE_DEFAULT_TIMEOUT_SECONDS,
  EXECUTE_CODE_MAX_CHARS,
  EXECUTE_CODE_MAX_TIMEOUT_SECONDS,
  EXECUTE_CODE_OUTPUT_MAX_CHARS,
  EXECUTE_CODE_PYTHON_RUNNER,
  EXECUTE_CODE_WRAPPER,
  executeCode,
  executeCodeArgv,
  NO_PYTHON_MESSAGE,
  parseExecuteCodeCall,
  splitExecuteCodeOutput,
} from "./execute-code.js";

const context = {
  operationId: "1",
  traceId: "1",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
} as AdapterContext;
const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };

describe("parseExecuteCodeCall", () => {
  it("takes Python with a default timeout, and clamps one asked for to the limit", () => {
    expect(parseExecuteCodeCall({ code: "1+1" })).toEqual({
      language: "python",
      code: "1+1",
      timeoutSeconds: EXECUTE_CODE_DEFAULT_TIMEOUT_SECONDS,
    });
    expect(parseExecuteCodeCall({ code: "1", timeout_seconds: 600 })).toMatchObject({
      timeoutSeconds: EXECUTE_CODE_MAX_TIMEOUT_SECONDS,
    });
    expect(parseExecuteCodeCall({ code: "1", timeout_seconds: 0.2 })).toMatchObject({
      timeoutSeconds: 1,
    });
  });

  it.each([
    [{}, "needs code"],
    [{ code: "   " }, "needs code"],
    [{ code: "x".repeat(EXECUTE_CODE_MAX_CHARS + 1) }, "at most"],
    [{ code: "1", language: "javascript" }, "python only"],
    [{ code: "1", timeout_seconds: -1 }, "positive"],
    [{ code: "1", timeout_seconds: "10" }, "positive"],
  ])("refuses %j", (args, message) => {
    expect(parseExecuteCodeCall(args as Record<string, unknown>)).toEqual({
      error: expect.stringContaining(message),
    });
  });
});

describe("executeCodeArgv", () => {
  it("passes the code as the last argument, never as part of a shell line", () => {
    const code = "print('$(rm -rf ~)'); `reboot`; \"; exit 0; '";
    const argv = executeCodeArgv({ code, timeoutSeconds: 5, boundary: "b-1" });
    expect(argv.slice(0, 4)).toEqual(["bash", "-c", EXECUTE_CODE_WRAPPER, "rakazo-execute-code"]);
    expect(argv.at(-1)).toBe(code);
    expect(argv.at(-2)).toBe(EXECUTE_CODE_PYTHON_RUNNER);
    expect(argv.slice(4, 7)).toEqual([String(2 * 1024 * 1024), "5", "b-1"]);
    expect(EXECUTE_CODE_WRAPPER).not.toContain("reboot");
    // The wrapper reads its arguments as quoted variables only.
    expect(EXECUTE_CODE_WRAPPER).toContain("printf '%s' \"$code\"");
  });
});

describe("splitExecuteCodeOutput", () => {
  it("separates the snippet's output from the trailer after the last boundary", () => {
    const stdout = 'hello\n\nb-1\n{"timedOut":false,"status":0}\n{"result":2,"stdoutDropped":0}';
    expect(splitExecuteCodeOutput(stdout, "b-1")).toEqual({
      stdout: "hello\n",
      trailer: { timedOut: false, status: 0, result: 2, stdoutDropped: 0 },
    });
    expect(splitExecuteCodeOutput("no trailer", "b-1")).toEqual({
      stdout: "no trailer",
      trailer: undefined,
    });
    // A snippet that prints a forged boundary only loses its own result.
    expect(splitExecuteCodeOutput("x\nb-1\nnot json", "b-1").trailer).toEqual({});
  });
});

/** A computer that answers one command with scripted output, recording the request. */
function scripted(answer: (request: CommandRequest) => ProcessEvent[]) {
  const requests: CommandRequest[] = [];
  const sandbox = {
    async *execute(_computer: ComputerRef, request: CommandRequest) {
      requests.push(request);
      for (const event of answer(request)) yield event;
    },
  } as unknown as SandboxProvider;
  return { sandbox, requests };
}

const trailerFor = (request: CommandRequest, trailer: string, result = "") =>
  `\n${request.argv[6]}\n${trailer}\n${result}`;

describe("executeCode", () => {
  const run = (sandbox: SandboxProvider, secrets: string[] = [], code = "print(1)") =>
    executeCode(
      sandbox,
      computer,
      { language: "python", code, timeoutSeconds: 5 },
      { cwd: "/home/bot", env: { TOKEN: "fake" }, secrets: () => secrets },
      context,
    );

  it("reports output, exit code and the last expression's value, in the bot's folder", async () => {
    const { sandbox, requests } = scripted((request) => [
      {
        type: "stdout",
        data: `hi\n${trailerFor(request, '{"timedOut":false,"status":0}', '{"result":{"n":2}}')}`,
      },
      { type: "stderr", data: "warn\n" },
      { type: "exit", code: 0 },
    ]);
    expect(await run(sandbox)).toEqual({
      stdout: "hi\n",
      stderr: "warn\n",
      exitCode: 0,
      timedOut: false,
      result: { n: 2 },
    });
    expect(requests[0]).toMatchObject({ cwd: "/home/bot", env: { TOKEN: "fake" } });
    // The computer stops it a little after the snippet's own limit, never later.
    expect(requests[0]!.timeoutMs).toBe(15_000);
  });

  it("reports a failing snippet's exit code and its traceback", async () => {
    const { sandbox } = scripted((request) => [
      { type: "stdout", data: trailerFor(request, '{"timedOut":false,"status":1}', "{}") },
      { type: "stderr", data: "Traceback ...\nZeroDivisionError: division by zero\n" },
      { type: "exit", code: 1 },
    ]);
    expect(await run(sandbox)).toMatchObject({
      exitCode: 1,
      timedOut: false,
      stderr: expect.stringContaining("ZeroDivisionError"),
    });
  });

  it("reports a snippet stopped at its time limit, with no exit code", async () => {
    const { sandbox } = scripted((request) => [
      {
        type: "stdout",
        data: `partial\n${trailerFor(request, '{"timedOut":true,"status":137}', "{}")}`,
      },
      { type: "exit", code: 124 },
    ]);
    expect(await run(sandbox)).toMatchObject({
      stdout: "partial\n",
      exitCode: null,
      timedOut: true,
    });
  });

  it("says when the computer has no python3, and ran nothing", async () => {
    const { sandbox } = scripted((request) => [
      {
        type: "stdout",
        data: trailerFor(request, '{"timedOut":false,"status":127,"missing":"python3"}'),
      },
      { type: "exit", code: 127 },
    ]);
    expect(await run(sandbox)).toEqual({ error: NO_PYTHON_MESSAGE });
  });

  it("cuts long output with a marker, counting what the computer already dropped", async () => {
    const { sandbox } = scripted((request) => [
      {
        type: "stdout",
        data: `${"a".repeat(EXECUTE_CODE_OUTPUT_MAX_CHARS + 500)}${trailerFor(request, '{"timedOut":false,"status":0}', '{"stdoutDropped":1000}')}`,
      },
      { type: "exit", code: 0 },
    ]);
    const result = (await run(sandbox)) as { stdout: string; truncated: boolean };
    expect(result.truncated).toBe(true);
    expect(result.stdout).toMatch(/\n…\[1500 characters cut\]$/);
    expect(result.stdout.length).toBeLessThan(EXECUTE_CODE_OUTPUT_MAX_CHARS + 40);
  });

  it("redacts the run's secrets in output and result, even one cut at the edge", async () => {
    const secret = "fake-secret-value-123";
    const edge = "x".repeat(EXECUTE_CODE_OUTPUT_MAX_CHARS - 5);
    const { sandbox } = scripted((request) => [
      {
        type: "stdout",
        data: `${edge}${secret}${trailerFor(request, '{"timedOut":false,"status":0}', JSON.stringify({ resultText: `'${secret}'` }))}`,
      },
      { type: "stderr", data: `oops ${secret}\n` },
      { type: "exit", code: 0 },
    ]);
    const result = await run(sandbox, [secret]);
    const text = JSON.stringify(result);
    expect(text).not.toContain("fake-secret");
    expect(text).not.toContain(secret.slice(0, 5));
    expect(result).toMatchObject({ stderr: "oops [redacted]\n", result: "'[redacted]'" });
  });
});

const python = spawnSync("python3", ["--version"]).status === 0;
// Hosts without python3 run the missing-interpreter check below instead of the runs that need it;
// each skipped test names that reason in its title.
const NEEDS_PYTHON = python ? "" : " (skipped: no python3 on this host)";

// The local desktop computer runs the snippet with the host's bash and python3, as the Linux
// computer image would. Each snippet is tiny and never touches the network.
describe.skipIf(process.platform !== "linux")("execute_code on a real computer", () => {
  let root: string;
  let scratch: string;
  let desktop: DesktopSandboxProvider;
  let real: ComputerRef;
  // The local computer keeps only the host's usual PATH entries; this one finds the python3 the
  // host runs these checks with, wherever it is installed.
  const onHostPath = (): SandboxProvider =>
    ({
      execute: (target: ComputerRef, request: CommandRequest, ctx: AdapterContext) =>
        desktop.execute(
          target,
          {
            ...request,
            argv: [
              "env",
              `PATH=${process.env.PATH ?? ""}`,
              // NixOS bash resets PATH at startup without it.
              "__NIXOS_SET_ENVIRONMENT_DONE=1",
              ...request.argv,
            ],
          },
          ctx,
        ),
    }) as unknown as SandboxProvider;
  const exec = (code: string, timeoutSeconds = 10, secrets: string[] = []) =>
    executeCode(
      onHostPath(),
      real,
      { language: "python", code, timeoutSeconds },
      { env: { TMPDIR: scratch }, secrets: () => secrets },
      context,
    ) as Promise<Record<string, unknown>>;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "rakazo-execute-code-"));
    scratch = path.join(root, "tmp");
    mkdirSync(scratch);
    desktop = new DesktopSandboxProvider({ root: path.join(root, "homes") });
    real = await desktop.provision({ botId: "code", homePath: "/unused" }, context);
  });

  afterAll(async () => {
    await desktop.destroy(real, context);
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(python)("says python3 is missing on a computer without it", async () => {
    await expect(exec("print(1)")).resolves.toEqual({ error: NO_PYTHON_MESSAGE });
  });

  it.runIf(python)(
    `runs a snippet in the bot's folder and returns its last value${NEEDS_PYTHON}`,
    async () => {
      const result = await exec("import os\nprint('hi')\nos.getcwd(), 6 * 7");
      expect(result).toMatchObject({ stdout: "hi\n", stderr: "", exitCode: 0, timedOut: false });
      expect(result.result).toEqual([real.providerRef, 42]);
      // Nothing of the run is left in the temporary folder.
      expect(readdirSync(scratch)).toEqual([]);
    },
  );

  it.runIf(python)(
    `reports a failure's exit code and traceback, and reads no input${NEEDS_PYTHON}`,
    async () => {
      const failed = await exec("import sys\nprint(sys.stdin.read() == '')\n1 / 0");
      expect(failed).toMatchObject({ stdout: "True\n", exitCode: 1 });
      expect(failed.stderr).toContain("ZeroDivisionError");
      expect(failed.stderr).toContain('File "<code>", line 3');
      expect(failed.stderr).not.toContain("tb_frame");
      await expect(exec("import sys\nsys.exit(3)")).resolves.toMatchObject({ exitCode: 3 });
    },
  );

  it.runIf(python)(
    `stops the snippet and what it started when its time is up${NEEDS_PYTHON}`,
    async () => {
      const marker = path.join(scratch, "child.pid");
      const started = Date.now();
      const result = await exec(
        [
          "import subprocess, time",
          "child = subprocess.Popen(['sleep', '60'])",
          `open(${JSON.stringify(marker)}, 'w').write(str(child.pid))`,
          "print('waiting', flush=True)",
          "time.sleep(60)",
        ].join("\n"),
        2,
      );
      expect(result).toMatchObject({ stdout: "waiting\n", exitCode: null, timedOut: true });
      expect(Date.now() - started).toBeLessThan(20_000);
      const child = Number(readFileSync(marker, "utf8"));
      await vi.waitFor(() => {
        expect(() => process.kill(child, 0)).toThrow();
      });
    },
  );

  it.runIf(python)(`cuts long output and caps memory${NEEDS_PYTHON}`, async () => {
    const long = await exec("print('a' * 3_000_000)");
    expect(long.truncated).toBe(true);
    expect(String(long.stdout)).toMatch(/characters cut\]$/);
    const big = await exec("b = bytearray(3 * 1024 ** 3)");
    expect(big.exitCode).toBe(1);
    expect(big.stderr).toContain("MemoryError");
  });

  it.runIf(python)(
    `redacts the run's secrets from what the snippet prints${NEEDS_PYTHON}`,
    async () => {
      const result = await exec("s = 'fake-' + 'secret-42'\nprint(s)\ns", 10, ["fake-secret-42"]);
      expect(JSON.stringify(result)).not.toContain("fake-secret-42");
    },
  );

  it("removes its temporary folder", () => {
    expect(
      existsSync(scratch)
        ? readdirSync(scratch).filter((name) => name.startsWith("rakazo-code."))
        : [],
    ).toEqual([]);
  });
});
