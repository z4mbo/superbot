// Phase 1 spike: can a durable harness carry a Superbot run across a process kill? Real Pi
// Durable, real HTTP/SSE against the offline model emulator, real child processes killed
// abruptly. Nothing here changes how Superbot runs agents today.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { resolveRuntimeModel, withOutputBudget } from "@rakazo/adapters";
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

function settledTranscript(event: SpikeEvent) {
  if (event.event !== "settled") throw new Error(`expected a settled event, got ${event.event}`);
  return event.transcript;
}

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
    const ready = await first.waitFor((event) => event.event === "ready");
    console.info(`child runtime: ${JSON.stringify(ready)}`);
    await first.waitFor((event) => event.event === "tool-hang" && event.tool === "charge_card");
    await killHard(first);
    expect(logLines(workdir.effects)).toEqual(["charged 500"]);

    const second = startChild(config);
    const done = await second.waitFor(settled);
    expect(await second.exited).toBe(0);
    server.assertComplete();
    // The side effect happened once, before the kill; the new process never started the tool.
    expect(logLines(workdir.effects)).toEqual(["charged 500"]);
    expect(second.events.some((event) => event.event === "tool-start")).toBe(false);
    // Durable surfaces it to the model as an error result and lets the run go on.
    expect(seenByModel).toEqual([
      { id: "call-read", text: "Order 42 belongs to the fixture customer." },
      {
        id: "call-charge",
        text: "<harness>\n[error] Tool charge_card was interrupted and may have partially run\n</harness>",
      },
    ]);
    expect(done).toMatchObject({ status: "done" });
    expect(settledTranscript(done).slice(1)).toEqual([
      { role: "user", text: "Charge the customer 5 dollars." },
      { role: "assistant", toolCalls: ["read_note", "charge_card"] },
      {
        role: "toolResult",
        toolName: "read_note",
        isError: false,
        text: "Order 42 belongs to the fixture customer.",
      },
      {
        role: "toolResult",
        toolName: "charge_card",
        isError: true,
        text: "<harness>\n[error] Tool charge_card was interrupted and may have partially run\n</harness>",
      },
      { role: "assistant", text: "The charge may not have gone through." },
    ]);
  });

  it("lets a host hook turn an interrupted side effect into its own do-not-retry result", async () => {
    const { workdir, root, storagePath } = await scenario();
    let seenByModel: ReturnType<typeof toolMessages> = [];
    const { server, endpoint } = await emulator([
      {
        expect: anyRequest,
        response: {
          type: "tool",
          id: "call-charge",
          name: "charge_card",
          arguments: { cents: 900 },
        },
      },
      {
        expect(request) {
          seenByModel = toolMessages(request);
        },
        response: { type: "text", text: "I will ask before charging again." },
      },
    ]);
    const config: SpikeChildConfig = {
      storagePath,
      workdir: root,
      endpoints: [endpoint],
      model: { provider: endpoint.provider, modelId: endpoint.modelId },
      prompt: "Charge the customer 9 dollars.",
      requestId: "sqlite-guard-1",
      guardInterrupted: true,
    };
    const first = startChild({ ...config, hang: ["charge_card"] });
    await first.waitFor((event) => event.event === "tool-hang");
    await killHard(first);
    const second = startChild(config);
    const done = await second.waitFor(settled);
    expect(seenByModel).toEqual([
      {
        id: "call-charge",
        // The hook's text, then the diagnostic Durable keeps on every interrupted result.
        text:
          "charge_card was cut off by a restart and may already have happened. Do not retry it; ask the person." +
          "\n<harness>\n[error] Tool charge_card was interrupted and may have partially run\n</harness>",
      },
    ]);
    expect(done).toMatchObject({ status: "done" });
    expect(await second.exited).toBe(0);
    server.assertComplete();
    expect(second.events).toContainEqual({ event: "interrupted", tool: "charge_card" });
    expect(logLines(workdir.effects)).toEqual(["charged 900"]);
  });

  it("reruns a replay-safe tool that was in flight when the process died", async () => {
    const { workdir, root, storagePath } = await scenario();
    const { server, endpoint } = await emulator([
      {
        expect: anyRequest,
        response: {
          type: "tool",
          id: "call-lookup",
          name: "slow_lookup",
          arguments: { order: "7" },
        },
      },
      {
        expect(request) {
          expect(toolMessages(request)).toEqual([{ id: "call-lookup", text: "order 7: shipped" }]);
        },
        response: { type: "text", text: "Order 7 has shipped." },
      },
    ]);
    const config: SpikeChildConfig = {
      storagePath,
      workdir: root,
      endpoints: [endpoint],
      model: { provider: endpoint.provider, modelId: endpoint.modelId },
      prompt: "Where is order 7?",
      requestId: "sqlite-lookup-1",
    };
    const first = startChild({ ...config, hang: ["slow_lookup"] });
    await first.waitFor((event) => event.event === "tool-hang");
    await killHard(first);
    const second = startChild(config);
    const done = await second.waitFor(settled);
    expect(await second.exited).toBe(0);
    server.assertComplete();
    expect(logLines(workdir.reads)).toEqual(["slow_lookup 7", "slow_lookup 7"]);
    expect(settledTranscript(done).at(-1)).toEqual({
      role: "assistant",
      text: "Order 7 has shipped.",
    });
  });

  it("sends a model request again when the process died while the answer streamed", async () => {
    const { root, storagePath } = await scenario();
    const streaming = deferred<void>();
    const { server, endpoint } = await emulator([
      {
        expect: anyRequest,
        response: { type: "hold", text: "Order 7 is", onOpen: () => streaming.resolve() },
      },
      { expect: anyRequest, response: { type: "text", text: "Order 7 has shipped." } },
    ]);
    const config: SpikeChildConfig = {
      storagePath,
      workdir: root,
      endpoints: [endpoint],
      model: { provider: endpoint.provider, modelId: endpoint.modelId },
      prompt: "Where is order 7?",
      requestId: "sqlite-stream-1",
    };
    const first = startChild(config);
    await streaming.promise;
    await killHard(first);
    const second = startChild(config);
    const done = await second.waitFor(settled);
    expect(await second.exited).toBe(0);
    server.assertComplete();
    expect(server.requests).toHaveLength(2);
    // The resent request carries the same context: the cut-off partial answer is not in it.
    expect(server.requests[1]?.messages).toEqual(server.requests[0]?.messages);
    expect(settledTranscript(done).slice(1)).toEqual([
      { role: "user", text: "Where is order 7?" },
      { role: "assistant", text: "Order 7 has shipped." },
    ]);
  });
});

describe("pi-durable spike: two processes on one SQLite file", () => {
  it("has no cross-process lock: a second process takes over a run the first is still running", async () => {
    const { workdir, root, storagePath } = await scenario();
    const { server, endpoint } = await emulator([
      {
        expect: anyRequest,
        response: {
          type: "tool",
          id: "call-lookup",
          name: "slow_lookup",
          arguments: { order: "9" },
        },
      },
      { expect: anyRequest, response: { type: "text", text: "answer from the second process" } },
      { expect: anyRequest, response: { type: "text", text: "answer from the first process" } },
    ]);
    const config: SpikeChildConfig = {
      storagePath,
      workdir: root,
      endpoints: [endpoint],
      model: { provider: endpoint.provider, modelId: endpoint.modelId },
      prompt: "Where is order 9?",
      requestId: "sqlite-two-writers-1",
    };
    const first = startChild({ ...config, hang: ["slow_lookup"] });
    await first.waitFor((event) => event.event === "tool-hang");
    // The first process is alive and mid-tool. A second one opens the same file.
    const second = startChild(config);
    const secondDone = await second.waitFor(settled);
    expect(await second.exited).toBe(0);
    expect(first.process.exitCode).toBeNull();
    // Opening recovered the first process's live tool call as if that process had died, and ran
    // it again beside it: nothing in the storage tells a live writer from a dead one.
    expect(logLines(workdir.reads)).toEqual(["slow_lookup 9", "slow_lookup 9"]);
    expect(secondDone).toMatchObject({ status: "done" });
    expect(settledTranscript(secondDone).at(-1)).toEqual({
      role: "assistant",
      text: "answer from the second process",
    });
    // Now the first process goes on with its stale picture of the run.
    first.process.stdin.write("release\n");
    const firstEnd = await first.waitFor(
      (event) => event.event === "settled" || event.event === "error",
    );
    const firstExit = await first.exited;
    // Its next commit collides with what the second process stored, which fails its whole
    // Session. SQLite's own locking kept the file consistent: the second process's run stands.
    expect(firstEnd).toEqual({
      event: "error",
      message: expect.stringMatching(/^storage_failed: Error: ID \d+ already belongs to entry$/),
    });
    expect(firstExit).toBe(1);
    expect(server.requests).toHaveLength(2);
    expect((await readTranscript(storagePath, endpoint)).slice(1)).toEqual([
      { role: "user", text: "Where is order 9?" },
      { role: "assistant", toolCalls: ["slow_lookup"] },
      { role: "toolResult", toolName: "slow_lookup", isError: false, text: "order 9: shipped" },
      { role: "assistant", text: "answer from the second process" },
    ]);
  });
});

/** Opens the file read-only, as a viewer beside a writer would, and returns the active transcript. */
async function readTranscript(storagePath: string, endpoint: SpikeEndpoint) {
  const storage = await openNodeSqliteStorage(storagePath);
  const viewer = await Harness.open(
    storage,
    { models: spikeModels([endpoint]), registry: createRegistry(), readOnly: true },
    context,
  );
  try {
    const conversation = await viewer.root(context);
    return summarizeTranscript((await conversation.context(context)).messages);
  } finally {
    await viewer.close(context);
  }
}

describe("pi-durable spike: changing a conversation's model", () => {
  it("switches models between turns and mid-run, and keeps the choice across a reopen", async () => {
    const { workdir } = await scenario();
    const a = await emulator(
      [
        { expect: anyRequest, response: { type: "text", text: "first answer, from model A" } },
        {
          expect(request) {
            // Model A picks up a run model B started, with B's tool call and its result.
            expect(request.messages.at(-2)?.tool_calls?.[0]?.function.name).toBe("slow_lookup");
            expect(toolMessages(request)).toEqual([
              { id: "call-lookup", text: "order 5: shipped" },
            ]);
          },
          response: { type: "text", text: "third answer, from model A" },
        },
      ],
      "model-a",
    );
    const b = await emulator(
      [
        {
          expect(request) {
            expect(request.messages.map((message) => message.role)).toEqual([
              "user",
              "assistant",
              "user",
            ]);
          },
          response: {
            type: "tool",
            id: "call-lookup",
            name: "slow_lookup",
            arguments: { order: "5" },
          },
        },
      ],
      "model-b",
    );
    const modelA = { provider: a.endpoint.provider, modelId: a.endpoint.modelId };
    const modelB = { provider: b.endpoint.provider, modelId: b.endpoint.modelId };
    const memory = new MemoryStorage();
    const release = deferred<void>();
    const hung = deferred<void>();
    const options = {
      models: spikeModels([a.endpoint, b.endpoint]),
      registry: spikeRegistry({
        workdir,
        hang: ["slow_lookup"],
        release: release.promise,
        onEvent: (event) => {
          if (event.event === "tool-hang") hung.resolve();
        },
      }),
      settings: SPIKE_SETTINGS,
    };
    const harness = await Harness.open(crashableStorage(memory).storage, options, context);
    const conversation = await harness.root(context, { agent: { model: modelA } });
    const firstTurn = await conversation.submit({ type: "input", content: "Hello." }, context);
    expect(await firstTurn.wait(context)).toMatchObject({ status: "done" });

    // Between turns, as the Model Picker does.
    await conversation.configure({ model: modelB }, context);
    expect((await conversation.agent(context)).model).toEqual(modelB);
    const secondTurn = await conversation.submit(
      { type: "input", content: "Where is order 5?" },
      context,
    );
    const secondWait = secondTurn.wait(context);
    // Mid-run, while model B's tool call runs, as a steering pin does.
    await hung.promise;
    await conversation.configure({ model: modelA }, context);
    release.resolve();
    expect(await secondWait).toMatchObject({ status: "done" });
    a.server.assertComplete();
    b.server.assertComplete();
    expect(a.server.requests).toHaveLength(2);
    expect(b.server.requests).toHaveLength(1);
    await harness.close(context);

    // The choice lives in the conversation's pi.agent document, so it survives a restart.
    const reopened = await Harness.open(
      memory,
      { ...options, registry: createRegistry() },
      context,
    );
    cleanups.push(() => reopened.close(context));
    expect((await (await reopened.root(context)).agent(context)).model).toEqual(modelA);
  });
});

/**
 * Durable looks models up by provider and id. Superbot resolves one per run with its connection's
 * limits applied to the model object, so the runtime hands Durable a view that returns that object.
 */
function pinnedModels(models: Models, model: Model<Api>): Models {
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property === "getModel") {
        return (provider: string, modelId: string) =>
          provider === model.provider && modelId === model.id
            ? model
            : target.getModel(provider, modelId);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("pi-durable spike: the model Superbot resolves", () => {
  it("runs on what resolveRuntimeModel returns, with a per-run output budget pinned", async () => {
    const server = await startModelEmulator({
      steps: [{ expect: anyRequest, response: { type: "text", text: "Resolved by Superbot." } }],
    });
    cleanups.push(() => server.close());
    const config = { ...server.model, maxTokens: 777 };
    const resolved = resolveRuntimeModel(config);
    if (!resolved.model) throw new Error("expected a resolved model");
    // A per-run change Superbot makes after resolving, as overflow recovery does.
    const target = withOutputBudget(
      { config, models: resolved.models, model: resolved.model },
      555,
    );
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models: pinnedModels(target.models, target.model),
        registry: createRegistry(),
        settings: SPIKE_SETTINGS,
      },
      context,
    );
    cleanups.push(() => harness.close(context));
    const conversation = await harness.root(context, {
      agent: { model: { provider: resolved.provider, modelId: resolved.modelId } },
    });
    const turn = await conversation.submit({ type: "input", content: "Hello." }, context);
    expect(await turn.wait(context)).toMatchObject({ status: "done" });
    server.assertComplete();
    const body = server.requests[0] as unknown as Record<string, unknown>;
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(555);
    // Looked up by id alone, the registry has the connection's limit, not the run's.
    expect(resolved.models.getModel(resolved.provider, resolved.modelId)?.maxTokens).toBe(777);
  });
});

describe("pi-durable spike: storage format", () => {
  it("refuses a database written by a newer harness, so a downgrade cannot reopen it", async () => {
    const { storagePath } = await scenario();
    const storage = await openNodeSqliteStorage(storagePath);
    await storage.close(context);
    const database = new DatabaseSync(storagePath);
    try {
      const { version } = database.prepare("SELECT version FROM durable_schema").get() as {
        version: number;
      };
      expect(version).toBe(2);
      // What a later pi-durable release would leave behind after migrating the file.
      database.prepare("UPDATE durable_schema SET version = ?").run(version + 1);
    } finally {
      database.close();
    }
    await expect(openNodeSqliteStorage(storagePath)).rejects.toThrow(
      "SQLite schema version 3 is newer than supported version 2",
    );
  });
});
