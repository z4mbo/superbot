// Phase 1 spike: can a durable harness carry a Superbot run across a process kill? Real Pi
// Durable, real HTTP/SSE against the offline model emulator, real child processes killed
// abruptly. Nothing here changes how Superbot runs agents today.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "../../model-emulator.js";
import { startModelEmulator } from "../../model-emulator.js";
import type { SpikeChildConfig, SpikeEndpoint, SpikeEvent } from "./durable-spike-fixture.js";
import {
  crashableStorage,
  logLines,
  SPIKE_EVENT_PREFIX,
  SPIKE_SETTINGS,
  spikeModels,
  spikeRegistry,
  spikeWorkdir,
  summarizeTranscript,
} from "./durable-spike-fixture.js";

const context = BACKGROUND_CONTEXT;
const childScript = fileURLToPath(new URL("./durable-spike-child.ts", import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
// Children run on this test's Node unless a test run points them at another runtime, such as
// Electron's (with ELECTRON_RUN_AS_NODE=1), which the desktop app's local server runs on.
const childNode = process.env.DURABLE_SPIKE_NODE || process.execPath;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scenario() {
  const root = await mkdtemp(path.join(tmpdir(), "durable-spike-"));
  // Windows can hold a killed process's file handles for a moment; retry the removal.
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workdir = spikeWorkdir(root);
  await writeFile(workdir.note, "Order 42 belongs to the fixture customer.");
  return { root, workdir, storagePath: path.join(root, "session.sqlite") };
}

async function emulator(steps: ModelEmulatorStep[], modelId = "fixture-model") {
  const server = await startModelEmulator({ steps, modelId });
  cleanups.push(() => server.close());
  const endpoint: SpikeEndpoint = {
    provider: `fixture-${modelId}`,
    modelId,
    baseUrl: server.baseUrl,
  };
  return { server, endpoint };
}

const anyRequest = () => {};

function toolMessages(request: ModelEmulatorRequest) {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => ({
      id: message.tool_call_id,
      text: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    }));
}

interface SpikeChild {
  process: ChildProcessWithoutNullStreams;
  events: SpikeEvent[];
  stderr: string[];
  waitFor(match: (event: SpikeEvent) => boolean): Promise<SpikeEvent>;
  exited: Promise<number | null>;
}

function startChild(config: SpikeChildConfig): SpikeChild {
  const child = spawn(childNode, ["--import", tsxLoader, childScript, JSON.stringify(config)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  const events: SpikeEvent[] = [];
  const stderr: string[] = [];
  const waiters = new Set<{
    match: (event: SpikeEvent) => boolean;
    resolve(event: SpikeEvent): void;
  }>();
  let buffered = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(SPIKE_EVENT_PREFIX)) continue;
      const event = JSON.parse(line.slice(SPIKE_EVENT_PREFIX.length)) as SpikeEvent;
      events.push(event);
      for (const waiter of waiters) {
        if (!waiter.match(event)) continue;
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
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
async function killHard(child: SpikeChild) {
  child.process.kill("SIGKILL");
  await child.exited;
}

const settled = (event: SpikeEvent): event is Extract<SpikeEvent, { event: "settled" }> =>
  event.event === "settled";

describe("pi-durable spike: in-memory storage, same process", () => {
  it("resumes a run cut off mid-tool in a new Harness and reruns only the replay-safe call", async () => {
    const { workdir } = await scenario();
    const { server, endpoint } = await emulator([
      {
        expect: anyRequest,
        response: {
          type: "tools",
          calls: [
            { id: "call-read", name: "read_note", arguments: {} },
            { id: "call-lookup", name: "slow_lookup", arguments: { order: "42" } },
          ],
        },
      },
      {
        expect(request) {
          expect(toolMessages(request)).toEqual([
            { id: "call-read", text: "Order 42 belongs to the fixture customer." },
            { id: "call-lookup", text: "order 42: shipped" },
          ]);
        },
        response: { type: "text", text: "Order 42 has shipped." },
      },
    ]);
    const memory = new MemoryStorage();
    const first = crashableStorage(memory);
    const hung = deferred<void>();
    const before = await Harness.open(
      first.storage,
      {
        models: spikeModels([endpoint]),
        registry: spikeRegistry({
          workdir,
          hang: ["slow_lookup"],
          onEvent: (event) => {
            if (event.event === "tool-hang") hung.resolve();
          },
        }),
        settings: SPIKE_SETTINGS,
      },
      context,
    );
    const root = await before.root(context, {
      agent: { model: { provider: endpoint.provider, modelId: endpoint.modelId } },
    });
    const submission = await root.submit(
      { type: "input", content: "Where is order 42?", requestId: "memory-1" },
      context,
    );
    const firstWait = submission.wait(context).catch((error: unknown) => error);
    await hung.promise;
    first.crash();
    expect(await firstWait).toBeInstanceOf(Error);
    await before.closed;

    const after = await Harness.open(
      memory,
      {
        models: spikeModels([endpoint]),
        registry: spikeRegistry({ workdir }),
        settings: SPIKE_SETTINGS,
      },
      context,
    );
    cleanups.push(() => after.close(context));
    after.resume();
    const resumedRoot = await after.root(context);
    expect(resumedRoot.id).toBe(root.id);
    const again = await resumedRoot.submit(
      { type: "input", content: "Where is order 42?", requestId: "memory-1" },
      context,
    );
    expect(again.id).toBe(submission.id);
    const result = await again.wait(context);
    server.assertComplete();
    expect(result.status).toBe("done");
    expect(logLines(workdir.reads)).toEqual(["read_note", "slow_lookup 42", "slow_lookup 42"]);
    expect(summarizeTranscript((await resumedRoot.context(context)).messages)).toEqual([
      { role: "system", text: "" },
      { role: "user", text: "Where is order 42?" },
      { role: "assistant", toolCalls: ["read_note", "slow_lookup"] },
      {
        role: "toolResult",
        toolName: "read_note",
        isError: false,
        text: "Order 42 belongs to the fixture customer.",
      },
      { role: "toolResult", toolName: "slow_lookup", isError: false, text: "order 42: shipped" },
      { role: "assistant", text: "Order 42 has shipped." },
    ]);
  });
});

describe("pi-durable spike: SQLite storage, killed child process", () => {
  it("does not run a side-effecting tool twice when the process dies while it is in flight", async () => {
    const { workdir, root, storagePath } = await scenario();
    let seenByModel: ReturnType<typeof toolMessages> = [];
    const { server, endpoint } = await emulator([
      {
        expect: anyRequest,
        response: {
          type: "tools",
          calls: [
            { id: "call-read", name: "read_note", arguments: {} },
            { id: "call-charge", name: "charge_card", arguments: { cents: 500 } },
          ],
        },
      },
      {
        expect(request) {
          seenByModel = toolMessages(request);
        },
        response: { type: "text", text: "The charge may not have gone through." },
      },
    ]);
    const config: SpikeChildConfig = {
      storagePath,
      workdir: root,
      endpoints: [endpoint],
      model: { provider: endpoint.provider, modelId: endpoint.modelId },
      prompt: "Charge the customer 5 dollars.",
      requestId: "sqlite-charge-1",
    };
    const first = startChild({ ...config, hang: ["charge_card"] });
    await first.waitFor((event) => event.event === "tool-hang" && event.tool === "charge_card");
    await killHard(first);
    expect(logLines(workdir.effects)).toEqual(["charged 500"]);

    const second = startChild(config);
    const done = await second.waitFor(settled);
    expect(await second.exited).toBe(0);
    server.assertComplete();
    expect(logLines(workdir.effects)).toEqual(["charged 500"]);
    expect(second.events.some((event) => event.event === "tool-start")).toBe(false);
    console.log(JSON.stringify({ seenByModel, done }, null, 2));
    expect(done).toMatchObject({ status: "done" });
  });
});
