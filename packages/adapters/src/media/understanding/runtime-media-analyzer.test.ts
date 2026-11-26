import type {
  AgentRunModel,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MEDIA_ANALYSIS_MAX_TOKENS } from "./media-analysis.js";
import { runtimeImageAnalyzer } from "./runtime-media-analyzer.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RUN = { id: "run-1", spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "t-1" };
const MODEL: AgentRunModel = { provider: "provider-a", id: "vision-1", connectionId: "conn-1" };

function fakeRuntime(events: AgentRuntimeEvent[]) {
  const requests: AgentRunRequest[] = [];
  const runtime = {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    }),
    abort: async () => undefined,
    async *run(request: AgentRunRequest) {
      requests.push(request);
      yield* events;
    },
  } satisfies AgentRuntime;
  return { runtime, requests };
}

const usage = (accounted: boolean): AgentRuntimeEvent => ({
  type: "usage",
  accounted,
  provider: "provider-a",
  model: "vision-1",
  inputTokens: 10,
  outputTokens: 5,
});

describe("runtimeImageAnalyzer", () => {
  it("sends one image, no tools or history, on the run's connection with capped output", async () => {
    const { runtime, requests } = fakeRuntime([
      usage(false),
      usage(true),
      { type: "done", text: "A cat." },
    ]);
    const onUsage = vi.fn(async () => undefined);
    const analyzer = runtimeImageAnalyzer({
      runtime,
      model: { ...MODEL, maxTokens: 64_000 },
      run: RUN,
      secrets: ["s3cret"],
      onUsage,
    });
    const text = await analyzer.analyze(
      { modality: "image", mimeType: "image/png", name: "cat.png", data: PNG, question: "Breed?" },
      new AbortController().signal,
    );
    expect(text).toBe("A cat.");
    const [request] = requests;
    expect(request).toMatchObject({
      tools: [],
      history: [],
      currentTurnImages: [{ name: "cat.png", mimeType: "image/png", data: PNG }],
      secrets: ["s3cret"],
      model: { provider: "provider-a", id: "vision-1", connectionId: "conn-1" },
    });
    expect(request?.model.maxTokens).toBe(MEDIA_ANALYSIS_MAX_TOKENS);
    expect(request?.prompt).toContain("<question>Breed?</question>");
    expect(request?.runId).toMatch(/^run-1:media-analysis:/);
    // Usage the runtime did not record itself is recorded once, like the run's own calls.
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("throws when the runtime reports a failed model call instead of an answer", async () => {
    const { runtime } = fakeRuntime([{ type: "done", text: "I hit a problem: 401 bad key" }]);
    const analyzer = runtimeImageAnalyzer({
      runtime,
      model: MODEL,
      run: RUN,
      secrets: [],
      onUsage: async () => undefined,
    });
    await expect(
      analyzer.analyze(
        { modality: "image", mimeType: "image/png", name: "a.png", data: PNG },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Model call failed");
  });

  it("never sends video", async () => {
    const { runtime, requests } = fakeRuntime([{ type: "done", text: "?" }]);
    const analyzer = runtimeImageAnalyzer({
      runtime,
      model: MODEL,
      run: RUN,
      secrets: [],
      onUsage: async () => undefined,
    });
    await expect(
      analyzer.analyze(
        { modality: "video", mimeType: "video/mp4", name: "a.mp4", data: PNG },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
