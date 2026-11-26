import { randomUUID } from "node:crypto";
import type { AgentRunModel, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MediaAnalyzer } from "./media-analysis.js";
import { MEDIA_ANALYSIS_MAX_TOKENS } from "./media-analysis.js";
import { mediaAnalysisInstructions, mediaAnalysisPrompt } from "./media-analysis.prompt.js";

/** Text the runtime writes in place of an answer when the model call failed. */
const FAILED_REPLY = /^(?:I hit a problem:|Unknown model )/i;

/**
 * Reads images with a model the run already reaches: one call through the agent runtime with no
 * tools and no history, on the same connection, credentials and billing as the run's own calls,
 * and with usage recorded by `onUsage` like theirs. The runtime sends images only, so this never
 * reads video.
 */
export function runtimeImageAnalyzer(options: {
  runtime: AgentRuntime;
  /** A model whose catalog entry or connection declares image input. */
  model: AgentRunModel;
  run: { id: string; spaceId: string; userId: string; botId: string; threadId: string };
  secrets: readonly string[];
  onUsage: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => Promise<unknown>;
}): MediaAnalyzer {
  const { runtime, model, run, secrets, onUsage } = options;
  return {
    async analyze(input, signal) {
      if (input.modality !== "image") throw new Error("This model reads images only");
      const runId = `${run.id}:media-analysis:${randomUUID()}`;
      let text = "";
      for await (const event of runtime.run(
        {
          botId: run.botId,
          threadId: run.threadId,
          runId,
          usageOperationKind: "answer",
          onUsage: async (event) => {
            await onUsage(event);
          },
          prompt: mediaAnalysisPrompt(input.question),
          instructions: mediaAnalysisInstructions("image"),
          history: [],
          tools: [],
          currentTurnImages: [{ name: input.name, mimeType: input.mimeType, data: input.data }],
          currentRunRequiresImageInput: true,
          secrets,
          model: {
            ...model,
            maxTokens: Math.min(
              model.maxTokens ?? MEDIA_ANALYSIS_MAX_TOKENS,
              MEDIA_ANALYSIS_MAX_TOKENS,
            ),
          },
        },
        {
          operationId: runId,
          traceId: run.id,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: run.botId,
          runId: run.id,
          signal,
        },
      )) {
        if (event.type === "usage" && !event.accounted) await onUsage(event);
        if (event.type === "text" && FAILED_REPLY.test(event.text.trim()))
          throw new Error("Model call failed");
        if (event.type === "done") text = event.text ?? "";
      }
      if (FAILED_REPLY.test(text.trim())) throw new Error("Model call failed");
      return text;
    },
  };
}
