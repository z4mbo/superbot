import type { AgentRunModel, AgentRunRequest } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveComputerRunModel = vi.hoisted(() => vi.fn());
vi.mock("../../computers/computer-model-settings.js", () => ({ resolveComputerRunModel }));

const { runMediaAnalysis } = await import("./run-media-analysis.js");

const MAIN: AgentRunModel = { provider: "provider-a", id: "main", connectionId: "conn-a" };
const VISION: AgentRunModel = { provider: "provider-b", id: "eyes", connectionId: "conn-b" };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Parts = Parameters<typeof runMediaAnalysis>[1];

function setup(options: {
  modelSeesImages: boolean;
  computerModel?: AgentRunModel;
  graphical?: boolean;
  scripted?: boolean;
}) {
  const requests: AgentRunRequest[] = [];
  const runtime = {
    describe: () => ({ capabilities: { scripted: false } }),
    async *run(request: AgentRunRequest) {
      requests.push(request);
      yield { type: "done" as const, text: "described" };
    },
  };
  const hold = {
    deps: { runtime, prisma: {}, secretStore: {} },
    run: { userId: "user-1", spaceId: "space-1" },
    runId: "run-1",
    secrets: [],
  } as unknown as Parameters<typeof runMediaAnalysis>[0];
  const parts = {
    saved: { resolveCheckpointModel: vi.fn() },
    records: { bot: { id: "bot-1" }, thread: { id: "thread-1" } },
    model: { scripted: Boolean(options.scripted) },
    computer: { modelSeesImages: options.modelSeesImages, graphical: options.graphical ?? false },
    capabilities: { mainRunModel: MAIN, computerModel: options.computerModel },
  } as unknown as Parts;
  return { hold, parts, requests };
}

async function modelUsed(
  result: Awaited<ReturnType<typeof runMediaAnalysis>>,
  requests: AgentRunRequest[],
) {
  await result.analyzers.image?.analyze(
    { modality: "image", mimeType: "image/png", name: "a.png", data: PNG },
    new AbortController().signal,
  );
  return requests[0]?.model;
}

describe("runMediaAnalysis", () => {
  beforeEach(() => resolveComputerRunModel.mockReset());

  it("uses the run's own model when it reads images", async () => {
    const { hold, parts, requests } = setup({ modelSeesImages: true, computerModel: VISION });
    const result = await runMediaAnalysis(hold, parts);
    expect(result.available).toEqual({
      imageUnderstandingAvailable: true,
      videoUnderstandingAvailable: false,
    });
    expect(await modelUsed(result, requests)).toMatchObject(MAIN);
    expect(resolveComputerRunModel).not.toHaveBeenCalled();
  });

  it("uses the owner's computer-use model when the run's model cannot see", async () => {
    const { hold, parts, requests } = setup({ modelSeesImages: false, computerModel: VISION });
    const result = await runMediaAnalysis(hold, parts);
    expect(result.available.imageUnderstandingAvailable).toBe(true);
    expect(await modelUsed(result, requests)).toMatchObject(VISION);
  });

  it("looks up the computer-use model for a run without a screen", async () => {
    resolveComputerRunModel.mockResolvedValue(VISION);
    const { hold, parts, requests } = setup({ modelSeesImages: false });
    const result = await runMediaAnalysis(hold, parts);
    expect(resolveComputerRunModel).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "user-1", spaceId: "space-1" },
      MAIN,
    );
    expect(await modelUsed(result, requests)).toMatchObject(VISION);
  });

  it("offers nothing when no connected model reads images, and nothing is called", async () => {
    resolveComputerRunModel.mockResolvedValue(undefined);
    const { hold, parts, requests } = setup({ modelSeesImages: false });
    const result = await runMediaAnalysis(hold, parts);
    expect(result).toEqual({
      analyzers: {},
      available: { imageUnderstandingAvailable: false, videoUnderstandingAvailable: false },
    });
    expect(requests).toHaveLength(0);
  });

  it("offers nothing to a scripted run", async () => {
    const { hold, parts } = setup({ modelSeesImages: true, scripted: true });
    expect((await runMediaAnalysis(hold, parts)).analyzers).toEqual({});
  });
});
