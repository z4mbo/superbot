import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaImageEditInput,
  MediaInputImage,
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
  imageDataUrl,
  MEDIA_IMAGE_DEADLINE_MS,
  mediaFailure,
  mediaRequestJson,
  parseMediaResponse,
  waitForMediaJob,
} from "../../../media/media-provider-http.js";
import {
  checkMediaInput,
  clampDuration,
  mediaCredentialSecret,
  nearestAspectRatio,
  nearestResolution,
  resolveMediaModel,
  sizeResolution,
} from "../../../media/media-provider-input.js";

const QUEUE = "https://queue.fal.run";
const MODEL_ENDPOINT = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)+$/;

const MODELS: readonly MediaModelDescriptor[] = [
  {
    id: "google/nano-banana-2.1",
    name: "Nano Banana 2.1",
    kind: "image",
    default: true,
    edit: true,
    referenceImages: 13,
    aspectRatios: [
      "21:9",
      "16:9",
      "3:2",
      "4:3",
      "5:4",
      "1:1",
      "4:5",
      "3:4",
      "2:3",
      "9:16",
      "4:1",
      "1:4",
      "8:1",
      "1:8",
    ],
    // 4K is left out: a 4K PNG is past the attachment limit.
    resolutions: ["1K", "2K"],
  },
  {
    id: "bytedance/seedream/v5.5",
    name: "Seedream 5.5",
    kind: "image",
    edit: true,
    referenceImages: 9,
    aspectRatios: ["1:1", "4:3", "16:9", "3:4", "9:16"],
  },
  {
    id: "bytedance/seedance-2.5",
    name: "Seedance 2.5",
    kind: "video",
    default: true,
    startFrame: true,
    endFrame: true,
    audio: true,
    referenceImages: 30,
    durationSeconds: { min: 4, max: 30 },
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    // 4k is left out: a 4k video is far past the attachment limit.
    resolutions: ["480p", "720p", "1080p"],
  },
  {
    id: "fal-ai/kling-video/v3/pro",
    name: "Kling 3 Pro",
    kind: "video",
    startFrame: true,
    endFrame: true,
    audio: true,
    durationSeconds: { min: 3, max: 15 },
    aspectRatios: ["16:9", "9:16", "1:1"],
  },
];
const SEEDREAM_SIZES: Record<string, string> = {
  "1:1": "square_hd",
  "4:3": "landscape_4_3",
  "16:9": "landscape_16_9",
  "3:4": "portrait_4_3",
  "9:16": "portrait_16_9",
};

type Submission = { endpoint: string; body: Record<string, unknown> };
type Call = MediaGenerationInput &
  Partial<MediaImageEditInput> &
  Partial<MediaVideoInput> & { prompt: string };

const url = (image: MediaInputImage) => imageDataUrl(image);
const defined = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));

/** The endpoint and body for a listed model; each fal model names its fields its own way. */
function submission(model: MediaModelDescriptor, call: Call): Submission {
  const images = [...(call.image ? [call.image] : []), ...(call.referenceImages ?? [])];
  const aspectRatio = nearestAspectRatio(call, model.aspectRatios ?? []);
  const duration = clampDuration(call.durationSeconds, model.durationSeconds);
  const audio = call.audio;
  switch (model.id) {
    case "google/nano-banana-2.1":
      return {
        endpoint: images.length ? `${model.id}/edit` : model.id,
        body: defined({
          prompt: call.prompt,
          num_images: 1,
          output_format: "png",
          aspect_ratio: aspectRatio,
          resolution: nearestResolution(sizeResolution(call.size, "k"), model.resolutions ?? []),
          image_urls: images.length ? images.map(url) : undefined,
        }),
      };
    case "bytedance/seedream/v5.5":
      return {
        endpoint: `${model.id}/${images.length ? "edit" : "text-to-image"}`,
        body: defined({
          prompt: call.prompt,
          num_images: 1,
          output_format: "png",
          image_size: aspectRatio ? SEEDREAM_SIZES[aspectRatio] : undefined,
          image_urls: images.length ? images.map(url) : undefined,
        }),
      };
    case "bytedance/seedance-2.5": {
      const references = call.referenceImages ?? [];
      if ((call.endFrame && !call.startFrame) || (call.startFrame && references.length))
        throw new MediaGenerationError("unsupported");
      const shared = {
        prompt: call.prompt,
        duration: duration ? String(duration) : undefined,
        resolution: nearestResolution(call.resolution, model.resolutions ?? []),
        generate_audio: audio,
      };
      if (call.startFrame)
        return {
          endpoint: `${model.id}/image-to-video`,
          body: defined({
            ...shared,
            image_url: url(call.startFrame),
            end_image_url: call.endFrame ? url(call.endFrame) : undefined,
          }),
        };
      return references.length
        ? {
            endpoint: `${model.id}/reference-to-video`,
            body: defined({
              ...shared,
              aspect_ratio: aspectRatio,
              image_urls: references.map(url),
            }),
          }
        : {
            endpoint: `${model.id}/text-to-video`,
            body: defined({ ...shared, aspect_ratio: aspectRatio }),
          };
    }
    case "fal-ai/kling-video/v3/pro": {
      if (call.endFrame && !call.startFrame) throw new MediaGenerationError("unsupported");
      const shared = {
        prompt: call.prompt,
        duration: duration ? String(duration) : undefined,
        generate_audio: audio,
      };
      return call.startFrame
        ? {
            endpoint: `${model.id}/image-to-video`,
            body: defined({
              ...shared,
              start_image_url: url(call.startFrame),
              end_image_url: call.endFrame ? url(call.endFrame) : undefined,
            }),
          }
        : {
            endpoint: `${model.id}/text-to-video`,
            body: defined({ ...shared, aspect_ratio: aspectRatio }),
          };
    }
    default:
      // A model fal does not list here gets the prompt alone, as nothing says what else it takes.
      return {
        endpoint: model.id,
        body:
          model.kind === "image" ? { prompt: call.prompt, num_images: 1 } : { prompt: call.prompt },
      };
  }
}

/** The fields the original single-model setup sent, kept for models named in the environment. */
function legacySubmission(model: MediaModelDescriptor, prompt: string): Submission {
  return {
    endpoint: model.id,
    body:
      model.kind === "video"
        ? { prompt, num_frames: 65, frames_per_second: 16, resolution: "480p" }
        : { prompt, num_images: 1, image_size: "square", output_format: "png" },
  };
}

const queueJob = z.object({
  request_id: z.string().min(1),
  status_url: z.string(),
  response_url: z.string(),
});
const savedQueueJob = z.object({ status: z.string(), response: z.string() });
const queueStatus = z.object({
  status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]),
  error: z.unknown().optional(),
  error_type: z.string().nullish(),
});
const fileResult = z.object({ url: z.string().min(1) });
const imageResult = z.union([
  z.object({ images: z.array(fileResult).min(1) }).transform((value) => value.images[0]!.url),
  z.object({ image: fileResult }).transform((value) => value.image.url),
]);
const videoResult = z.object({ video: fileResult }).transform((value) => value.video.url);
const POLICY = "content_policy_violation";
const policyDetail = z.object({ detail: z.array(z.object({ type: z.string() })) });

function isRefusal(_status: number, body: unknown) {
  const parsed = policyDetail.safeParse(body);
  return parsed.success && parsed.data.detail.some((item) => item.type === POLICY);
}

export interface FalMediaOptions extends MediaHttpOptions {
  apiKey: string;
  baseUrl?: string;
  /** A single image model, as the environment names it; replaces the listed models. */
  imageModel?: string;
  /** A single video model, as the environment names it; replaces the listed models. */
  videoModel?: string;
  /** The listed models, for a provider built from a connected account. */
  models?: readonly MediaModelDescriptor[];
  customModels?: boolean;
}

/** fal's queue: submit to a model endpoint, poll its status, then read and download its result. */
export class FalMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "fal";
  readonly capabilities;
  private readonly baseUrl: string;
  private readonly models: readonly MediaModelDescriptor[];
  private readonly legacy: boolean;
  constructor(private readonly options: FalMediaOptions) {
    const base = new URL(options.baseUrl ?? QUEUE);
    if (
      !["https:", "http:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error("Invalid media generation base URL");
    this.baseUrl = base.href.replace(/\/$/, "");
    for (const model of [options.imageModel, options.videoModel]) {
      if (model && !MODEL_ENDPOINT.test(model)) throw new Error("Invalid media model endpoint");
    }
    this.legacy = !options.models;
    this.models = options.models ?? [
      ...(options.imageModel
        ? [
            {
              id: options.imageModel,
              name: options.imageModel,
              kind: "image" as const,
              default: true,
            },
          ]
        : []),
      ...(options.videoModel
        ? [
            {
              id: options.videoModel,
              name: options.videoModel,
              kind: "video" as const,
              default: true,
            },
          ]
        : []),
    ];
    const edits = this.models.some((model) => model.edit);
    this.capabilities = {
      images: this.models.some((model) => model.kind === "image"),
      ...(edits ? { imageEdit: true } : {}),
      video: this.models.some((model) => model.kind === "video"),
      offline: false,
    };
  }

  /** A queue URL, which must stay on the queue's own origin before the key is sent to it. */
  private path(raw: string) {
    const url = new URL(raw, `${this.baseUrl}/`);
    if (
      url.origin !== new URL(this.baseUrl).origin ||
      !url.href.startsWith(`${this.baseUrl}/`) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new MediaGenerationError("provider_failure");
    return url.href;
  }

  private request(url: string, context: AdapterContext, json?: unknown) {
    return mediaRequestJson(
      this.path(url),
      {
        headers: { Authorization: `Key ${this.options.apiKey}` },
        json,
        isPolicyRefusal: isRefusal,
      },
      this.options,
      context,
    );
  }

  private async submit(call: Call, kind: "image" | "edit" | "video", context: AdapterContext) {
    const model = resolveMediaModel(
      this.models,
      kind === "video" ? "video" : "image",
      call.model,
      this.options.customModels,
    );
    const prompt = checkMediaInput(
      kind === "edit"
        ? // The edited image takes one of the model's image places.
          { ...model, referenceImages: (model.referenceImages ?? 1) - 1 }
        : model,
      call,
      kind,
    );
    const { endpoint, body } = this.legacy
      ? legacySubmission(model, prompt)
      : submission(model, { ...call, prompt });
    if (!MODEL_ENDPOINT.test(endpoint)) throw new MediaGenerationError("invalid_input");
    const job = parseMediaResponse(
      queueJob,
      await this.request(`${this.baseUrl}/${endpoint}`, context, body),
    );
    return encodeMediaJob({
      status: this.path(job.status_url),
      response: this.path(job.response_url),
    });
  }

  private async poll(id: string, context: AdapterContext) {
    const job = decodeMediaJob(savedQueueJob, id);
    const status = parseMediaResponse(queueStatus, await this.request(job.status, context));
    // A failed request still reaches COMPLETED, with an error beside it.
    if (status.error || status.error_type)
      return {
        status: "failed" as const,
        ...(status.error_type === POLICY ? { code: "content_policy" as const } : {}),
      };
    if (status.status !== "COMPLETED")
      return { status: status.status === "IN_QUEUE" ? ("queued" as const) : ("running" as const) };
    return { status: "completed" as const, value: await this.request(job.response, context) };
  }

  private async generate(call: Call, kind: "image" | "edit", context: AdapterContext) {
    const signal = deadlineSignal(MEDIA_IMAGE_DEADLINE_MS, context.signal);
    const deadline = { ...context, signal };
    try {
      const id = await this.submit(call, kind, deadline);
      const done = await waitForMediaJob(
        async () => {
          const job = await this.poll(id, deadline);
          if (job.status === "failed")
            throw new MediaGenerationError(job.code ?? "provider_failure");
          return job.status === "completed" ? job.value : undefined;
        },
        signal,
        context,
      );
      const url = parseMediaResponse(imageResult, done);
      return await downloadMediaOutput(url, "image", this.options, context, signal);
    } catch (error) {
      throw mediaFailure(error, context);
    }
  }

  generateImage(input: MediaGenerationInput, context: AdapterContext): Promise<GeneratedMedia> {
    return this.generate({ ...input, prompt: input.prompt }, "image", context);
  }

  editImage(input: MediaImageEditInput, context: AdapterContext): Promise<GeneratedMedia> {
    return this.generate({ ...input, prompt: input.prompt }, "edit", context);
  }

  async generateVideo(input: MediaVideoInput, context: AdapterContext): Promise<MediaVideoJob> {
    return {
      id: await this.submit({ ...input, prompt: input.prompt }, "video", context),
      status: "queued",
    };
  }

  async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    const job = await this.poll(id, context);
    if (job.status !== "completed") return { id, ...job };
    const url = parseMediaResponse(videoResult, job.value);
    return {
      id,
      status: "completed",
      output: await downloadMediaOutput(url, "video", this.options, context),
    };
  }
}

export const falMedia: MediaProviderDefinition = {
  catalog: { name: "fal", fields: [{ name: "apiKey", label: "API key", secret: true }] },
  models: MODELS,
  customModels: true,
  create: (credential, options) =>
    new FalMediaGenerationProvider({
      ...options,
      apiKey: mediaCredentialSecret(credential, "apiKey"),
      models: MODELS,
      customModels: true,
    }),
};
