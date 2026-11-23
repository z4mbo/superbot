import { randomUUID } from "node:crypto";
import type {
  AgentRunModel,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import * as Core from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEmulatorRequest } from "../model-emulator.js";
import { startModelEmulator } from "../model-emulator.js";

/**
 * The model a picker saves reaches the provider unchanged: these cases hold any AgentRuntime to
 * the model, thinking level and credential its request names. Point this at another runtime to
 * check it against the same contract.
 */
const createRuntime = (): AgentRuntime => new PiAgentRuntime();

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** The chat completions field a standard thinking level travels in. */
type WireRequest = ModelEmulatorRequest & { reasoning_effort?: string };

type Emulator = Awaited<ReturnType<typeof startModelEmulator>>;

async function endpoint(options: Parameters<typeof startModelEmulator>[0]): Promise<Emulator> {
  const server = await startModelEmulator(options);
  cleanups.push(() => server.close());
  return server;
}

function replyStep(text: string, seen?: WireRequest[]) {
  return {
    expect(request: ModelEmulatorRequest) {
      seen?.push(request as WireRequest);
    },
    response: { type: "text" as const, text },
  };
}

function request(model: AgentRunModel, overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: randomUUID(),
    prompt: "Say hello.",
    instructions: "Answer briefly.",
    history: [],
    tools: [],
    model,
    ...overrides,
  };
}

async function run(input: AgentRunRequest, server: Emulator) {
  const events: AgentRuntimeEvent[] = [];
  try {
    for await (const event of createRuntime().run(input)) events.push(event);
  } catch (error) {
    server.assertComplete();
    throw error;
  }
  server.assertComplete();
  return events;
}

describe("a run's model reaches the provider as its request names it", () => {
  it("calls the requested model with the requested key", async () => {
    const server = await endpoint({
      modelId: "fixture-picked-model",
      apiKey: "fixture-picked-key",
      steps: [replyStep("Hello.")],
    });

    const events = await run(request({ ...server.model, thinkingLevel: null }), server);

    expect(server.requests.map((sent) => sent.model)).toEqual(["fixture-picked-model"]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Hello." });
  });

  it.each(["minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "sends thinking level %s to a model that thinks",
    async (thinkingLevel) => {
      const seen: WireRequest[] = [];
      const server = await endpoint({ steps: [replyStep("Hello.", seen)] });

      await run(request({ ...server.model, reasoning: true, thinkingLevel }), server);

      expect(seen.map((sent) => sent.reasoning_effort)).toEqual([thinkingLevel]);
    },
  );

  it("starts a thinking model on medium when no level was picked", async () => {
    const seen: WireRequest[] = [];
    const server = await endpoint({ steps: [replyStep("Hello.", seen)] });

    await run(request({ ...server.model, reasoning: true, thinkingLevel: null }), server);

    expect(seen.map((sent) => sent.reasoning_effort)).toEqual(["medium"]);
  });

  it("turns thinking off when off was picked", async () => {
    const seen: WireRequest[] = [];
    const server = await endpoint({ steps: [replyStep("Hello.", seen)] });

    await run(request({ ...server.model, reasoning: true, thinkingLevel: "off" }), server);

    expect(seen.map((sent) => sent.reasoning_effort)).toEqual(["none"]);
  });

  it("sends no thinking level to a model that does not think, whatever was picked", async () => {
    const seen: WireRequest[] = [];
    const server = await endpoint({ steps: [replyStep("Hello.", seen)] });

    await run(request({ ...server.model, reasoning: false, thinkingLevel: "high" }), server);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("reasoning_effort");
  });

  it("keeps the run's model and thinking level for messages that arrive mid-run", async () => {
    const seen: WireRequest[] = [];
    const server = await endpoint({
      modelId: "fixture-steered-model",
      steps: [
        {
          expect(sent) {
            seen.push(sent as WireRequest);
          },
          response: { type: "tool", id: "steer-lookup", name: "lookup", arguments: {} },
        },
        {
          expect(sent) {
            seen.push(sent as WireRequest);
            expect(JSON.stringify(sent.messages)).toContain("Also say goodbye.");
          },
          response: { type: "text", text: "Hello and goodbye." },
        },
      ],
    });
    let claims = 0;
    const claimSteering = vi.fn(async () =>
      // The first claim is the run's opening one; the message lands after the first step.
      ++claims === 2
        ? [
            {
              id: "steer-1",
              messageId: "steer-message-1",
              text: "Also say goodbye.",
              origin: "user" as const,
            },
          ]
        : [],
    );

    const events = await run(
      request(
        { ...server.model, reasoning: true, thinkingLevel: "high" },
        {
          tools: [
            {
              name: "lookup",
              description: "Look something up",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
          executeTool: vi.fn(async () => ({ ok: true })),
          claimSteering,
        },
      ),
      server,
    );

    expect(seen.map((sent) => [sent.model, sent.reasoning_effort])).toEqual([
      ["fixture-steered-model", "high"],
      ["fixture-steered-model", "high"],
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Hello and goodbye." });
  });

  it("moves to a picked backup with its own thinking level and reports the change", async () => {
    const delay = vi.spyOn(Core, "abortableDelay").mockResolvedValue(undefined);
    try {
      const primary = await endpoint({
        modelId: "fixture-primary-model",
        apiKey: "fixture-primary-key",
        steps: [
          {
            expect() {},
            response: {
              type: "error",
              status: 402,
              message: "Insufficient Balance",
            },
          },
        ],
      });
      const seen: WireRequest[] = [];
      const backup = await endpoint({
        modelId: "fixture-backup-model",
        apiKey: "fixture-backup-key",
        steps: [replyStep("Hello from the backup.", seen)],
      });
      const backupModel: AgentRunModel = { ...backup.model, reasoning: true, thinkingLevel: "low" };
      const resolveFallbackModel = vi.fn(async () => backupModel);
      const onModelChange = vi.fn(async () => undefined);

      const events = await run(
        request(
          { ...primary.model, reasoning: true, thinkingLevel: "high" },
          {
            fallbackModels: [
              { provider: backup.model.provider, id: backup.model.id, connectionId: "backup-conn" },
            ],
            resolveFallbackModel,
            onModelChange,
          },
        ),
        primary,
      );
      backup.assertComplete();

      expect(primary.requests.map((sent) => sent.model)).toEqual(["fixture-primary-model"]);
      expect(seen.map((sent) => [sent.model, sent.reasoning_effort])).toEqual([
        ["fixture-backup-model", "low"],
      ]);
      expect(resolveFallbackModel).toHaveBeenCalledWith(
        backup.model.provider,
        "fixture-backup-model",
        "backup-conn",
      );
      expect(onModelChange).toHaveBeenCalledWith(backup.model.provider, "fixture-backup-model");
      expect(events.at(-1)).toEqual({ type: "done", text: "Hello from the backup." });
    } finally {
      delay.mockRestore();
    }
  });
});
