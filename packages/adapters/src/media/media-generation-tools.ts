import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaImageEditInput,
  MediaVideoInput,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import type { GeneratedMediaInfo, MessageBlock } from "@rakazo/contracts";
import { messageBlockForArtifact } from "@rakazo/core";
import type { ExternalEffect, Prisma, PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { z } from "zod";
import type { MediaToolName } from "./media-generation.tool-definition.js";
import { MediaInputError } from "./media-generation-input.js";
import { mediaPromptSchema, validateGeneratedMedia } from "./media-provider-http.js";
import type { MediaRoute } from "./media-router.js";
import { MediaConnectionError, MediaRouteSchema, SERVER_MEDIA_ROUTE } from "./media-router.js";

export const MEDIA_JOB_KIND = "media_generation_job";
const FILE_EXTENSIONS: Record<GeneratedMedia["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
};
const savedJob = z.object({
  provider: z.string(),
  jobId: z.string().optional(),
  artifactId: z.string().optional(),
});
/** What a job's request keeps about the call; older jobs have no route and used the server's. */
const savedRequest = z.object({
  tool: z.string(),
  prompt: z.string(),
  route: MediaRouteSchema.optional(),
});

export type MediaSettled = "completed" | "failed";

/** A new call's provider, where it was routed and its checked input. Nothing is billed yet. */
export type PreparedMedia = {
  provider: MediaGenerationProvider;
  route: MediaRoute;
  input: MediaGenerationInput | MediaImageEditInput | MediaVideoInput;
};

/** How a call reaches its provider: chosen for a new call, rebuilt for a saved video job. */
export interface MediaToolRoute {
  prepare(): Promise<PreparedMedia>;
  /** Absent `route` is a job saved before per-user providers: the server's own provider. */
  reopen(route: MediaRoute | undefined): Promise<MediaGenerationProvider>;
}

/** What a generated image or video's card shows, from the job's saved request. */
export function generatedMediaInfo(request: unknown): GeneratedMediaInfo | undefined {
  const saved = savedRequest.safeParse(request);
  if (!saved.success) return undefined;
  const { tool, prompt, route } = saved.data;
  return {
    kind: tool === "generate_video" ? "video" : "image",
    ...(tool === "edit_image" ? { edit: true as const } : {}),
    prompt: prompt.slice(0, 4000),
    provider: (route ?? SERVER_MEDIA_ROUTE).provider,
    providerName: (route ?? SERVER_MEDIA_ROUTE).providerName,
    ...(route?.model ? { model: route.model } : {}),
  };
}

export function savedMediaRoute(request: unknown): MediaRoute | undefined {
  const saved = savedRequest.safeParse(request);
  return saved.success ? saved.data.route : undefined;
}

function withGenerated(
  block: Extract<MessageBlock, { kind: "image" | "file" }>,
  generated: GeneratedMediaInfo | undefined,
) {
  return generated ? { ...block, generated } : block;
}

export async function generateMediaFromTool(options: {
  name: MediaToolName;
  args: Record<string, unknown>;
  executionId: string;
  /** Recover only persisted state; never submit a new billed generation. */
  recoverOnly?: boolean;
  route: MediaToolRoute;
  prisma: PrismaClient;
  context: AdapterContext;
  run: { id: string; threadId: string; botId: string; userId: string; spaceId: string };
  /** Saved with a new job so background delivery skips a chat that was cleared since. */
  threadGeneration?: number;
  attach: (
    output: GeneratedMedia,
    name: string,
    job: { id: string; result: { provider: string; jobId?: string } },
  ) => Promise<{ artifactId: string; block: Extract<MessageBlock, { kind: "image" | "file" }> }>;
  publish: (
    block: MessageBlock,
    jobId: string,
    artifactId: string,
    providerId: string,
  ) => Promise<unknown>;
  /** Posts the pending card of a video the provider accepted. */
  announce?: (jobId: string, media: GeneratedMediaInfo) => Promise<void>;
  /** Commits with a video's provider failure, so whatever follows it cannot be lost. */
  onSettled?: (tx: Prisma.TransactionClient, status: "failed", jobId: string) => Promise<void>;
  /** Runs after a failure committed, to signal what onSettled changed. */
  afterSettled?: () => Promise<void>;
}) {
  const { prisma, context, run, args } = options;
  const video = options.name === "generate_video";
  try {
    if (
      args.jobId !== undefined &&
      (!video ||
        typeof args.jobId !== "string" ||
        !args.jobId ||
        args.jobId.length > 200 ||
        args.prompt !== undefined)
    ) {
      return { error: "Use a prompt to submit or jobId alone to poll a video." };
    }
    let reservation: ExternalEffect | null = null;
    let polling = false;
    let prepared: PreparedMedia | undefined;
    if (video && typeof args.jobId === "string") {
      reservation = await prisma.externalEffect.findFirst({
        where: {
          id: args.jobId,
          kind: MEDIA_JOB_KIND,
          spaceId: run.spaceId,
          run: { userId: run.userId, botId: run.botId, threadId: run.threadId },
        },
      });
      if (!reservation) return { error: "Video job is unavailable." };
      const saved = savedJob.safeParse(reservation.result);
      if (!saved.success)
        return { error: "Video job submission is uncertain. Do not resubmit automatically." };
      if (saved.data.artifactId && reservation.status === "media_completed")
        return { status: "completed", artifactId: saved.data.artifactId };
      if (reservation.status === "media_failed") return { status: "failed" };
      if (!saved.data.jobId && !saved.data.artifactId)
        return { error: "Submission is uncertain. Do not resubmit automatically." };
    } else {
      const prior = await prisma.externalEffect.findFirst({
        where: {
          runId: run.id,
          kind: MEDIA_JOB_KIND,
          request: { path: ["executionId"], equals: options.executionId },
        },
      });
      if (prior) {
        const saved = savedJob.safeParse(prior.result);
        if (saved.success && saved.data.artifactId) {
          if (prior.status === "media_completed")
            return { status: "completed", artifactId: saved.data.artifactId };
          reservation = prior;
        } else {
          if (video && saved.success && saved.data.jobId)
            return {
              jobId: prior.id,
              status: prior.status === "media_failed" ? "failed" : "queued",
            };
          if (options.recoverOnly) return undefined;
          return {
            jobId: prior.id,
            error: "Submission already attempted. Poll a video job; do not resubmit automatically.",
          };
        }
      }
      if (!reservation) {
        if (options.recoverOnly) return undefined;
        const input = mediaPromptSchema.safeParse(args);
        if (!input.success) return { error: "A prompt of 1–4000 characters is required." };
        // Routed and checked before a slot is taken, so a refused option costs no submission.
        prepared = await options.route.prepare();
        // A unique slot makes the per-run cap durable even across concurrent calls/restarts.
        for (let slot = 0; slot < 2; slot++) {
          try {
            reservation = await prisma.externalEffect.create({
              data: {
                spaceId: run.spaceId,
                runId: run.id,
                kind: MEDIA_JOB_KIND,
                idempotencyKey: `media:${run.id}:${slot}`,
                status: "media_submitting",
                request: {
                  tool: options.name,
                  prompt: input.data.prompt,
                  executionId: options.executionId,
                  route: prepared.route,
                  ...(options.threadGeneration === undefined
                    ? {}
                    : { threadGeneration: options.threadGeneration }),
                },
                result: { provider: prepared.provider.id },
              },
            });
            break;
          } catch (error) {
            if (!isUniqueViolation(error)) throw error;
          }
        }
        if (!reservation)
          return { error: "Media generation limit reached (two submissions per run)." };
      }
    }
    const saved = savedJob.parse(reservation.result);
    const generated = generatedMediaInfo(reservation.request);
    if (saved.artifactId) {
      const artifact = await prisma.artifact.findFirst({
        where: { id: saved.artifactId, spaceId: run.spaceId, userId: run.userId, botId: run.botId },
      });
      if (!artifact) return { error: "Generated attachment is unavailable." };
      await options.publish(
        withGenerated(messageBlockForArtifact(artifact), generated),
        reservation.id,
        artifact.id,
        saved.provider,
      );
      return { status: "completed", artifactId: artifact.id };
    }
    if (video && typeof args.jobId === "string") {
      const claim = await prisma.externalEffect.updateMany({
        where: {
          id: reservation.id,
          OR: [
            { status: "media_pending" },
            { status: "media_polling", updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
          ],
        },
        data: { status: "media_polling" },
      });
      if (!claim.count)
        return options.recoverOnly
          ? { jobId: reservation.id, status: "running" }
          : {
              error:
                "Video job is already being checked or needs recovery. Do not resubmit automatically.",
            };
      polling = true;
    }
    const job = reservation;
    let provider: MediaGenerationProvider;
    try {
      provider = prepared?.provider ?? (await options.route.reopen(savedMediaRoute(job.request)));
    } catch (error) {
      if (!(error instanceof MediaConnectionError) || !polling) throw error;
      // The credential the job was submitted with is gone: the video can never be fetched.
      const failed = await prisma.$transaction(async (tx) => {
        const updated = await tx.externalEffect.updateMany({
          where: { id: job.id, status: "media_polling" },
          data: { status: "media_failed" },
        });
        if (updated.count) await options.onSettled?.(tx, "failed", job.id);
        return updated.count > 0;
      });
      if (failed) await options.afterSettled?.();
      return { jobId: job.id, status: "failed", error: error.message };
    }
    if (polling && provider.id !== saved.provider) {
      await prisma.externalEffect.updateMany({
        where: { id: job.id, status: "media_polling" },
        data: { status: "media_pending" },
      });
      return {
        error:
          "Video job provider changed or submission is uncertain. Do not resubmit automatically.",
      };
    }
    let output: MediaVideoJob | { status: "completed"; output: GeneratedMedia };
    try {
      if (video) {
        output = saved.jobId
          ? await provider.pollVideo(saved.jobId, context)
          : await provider.generateVideo(prepared!.input as MediaVideoInput, context);
      } else if (options.name === "edit_image") {
        if (!provider.editImage) throw new MediaGenerationError("unsupported");
        output = {
          status: "completed",
          output: await provider.editImage(prepared!.input as MediaImageEditInput, context),
        };
      } else {
        output = {
          status: "completed",
          output: await provider.generateImage(prepared!.input, context),
        };
      }
    } catch (error) {
      // Release only this check's claim; a finished or failed job stays settled.
      if (polling)
        await prisma.externalEffect.updateMany({
          where: { id: job.id, status: "media_polling" },
          data: { status: "media_pending" },
        });
      throw error;
    }
    if (video && "id" in output) {
      const settle = async (tx: Prisma.TransactionClient) => {
        const updated = await tx.externalEffect.updateMany({
          where: {
            id: job.id,
            status: polling ? "media_polling" : "media_submitting",
            result: { equals: saved },
          },
          data: {
            status:
              output.status === "failed"
                ? "media_failed"
                : output.status === "completed"
                  ? "media_polling"
                  : "media_pending",
            result: { provider: provider.id, jobId: output.id },
          },
        });
        if (updated.count && output.status === "failed")
          await options.onSettled?.(tx, "failed", job.id);
        return updated.count > 0;
      };
      if (output.status === "failed" && options.onSettled) {
        if (await prisma.$transaction(settle)) await options.afterSettled?.();
      } else {
        const accepted = await settle(prisma);
        // The card shows from submission; a check of a running job leaves it as it is.
        if (accepted && !polling && output.status !== "failed" && generated && options.announce)
          await bestEffort("post a video's pending card", options.announce(job.id, generated));
      }
    }
    if (output.status !== "completed")
      return {
        jobId: job.id,
        status: output.status,
        ...("progress" in output ? { progress: output.progress } : {}),
      };
    const fetched = {
      provider: provider.id,
      ...("id" in output ? { jobId: output.id } : {}),
    };
    let attached: { artifactId: string; block: Extract<MessageBlock, { kind: "image" | "file" }> };
    try {
      validateGeneratedMedia(output.output, video ? "video" : "image");
      context.signal.throwIfAborted();
      attached = await options.attach(
        output.output,
        `generated-${job.id}.${FILE_EXTENSIONS[output.output.mimeType]}`,
        { id: job.id, result: fetched },
      );
    } catch (error) {
      // A finished video that could not be stored releases its claim, so a later check retries
      // it and the deadline can still report it failed.
      if (video && "id" in output)
        await prisma.externalEffect.updateMany({
          where: { id: job.id, status: "media_polling", result: { equals: fetched } },
          data: { status: "media_pending" },
        });
      throw error;
    }
    await options.publish(
      withGenerated(attached.block, generated),
      job.id,
      attached.artifactId,
      provider.id,
    );
    return { status: "completed", artifactId: attached.artifactId };
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof MediaConnectionError || error instanceof MediaInputError)
      return { error: error.message };
    return {
      error:
        error instanceof MediaGenerationError
          ? error.message
          : "Media generation failed. Submission may have been accepted; do not retry automatically.",
    };
  }
}
