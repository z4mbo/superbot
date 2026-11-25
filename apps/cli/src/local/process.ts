import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A program to run: its path, arguments, working directory and the whole environment it gets. */
export type Command = {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export type ProcessOutput = {
  success: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: Buffer;
};

export class ProcessFailure extends Error {
  readonly reason: "start" | "limit" | "timeout" | "io";

  constructor(reason: ProcessFailure["reason"]) {
    super(`The process failed: ${reason}`);
    this.name = "ProcessFailure";
    this.reason = reason;
  }
}

export type RunOptions = {
  /** Written to standard input, which is then closed; without it standard input is empty. */
  input?: string;
  timeoutMs: number;
  /** Bytes each output stream may hold before the run fails. */
  maxOutput: number;
  /** Standard error is read only when asked for; otherwise it is discarded. */
  captureStderr?: boolean;
};

/**
 * Runs a program to completion with a clean environment and no window, killing it when it runs
 * past its time or writes more than the limit.
 */
export function runCommand(command: Command, options: RunOptions): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.program, command.args, {
        cwd: command.cwd,
        env: command.env,
        stdio: [
          options.input === undefined ? "ignore" : "pipe",
          "pipe",
          options.captureStderr ? "pipe" : "ignore",
        ],
        windowsHide: true,
      });
    } catch {
      reject(new ProcessFailure("start"));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let sizes = [0, 0];
    let failure: ProcessFailure | undefined;
    const fail = (reason: ProcessFailure["reason"]) => {
      failure ??= new ProcessFailure(reason);
      child.kill();
    };
    const timer = setTimeout(() => fail("timeout"), options.timeoutMs);
    const collect = (chunks: Buffer[], index: number) => (chunk: Buffer) => {
      sizes = sizes.map((size, at) => (at === index ? size + chunk.length : size));
      if ((sizes[index] ?? 0) > options.maxOutput) fail("limit");
      else chunks.push(chunk);
    };
    child.stdout?.on("data", collect(stdout, 0));
    child.stderr?.on("data", collect(stderr, 1));
    child.once("error", () => fail("start"));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => fail("io"));
      child.stdin.end(options.input);
    }
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      const stdoutBytes = Buffer.concat(stdout);
      resolve({
        success: code === 0,
        stdoutBytes,
        stdout: stdoutBytes.toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

/** A fresh private directory, removed after `work` settles. */
export async function withTemporaryDirectory<T>(
  work: (directory: string) => Promise<T>,
  parent = tmpdir(),
): Promise<T> {
  const directory = await mkdtemp(path.join(parent, ".superbot-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Only these variables reach a local CLI; everything else in this process's environment is left out. */
export function pickEnvironment(
  keys: Iterable<string>,
  caseInsensitive = false,
): Record<string, string> {
  const wanted = new Set([...keys].map((key) => (caseInsensitive ? key.toUpperCase() : key)));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (wanted.has(caseInsensitive ? key.toUpperCase() : key)) env[key] = value;
  }
  return env;
}

/**
 * The absolute path of an executable file, with links resolved, or undefined. On Windows only
 * `.exe` files count; elsewhere the file must have an execute bit.
 */
export async function executableAt(file: string): Promise<string | undefined> {
  if (!path.isAbsolute(file)) return undefined;
  try {
    const resolved = await realpath(file);
    if (process.platform === "win32" && path.extname(resolved).toLowerCase() !== ".exe") {
      return undefined;
    }
    const info = await stat(resolved);
    if (!info.isFile()) return undefined;
    if (process.platform !== "win32" && (info.mode & 0o111) === 0) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

/** The absolute directories on PATH, in order. */
export function pathDirectories(): string[] {
  const value = process.env.PATH ?? process.env.Path ?? "";
  return value.split(path.delimiter).filter((directory) => path.isAbsolute(directory));
}

/** The executable file name for this platform. */
export function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}
