import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deadlineSignal, withAbort } from "@rakazo/core";
import type { Command } from "../process.js";
import { ProcessFailure, runCommand } from "../process.js";
import { at, EngineError } from "./engine.js";

const MAX_FRAME = 4 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
export const TURN_TIMEOUT_MS = 180_000;

/** Runs `work` within `ms`; past it the engine has taken too long. */
export async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  const signal = deadlineSignal(ms);
  try {
    return await withAbort(work, signal);
  } catch (error) {
    if (signal.aborted && !(error instanceof EngineError)) throw new EngineError("timeout");
    throw error;
  }
}

/**
 * A temporary directory for one engine process, as the path the process itself will report: the
 * engine is told its working directory and compares it with its own, and macOS keeps temporary
 * files behind a symbolic link.
 */
export async function engineDirectory(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), ".superbot-engine-")));
}

/** Removes an engine directory, trying again while Windows is still releasing it. */
function removeEngineDirectory(cwd: string): Promise<void> {
  return rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Newline-delimited JSON frames to and from one engine process. */
export class Wire {
  readonly cwd: string;
  readonly #child: ChildProcess;
  /** Settles once the engine process is gone, or never started. */
  readonly #exited: Promise<void>;
  #partial: Buffer = Buffer.alloc(0);
  readonly #frames: Buffer[] = [];
  #ended = false;
  #overflow = false;
  #wake: (() => void) | undefined;
  #nextId = 0;
  #pending = false;

  private constructor(child: ChildProcess, cwd: string) {
    this.#child = child;
    this.cwd = cwd;
    this.#exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    child.stdout?.on("data", (chunk: Buffer) => this.#receive(chunk));
    const end = () => {
      this.#ended = true;
      this.#wake?.();
    };
    child.stdout?.once("close", end);
    child.once("error", end);
    child.stdin?.on("error", end);
  }

  /** Starts the engine with the command `build` makes for a fresh working directory. */
  static async launch(build: (cwd: string) => Promise<Command> | Command): Promise<Wire> {
    let cwd: string;
    try {
      cwd = await engineDirectory();
    } catch {
      throw new EngineError("start");
    }
    try {
      const command = await build(cwd);
      const child = spawn(command.program, command.args, {
        cwd: command.cwd,
        env: command.env,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      return new Wire(child, cwd);
    } catch (error) {
      await removeEngineDirectory(cwd);
      if (error instanceof EngineError) throw error;
      throw new EngineError("start");
    }
  }

  async write(frame: unknown): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(frame), "utf8");
    if (bytes.length >= MAX_FRAME) throw new EngineError("limit");
    const stdin = this.#child.stdin;
    if (!stdin || this.#ended) throw new EngineError("closed");
    await new Promise<void>((resolve, reject) => {
      stdin.write(Buffer.concat([bytes, Buffer.from("\n")]), (error) =>
        error ? reject(new EngineError("closed")) : resolve(),
      );
    });
  }

  async read(): Promise<unknown> {
    for (;;) {
      const frame = this.#frames.shift();
      if (frame) {
        try {
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
        } catch {
          throw new EngineError("protocol");
        }
      }
      if (this.#overflow) throw new EngineError("limit");
      if (this.#ended) throw new EngineError("closed");
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }

  /**
   * Sends one JSON-RPC request and returns its result. The engine's own requests are refused,
   * permission requests as cancelled; its notifications go to `notify`.
   */
  async acp(
    method: string,
    params: unknown,
    timeoutMs: number,
    notify: (frame: unknown) => void = () => {},
  ): Promise<unknown> {
    if (this.#pending) throw new EngineError("closed");
    this.#pending = true;
    this.#nextId += 1;
    const id = this.#nextId;
    const exchange = async () => {
      await this.write({ jsonrpc: "2.0", id, method, params });
      for (;;) {
        const frame = await this.read();
        if (at(frame, "jsonrpc") !== "2.0") throw new EngineError("protocol");
        const requested = at(frame, "method");
        if (typeof requested === "string") {
          const requestId = at(frame, "id");
          if (requestId === undefined) notify(frame);
          else if (requested === "session/request_permission") {
            await this.write({
              jsonrpc: "2.0",
              id: requestId,
              result: { outcome: { outcome: "cancelled" } },
            });
          } else {
            await this.write({
              jsonrpc: "2.0",
              id: requestId,
              error: { code: -32601, message: "Method not supported" },
            });
          }
          continue;
        }
        if (at(frame, "id") !== id) throw new EngineError("protocol");
        const error = at(frame, "error");
        if (error !== undefined) {
          const code = at(error, "code");
          if (typeof code !== "number" || !Number.isInteger(code)) {
            throw new EngineError("protocol");
          }
          throw new EngineError("remote", code);
        }
        const result = at(frame, "result");
        if (result === undefined) throw new EngineError("protocol");
        return result;
      }
    };
    try {
      const result = await within(timeoutMs, exchange());
      this.#pending = false;
      return result;
    } catch (error) {
      if (error instanceof EngineError && error.kind === "remote") this.#pending = false;
      else this.terminate();
      throw error;
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.acp(method, params, REQUEST_TIMEOUT_MS);
  }

  /** Ends the engine at once; it gets no chance to refuse, so `close` cannot wait on it forever. */
  terminate(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
    }
  }

  /**
   * Stops the engine and removes its working directory. Windows keeps a running process's
   * working directory locked, so removal waits for the process to be gone.
   */
  async close(): Promise<void> {
    this.terminate();
    await this.#exited;
    await removeEngineDirectory(this.cwd);
  }

  #receive(chunk: Buffer): void {
    let data = Buffer.concat([this.#partial, chunk]);
    for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10)) {
      this.#frames.push(data.subarray(0, end + 1));
      data = data.subarray(end + 1);
    }
    this.#partial = data;
    if (
      this.#partial.length > MAX_FRAME ||
      this.#frames.some((frame) => frame.length > MAX_FRAME)
    ) {
      this.#overflow = true;
      this.terminate();
    }
    this.#wake?.();
  }
}

/** Runs an engine command to completion and returns what it printed. */
export async function runEngineCommand(command: Command, timeoutMs: number): Promise<string> {
  let output: Awaited<ReturnType<typeof runCommand>>;
  try {
    output = await runCommand(command, { timeoutMs, maxOutput: MAX_FRAME });
  } catch (error) {
    const reason = error instanceof ProcessFailure ? error.reason : "start";
    throw new EngineError(reason === "io" ? "closed" : reason);
  }
  if (!output.success) throw new EngineError("remote", 0);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output.stdoutBytes);
  } catch {
    throw new EngineError("protocol");
  }
}

/** Runs `work` in a temporary directory that is removed afterwards. */
export async function inEngineDirectory<T>(work: (cwd: string) => Promise<T>): Promise<T> {
  let cwd: string;
  try {
    cwd = await engineDirectory();
  } catch {
    throw new EngineError("start");
  }
  try {
    return await work(cwd);
  } finally {
    await removeEngineDirectory(cwd);
  }
}
