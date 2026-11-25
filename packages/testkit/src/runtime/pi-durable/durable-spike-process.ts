// What the durable spike's tests share: scratch folders, the model emulator, and child processes
// they start, read events from and kill abruptly. Each test file passes its own cleanup list,
// which it runs after every test.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "../../model-emulator.js";
import { startModelEmulator } from "../../model-emulator.js";
import type { SpikeEndpoint, SpikeEvent } from "./durable-spike-fixture.js";
import { SPIKE_EVENT_PREFIX, spikeWorkdir } from "./durable-spike-fixture.js";

export type Cleanups = Array<() => Promise<void>>;

const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
// Children run on this test's Node unless a test run points them at another runtime, such as
// Electron's (with ELECTRON_RUN_AS_NODE=1), which the desktop app's local server runs on.
const childNode = process.env.DURABLE_SPIKE_NODE || process.execPath;

/** A scratch folder with the note the tools read, removed after the test. */
export async function spikeScenario(cleanups: Cleanups) {
  const root = await mkdtemp(path.join(tmpdir(), "durable-spike-"));
  // Windows can hold a killed process's file handles for a moment; retry the removal.
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workdir = spikeWorkdir(root);
  await writeFile(workdir.note, "Order 42 belongs to the fixture customer.");
  return { root, workdir };
}

export async function spikeEmulator(
  cleanups: Cleanups,
  steps: ModelEmulatorStep[],
  modelId = "fixture-model",
) {
  const server = await startModelEmulator({ steps, modelId });
  cleanups.push(() => server.close());
  const endpoint: SpikeEndpoint = {
    provider: `fixture-${modelId}`,
    modelId,
    baseUrl: server.baseUrl,
  };
  return { server, endpoint };
}

export const anyRequest = () => {};

export function toolMessages(request: ModelEmulatorRequest) {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => ({
      id: message.tool_call_id,
      text: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    }));
}

export interface SpikeChild<E extends { event: string } = SpikeEvent> {
  process: ChildProcessWithoutNullStreams;
  events: E[];
  stderr: string[];
  waitFor(match: (event: E) => boolean): Promise<E>;
  exited: Promise<number | null>;
}

/** Runs `script` with `config` as its argument; killed after the test if still running. */
export function startSpikeChild<E extends { event: string } = SpikeEvent>(
  cleanups: Cleanups,
  script: string,
  config: unknown,
): SpikeChild<E> {
  const child = spawn(childNode, ["--import", tsxLoader, script, JSON.stringify(config)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  const events: E[] = [];
  const stderr: string[] = [];
  const waiters = new Set<{ match: (event: E) => boolean; resolve(event: E): void }>();
  let buffered = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(SPIKE_EVENT_PREFIX)) continue;
      const event = JSON.parse(line.slice(SPIKE_EVENT_PREFIX.length)) as E;
      events.push(event);
      for (const waiter of waiters) {
        if (!waiter.match(event)) continue;
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
  // A line written just as the child exits fails on the closed pipe; keep it with the child's output.
  child.stdin.on("error", (error) => stderr.push(String(error)));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return {
    process: child,
    events,
    stderr,
    exited,
    waitFor(match) {
      const found = events.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        waiters.add({ match, resolve });
        void exited.then((code) =>
          reject(
            new Error(
              `child exited (${code}) before the expected event; events: ${JSON.stringify(events)}; stderr: ${stderr.join("")}`,
            ),
          ),
        );
      });
    },
  };
}

/** An abrupt kill on every OS: SIGKILL on Linux and macOS, TerminateProcess on Windows. */
export async function killHard(child: SpikeChild<{ event: string }>) {
  child.process.kill("SIGKILL");
  await child.exited;
}

export const settled = (event: {
  event: string;
}): event is Extract<SpikeEvent, { event: "settled" }> => event.event === "settled";

export function settledTranscript(event: { event: string }) {
  if (!settled(event)) throw new Error(`expected a settled event, got ${event.event}`);
  return event.transcript;
}
