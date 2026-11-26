import { SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import { resolveBotWorkspacePath } from "../../computers/screens/computer-support.js";
import type {
  MediaModality,
  MediaSourceReaders,
} from "../../media/understanding/media-analysis.js";
import {
  analyzeMediaFromTool,
  fetchMediaUrl,
  MediaTooLargeError,
} from "../../media/understanding/media-analysis.js";
import type { RunContext } from "../assembly/run-context.js";
import { readStoppedRunFile } from "./run-stopped-file.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/**
 * Where a run's understanding tools read media from: its own workspace like read_file, an
 * attachment of a message in its own conversation, or a public https URL like web_fetch.
 */
export function runMediaReaders(ctx: RunContext, call: ToolCall): MediaSourceReaders {
  const { deps, run, bot, context } = ctx;
  return {
    async workspace(path, maxBytes) {
      const stored = resolveBotWorkspacePath(ctx.computer.mode, bot.id, path);
      try {
        return (
          (await readStoppedRunFile(ctx, stored, maxBytes)) ??
          (await deps.sandbox.readFile(await ctx.computer.get("tool", call.name), stored, context, {
            maxBytes,
          }))
        );
      } catch (error) {
        if (error instanceof SandboxFileTooLargeError) throw new MediaTooLargeError();
        throw error;
      }
    },
    async attachment(id, maxBytes) {
      if (!deps.artifacts) return undefined;
      const row = await deps.prisma.artifact.findFirst({
        where: { id, spaceId: run.spaceId },
        select: { name: true, size: true, storageKey: true },
      });
      // Only an image or file some message of this conversation carries, never any id in the
      // Space and never an artifact behind another kind of block.
      const shown =
        row &&
        (await deps.prisma.message.findFirst({
          where: {
            threadId: ctx.source.conversationThreadId ?? ctx.thread.id,
            OR: ["image", "file"].map((kind) => ({
              blocks: { array_contains: [{ kind, artifactId: id }] },
            })),
          },
          select: { id: true },
        }));
      if (!row || !shown) return undefined;
      if (row.size > maxBytes) throw new MediaTooLargeError();
      return { name: row.name, data: await deps.artifacts.get(row.storageKey, context) };
    },
    url: (url, maxBytes, signal) => fetchMediaUrl(url, maxBytes, signal),
  };
}

function analyze(modality: MediaModality) {
  return async (ctx: RunContext, call: ToolCall) =>
    call.finish(
      await analyzeMediaFromTool({
        modality,
        args: call.args,
        analyzer: ctx.providers.mediaAnalyzers[modality],
        readers: runMediaReaders(ctx, call),
        signal: ctx.context.signal,
        secrets: ctx.secrets,
      }),
    );
}

/** Image and video understanding with a connected model; text only, never the media itself. */
export const mediaUnderstandingTools: ToolHandlers = {
  vision_analyze: analyze("image"),
  video_analyze: analyze("video"),
};
