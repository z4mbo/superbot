// Phase 1 spike for a durable agent loop: fixtures shared by the in-process tests and the child
// process the cross-process tests kill. Nothing here is imported by production code.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Api, Message, Model, MutableModels } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels } from "@earendil-works/pi-ai/models";
import type { HarnessSettings, Registry, Storage } from "@earendil-works/pi-durable";
import {
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import { num, obj, str } from "@earendil-works/pi-schema";

/** One OpenAI-compatible model endpoint, served by the testkit model emulator. */
export interface SpikeEndpoint {
  provider: string;
  modelId: string;
  baseUrl: string;
}

/**
 * A pi-ai `Models` with one provider per endpoint. Two endpoints get two provider ids, so a
 * conversation can switch between them, as Superbot's Model Picker switches connections.
 */
export function spikeModels(endpoints: readonly SpikeEndpoint[]): MutableModels {
  const models = createModels();
  for (const endpoint of endpoints) {
    const model: Model<"openai-completions"> = {
      id: endpoint.modelId,
      name: endpoint.modelId,
      api: "openai-completions",
      provider: endpoint.provider,
      baseUrl: endpoint.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 1_024,
    };
    models.setProvider(
      createProvider({
        id: endpoint.provider,
        auth: {
          apiKey: {
            name: "Offline fixture",
            // The emulator expects the same placeholder key Superbot sends to keyless local servers.
            resolve: async () => ({ auth: { apiKey: "local" }, source: "offline fixture" }),
          },
        },
        models: [model as Model<Api>],
        api: openAICompletionsApi(),
      }),
    );
  }
  return models;
}

/**
 * Settings for spike runs: no backoff worth waiting for, sequential tools so the order of
 * effects is deterministic, and no automatic compaction in a short fixture conversation.
 */
export const SPIKE_SETTINGS: HarnessSettings = {
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
  toolExecution: "sequential",
  compaction: { enabled: false },
};

/** Files a scenario's tools read and write; shared between the processes of one scenario. */
export interface SpikeWorkdir {
  root: string;
  /** What `read_note` returns. */
  note: string;
  /** One line per `charge_card` execution: the observable side effect. */
  effects: string;
  /** One line per execution of a replay-safe tool. */
  reads: string;
}

export function spikeWorkdir(root: string): SpikeWorkdir {
  return {
    root,
    note: path.join(root, "note.txt"),
    effects: path.join(root, "effects.log"),
    reads: path.join(root, "reads.log"),
  };
}

export function logLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export interface SpikeToolOptions {
  workdir: SpikeWorkdir;
  /** Tools named here stop on their first execution in this process until `release` or an abort. */
  hang?: readonly string[];
  release?: Promise<void>;
  /**
   * Install a policy hook over calls a restart interrupted, as Superbot would for its
   * side-effecting tools: the model is told not to retry, and the host hears about it.
   */
  guardInterrupted?: boolean;
  /** Called when a tool starts and when it is about to hang, so a parent knows when to kill. */
  onEvent?: (event: SpikeEvent) => void;
}

export type SpikeEvent =
  | { event: "tool-start"; tool: string }
  | { event: "tool-hang"; tool: string }
  | { event: "settled"; status: string; transcript: TranscriptLine[]; reason?: string }
  | { event: "ready" }
  | { event: "interrupted"; tool: string }
  | { event: "error"; message: string };

/** Waits for `release`; an abort (a Harness close or failure) rejects it, and a kill ends it. */
function hangUntil(release: Promise<void> | undefined, context: Context): Promise<void> {
  return new Promise((resolve, reject) => {
    void release?.then(resolve);
    const signal = context.abortSignal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * Three tools standing in for Superbot's: a pure read (`read_note`, replay-safe), a slow
 * replay-safe lookup, and a payment (`charge_card`, not replay-safe) whose effect is a line in a
 * counter file, standing in for shell, computer_act, browser, mail and payments.
 */
export function spikeRegistry(options: SpikeToolOptions): Registry {
  const { workdir } = options;
  const hang = new Set(options.hang ?? []);
  const started = (tool: string) => options.onEvent?.({ event: "tool-start", tool });
  const maybeHang = async (tool: string, context: Context) => {
    if (!hang.has(tool)) return;
    hang.delete(tool);
    options.onEvent?.({ event: "tool-hang", tool });
    await hangUntil(options.release, context);
  };
  const readNote = defineTool({
    name: "read_note",
    description: "Read the saved note",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, _api, context) => {
      started("read_note");
      appendFileSync(workdir.reads, "read_note\n");
      await maybeHang("read_note", context);
      return { output: [{ type: "text", text: readFileSync(workdir.note, "utf8") }] };
    },
  });
  const slowLookup = defineTool({
    name: "slow_lookup",
    description: "Look up an order's status",
    parameters: obj({ order: str() }),
    replay: "safe",
    execute: async (args, _api, context) => {
      started("slow_lookup");
      appendFileSync(workdir.reads, `slow_lookup ${args.order}\n`);
      await maybeHang("slow_lookup", context);
      return { output: [{ type: "text", text: `order ${args.order}: shipped` }] };
    },
  });
  const chargeCard = defineTool({
    name: "charge_card",
    description: "Charge the customer's card",
    parameters: obj({ cents: num() }),
    // The default, spelled out: Superbot's side-effecting tools must never rerun silently.
    replay: "unsafe",
    execute: async (args, _api, context) => {
      started("charge_card");
      appendFileSync(workdir.effects, `charged ${args.cents}\n`);
      await maybeHang("charge_card", context);
      return { output: [{ type: "text", text: `charged ${args.cents} cents` }] };
    },
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "spike-tools", tools: [readNote, slowLookup, chargeCard] }),
  );
  if (options.guardInterrupted) {
    registry.install(
      defineExtension({
        name: "spike-interrupted-guard",
        hooks: [
          hook(ToolTask, {
            afterTool: (call, result) => {
              if (!result.diagnostics?.some((item) => item.code === "interrupted"))
                return undefined;
              options.onEvent?.({ event: "interrupted", tool: call.name });
              return {
                ...result,
                output: [
                  {
                    type: "text",
                    text: `${call.name} was cut off by a restart and may already have happened. Do not retry it; ask the person.`,
                  },
                ],
              };
            },
          }),
        ],
      }),
    );
  }
  return registry;
}

/** What the child process opens and runs; the same config starts or resumes the run. */
export interface SpikeChildConfig {
  storagePath: string;
  workdir: string;
  endpoints: SpikeEndpoint[];
  /** The model the root conversation is created with. */
  model: { provider: string; modelId: string };
  prompt: string;
  requestId: string;
  hang?: string[];
  guardInterrupted?: boolean;
}

export const SPIKE_EVENT_PREFIX = "SPIKE_EVENT ";

/** A transcript line with only what the spike asserts on. */
export interface TranscriptLine {
  role: string;
  text?: string;
  toolName?: string;
  toolCalls?: string[];
  isError?: boolean;
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text")
    .map((part) => part.text)
    .join("");
  return text || undefined;
}

export function summarizeTranscript(messages: readonly Message[]): TranscriptLine[] {
  return messages.map((message) => {
    const line: TranscriptLine = { role: message.role };
    const text = messageText(message.content);
    if (text !== undefined) line.text = text;
    if (message.role === "assistant") {
      const calls = message.content
        .filter((part) => part.type === "toolCall")
        .map((part) => (part as { name: string }).name);
      if (calls.length) line.toolCalls = calls;
    }
    if (message.role === "toolResult") {
      line.toolName = message.toolName;
      line.isError = message.isError;
    }
    return line;
  });
}

/**
 * Storage that a test can "crash": after `crash()`, every write fails, which ends the Harness
 * on it the way a dead process would (nothing more is stored, running tasks are aborted), while
 * the store underneath keeps what was committed, for a new Harness to open.
 */
export function crashableStorage(inner: Storage): { storage: Storage; crash(): void } {
  let crashed = false;
  const storage = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "close") return async () => undefined;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "commit" || property === "mintId") {
        return (...args: unknown[]) => {
          if (crashed) return Promise.reject(new Error("spike: process crashed"));
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  return {
    storage,
    crash() {
      crashed = true;
    },
  };
}
