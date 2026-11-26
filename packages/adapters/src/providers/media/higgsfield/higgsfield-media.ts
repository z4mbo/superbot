import { createHash } from "node:crypto";
import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaVideoInput,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import { z } from "zod";
import type {
  MediaModelDescriptor,
  MediaProviderDefinition,
} from "../../../media/media-provider-descriptor.js";
import type { MediaHttpOptions } from "../../../media/media-provider-http.js";
import {
  decodeMediaJob,
  downloadMediaOutput,
  encodeMediaJob,
  MEDIA_IMAGE_DEADLINE_MS,
  mediaFailure,
  mediaRequestJson,
  parseMediaResponse,
  waitForMediaJob,
} from "../../../media/media-provider-http.js";
import {
  checkMediaInput,
  mediaCredentialSecret,
  nearestAspectRatio,
  nearestDuration,
  nearestResolution,
  resolveMediaModel,
  sizeResolution,
} from "../../../media/media-provider-input.js";

const API = "https://api.higgsfield.ai";

// Image inputs reach Higgsfield only through its presigned upload flow, which is not built here,
// so no listed model takes a reference image or a frame.
const MODELS: readonly MediaModelDescriptor[] = [
  {
    id: "higgsfield-ai/soul/v2/standard",
    name: "Soul 2",
    kind: "image",
    default: true,
    aspectRatios: ["9:16", "16:9", "4:3", "3:4", "1:1", "2:3", "3:2"],
    resolutions: ["720p", "1080p"],
  },
  {
    id: "kling-video/v2.5-turbo/pro/text-to-video",
    name: "Kling 2.5 Turbo Pro",
    kind: "video",
    default: true,
    durationSeconds: { min: 5, max: 10 },
  },
];

const submitted = z.object({ request_id: z.string().regex(/^[\w-]{1,200}$/) });
const requestStatus = z.object({
  status: z.enum(["queued", "in_progress", "completed", "failed", "nsfw", "canceled"]),
  images: z.array(z.object({ url: z.string().min(1) })).nullish(),
  video: z.object({ url: z.string().min(1) }).nullish(),
});
const savedJob = z.object({ request: z.string().regex(/^[\w-]{1,200}$/) });

/**
 * The same generation asked again within one operation is answered with the first request and
 * not billed twice; any other generation gets its own key.
 */
function idempotencyKey(
  context: AdapterContext,
  model: MediaModelDescriptor,
  body: Record<string, unknown>,
) {
  return createHash("sha256")
    .update(JSON.stringify([context.operationId, model.id, body]))
    .digest("hex");
}

/** Higgsfield's platform API: submit to a model endpoint, then poll the request's status. */
export class HiggsfieldMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "higgsfield";
  readonly capabilities = { images: true, video: true, offline: false };
  constructor(
    private readonly key: { id: string; secret: string },
    private readonly http: MediaHttpOptions = {},
  ) {}

  private headers() {
    return { Authorization: `Key ${this.key.id}:${this.key.secret}` };
  }

  private async submit(
    model: MediaModelDescriptor,
    body: Record<string, unknown>,
    context: AdapterContext,
  ) {
    const result = parseMediaResponse(
      submitted,
      await mediaRequestJson(
        `${API}/${model.id}`,
        {
          headers: { ...this.headers(), "Idempotency-Key": idempotencyKey(context, model, body) },
          json: body,
        },
        this.http,
        context,
      ),
    );
    return result.request_id;
  }

  private async status(request: string, context: AdapterContext) {
    return parseMediaResponse(
      requestStatus,
      await mediaRequestJson(
        `${API}/requests/${encodeURIComponent(request)}/status`,
        { headers: this.headers() },
        this.http,
        context,
      ),
    );
  }

  async generateImage(
    input: MediaGenerationInput,
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const model = resolveMediaModel(MODELS, "image", input.model);
    const prompt = checkMediaInput(model, input, "image");
    const aspectRatio = nearestAspectRatio(input, model.aspectRatios ?? []);
    const resolution = nearestResolution(sizeResolution(input.size, "p"), model.resolutions ?? []);
    const signal = deadlineSignal(MEDIA_IMAGE_DEADLINE_MS, context.signal);
    const deadline = { ...context, signal };
    try {
      const request = await this.submit(
        model,
        {
          prompt,
          batch_size: 1,
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          ...(resolution ? { resolution } : {}),
        },
        deadline,
      );
      const url = await waitForMediaJob(
        async () => {
          const status = await this.status(request, deadline);
          if (status.status === "nsfw") throw new MediaGenerationError("content_policy");
          if (status.status === "failed" || status.status === "canceled")
            throw new MediaGenerationError("provider_failure");
          if (status.status !== "completed") return undefined;
          const found = status.images?.[0]?.url;
          if (!found) throw new MediaGenerationError("provider_failure");
          return found;
        },
        signal,
        context,
      );
      return await downloadMediaOutput(url, "image", this.http, context, signal);
    } catch (error) {
      throw mediaFailure(error, context);
    }
  }

  async generateVideo(input: MediaVideoInput, context: AdapterContext): Promise<MediaVideoJob> {
    const model = resolveMediaModel(MODELS, "video", input.model);
    const prompt = checkMediaInput(model, input, "video");
    const duration = nearestDuration(input.durationSeconds, [5, 10]);
    const request = await this.submit(
      model,
      { prompt, ...(duration ? { duration } : {}) },
      context,
    );
    return { id: encodeMediaJob({ request }), status: "queued" };
  }

  async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    const job = decodeMediaJob(savedJob, id);
    const status = await this.status(job.request, context);
    switch (status.status) {
      case "queued":
        return { id, status: "queued" };
      case "in_progress":
        return { id, status: "running" };
      case "nsfw":
        return { id, status: "failed", code: "content_policy" };
      case "failed":
      case "canceled":
        return { id, status: "failed" };
      case "completed":
        if (!status.video?.url) throw new MediaGenerationError("provider_failure");
        return {
          id,
          status: "completed",
          output: await downloadMediaOutput(status.video.url, "video", this.http, context),
        };
    }
  }
}

export const higgsfieldMedia: MediaProviderDefinition = {
  catalog: {
    name: "Higgsfield",
    fields: [
      { name: "keyId", label: "API key ID", secret: false },
      { name: "keySecret", label: "API key secret", secret: true },
    ],
  },
  models: MODELS,
  create: (credential, options) =>
    new HiggsfieldMediaGenerationProvider(
      {
        id: mediaCredentialSecret(credential, "keyId"),
        secret: mediaCredentialSecret(credential, "keySecret"),
      },
      options,
    ),
};
