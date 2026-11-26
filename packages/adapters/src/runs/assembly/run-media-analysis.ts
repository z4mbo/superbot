import { recordUsage } from "@rakazo/db";
import { resolveComputerRunModel } from "../../computers/computer-model-settings.js";
import type { MediaAnalyzers } from "../../media/understanding/media-analysis.js";
import { runtimeImageAnalyzer } from "../../media/understanding/runtime-media-analyzer.js";
import { findConnectedModelCredential } from "../../models/model-selection.js";
import type { RunHold } from "../lifecycle/run-attempt.js";
import type {
  PreparedRunComputer,
  RunCapabilities,
  StartedTurnModel,
} from "./run-assembly-capabilities.js";
import type { RunRecords, SavedTurn } from "./run-assembly-records.js";

/** Which understanding tools a run is offered: only those a connected model can serve. */
export type MediaUnderstanding = {
  imageUnderstandingAvailable: boolean;
  videoUnderstandingAvailable: boolean;
};

/**
 * The models this run may hand an image or video to, chosen by the input each declares. The
 * run's own model reads images when its catalog entry or connection says it can; otherwise the
 * owner's computer-use model, which must see images to be chosen at all. No model the run can
 * reach reads video yet, so video analysis is never offered by this run setup.
 */
export async function runMediaAnalysis(
  hold: RunHold,
  parts: {
    saved: SavedTurn;
    records: RunRecords;
    model: StartedTurnModel;
    computer: PreparedRunComputer;
    capabilities: RunCapabilities;
  },
): Promise<{ analyzers: MediaAnalyzers; available: MediaUnderstanding }> {
  const { deps, run, runId, secrets } = hold;
  const { mainRunModel, computerModel } = parts.capabilities;
  const scripted = parts.model.scripted || deps.runtime.describe().capabilities.scripted;
  const imageModel = scripted
    ? undefined
    : parts.computer.modelSeesImages
      ? mainRunModel
      : (computerModel ??
        (parts.computer.graphical
          ? undefined
          : await resolveComputerRunModel(
              {
                prisma: deps.prisma,
                resolve: parts.saved.resolveCheckpointModel,
                connectionFor: async (provider, modelId) =>
                  (
                    await findConnectedModelCredential(
                      deps.prisma,
                      deps.secretStore,
                      run,
                      provider,
                      modelId,
                    )
                  )?.id,
              },
              { userId: run.userId, spaceId: run.spaceId },
              mainRunModel,
            )));
  const analyzers: MediaAnalyzers = imageModel
    ? {
        image: runtimeImageAnalyzer({
          runtime: deps.runtime,
          model: imageModel,
          run: {
            id: runId,
            spaceId: run.spaceId,
            userId: run.userId,
            botId: parts.records.bot.id,
            threadId: parts.records.thread.id,
          },
          secrets,
          // The same attribution as the run's own model calls.
          onUsage: (event) =>
            recordUsage(deps.prisma, event, {
              spaceId: run.spaceId,
              botId: parts.records.bot.id,
              userId: run.userId,
              runId,
              parentRunId: runId,
              operationId: runId,
            }),
        }),
      }
    : {};
  return {
    analyzers,
    available: {
      imageUnderstandingAvailable: Boolean(analyzers.image),
      videoUnderstandingAvailable: Boolean(analyzers.video),
    },
  };
}
