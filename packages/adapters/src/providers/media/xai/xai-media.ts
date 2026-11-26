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
  decodeBase64Image,
  decodeMediaJob,
  downloadMediaOutput,
  encodeMediaJob,
  imageDataUrl,
  MEDIA_IMAGE_DEADLINE_MS,
  MEDIA_INLINE_RESPONSE_BYTES,
  mediaRequestJson,
  parseMediaResponse,
} from "../../../media/media-provider-http.js";
import {
  checkMediaInput,
  clampDuration,
  mediaCredentialSecret,
  nearestAspectRatio,
  nearestQuality,
  nearestResolution,
  resolveMediaModel,
  sizeResolution,
} from "../../../media/media-provider-input.js";

const API = "https://api.x.ai/v1";
const IMAGE_ASPECT_RATIOS = [
  "1:1",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
  "2:3",
  "3:2",
  "9:19.5",
  "19.5:9",
  "9:20",
  "20:9",
  "1:2",
  "2:1",
  "21:9",
  "5:2",
] as const;
const VIDEO_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:2"];
/** Reference-to-video renders at most 720p. */
const REFERENCE_RESOLUTIONS = ["480p", "720p"];

const MODELS: readonly MediaModelDescriptor[] = [
  {
    id: "grok-imagine-image-2.0",
    name: "Grok Imagine Image 2.0",
    kind: "image",
    default: true,
    edit: true,
    // Multi-image editing takes five images; a generation steers from up to all five.
    referenceImages: 5,
    aspectRatios: IMAGE_ASPECT_RATIOS,
    resolutions: ["1k", "2k"],
    qualities: ["low", "medium"],
  },
  {
    id: "grok-imagine-video-1.5",
    name: "Grok Imagine Video 1.5",
    kind: "video",
    default: true,
    startFrame: true,
    endFrame: true,
    audio: true,
    referenceImages: 14,
    durationSeconds: { min: 1, max: 15 },
    aspectRatios: VIDEO_ASPECT_RATIOS,
    resolutions: ["480p", "720p", "1080p"],
  },
];

const imagesResponse = z.object({
  data: z
    .array(
      z.union([z.object({ b64_json: z.string().min(1) }), z.object({ url: z.string().min(1) })]),
    )
    .min(1),
});
const videoStarted = z.object({ request_id: z.string().min(1).max(200) });
const videoStatus = z.object({
  status: z.string(),
  progress: z.number().optional(),
  video: z
    .object({ url: z.string().nullish(), respect_moderation: z.boolean().optional() })
    .nullish(),
});
const savedJob = z.object({ request: z.string().regex(/^[\w-]{1,200}$/) });

const image = (input: MediaInputImage) => ({ url: imageDataUrl(input) });

/** Grok Imagine through the xAI REST API, with an xAI API key. */
export class XaiMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "xai";
  readonly capabilities = { images: true, imageEdit: true, video: true, offline: false };
  constructor(
    private readonly apiKey: string,
    private readonly http: MediaHttpOptions = {},
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async generateImage(
    input: MediaGenerationInput,
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const model = resolveMediaModel(MODELS, "image", input.model);
    const prompt = checkMediaInput(model, input, "image");
    const references = input.referenceImages ?? [];
    // Generation takes no image; references go through multi-image editing, which steers from them.
    return references.length
      ? this.image("edits", model, input, { prompt, images: references.map(image) }, context)
      : this.image("generations", model, input, { prompt }, context);
  }

  async editImage(input: MediaImageEditInput, context: AdapterContext): Promise<GeneratedMedia> {
    const model = resolveMediaModel(MODELS, "image", input.model);
    const prompt = checkMediaInput(
      // The edited image is one of the five the endpoint takes.
      { ...model, referenceImages: (model.referenceImages ?? 1) - 1 },
      input,
      "edit",
    );
    const references = input.referenceImages ?? [];
    return this.image(
      "edits",
      model,
      input,
      references.length
        ? { prompt, images: [input.image, ...references].map(image) }
        : { prompt, image: image(input.image) },
      context,
    );
  }

  private async image(
    endpoint: "generations" | "edits",
    model: MediaModelDescriptor,
    input: MediaGenerationInput,
    body: Record<string, unknown>,
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const signal = deadlineSignal(MEDIA_IMAGE_DEADLINE_MS, context.signal);
    const aspectRatio = nearestAspectRatio(input, model.aspectRatios ?? []);
    const resolution = nearestResolution(sizeResolution(input.size, "k"), model.resolutions ?? []);
    const quality = nearestQuality(input.quality, model.qualities ?? []);
    const result = parseMediaResponse(
      imagesResponse,
      await mediaRequestJson(
        `${API}/images/${endpoint}`,
        {
          headers: this.headers(),
          json: {
            model: model.id,
            n: 1,
            response_format: "b64_json",
            ...body,
            ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
            ...(quality ? { quality } : {}),
          },
          signal,
          maxBytes: MEDIA_INLINE_RESPONSE_BYTES,
        },
        this.http,
        context,
      ),
    );
    const item = result.data[0]!;
    return "b64_json" in item
      ? decodeBase64Image(item.b64_json)
      : downloadMediaOutput(item.url, "image", this.http, context, signal);
  }

  async generateVideo(input: MediaVideoInput, context: AdapterContext): Promise<MediaVideoJob> {
    const model = resolveMediaModel(MODELS, "video", input.model);
    const prompt = checkMediaInput(model, input, "video");
    const references = input.referenceImages ?? [];
    const resolution = nearestResolution(
      input.resolution,
      references.length ? REFERENCE_RESOLUTIONS : (model.resolutions ?? []),
    );
    const aspectRatio = nearestAspectRatio(input, model.aspectRatios ?? []);
    const duration = clampDuration(input.durationSeconds, model.durationSeconds);
    const started = parseMediaResponse(
      videoStarted,
      await mediaRequestJson(
        `${API}/videos/generations`,
        {
          headers: this.headers(),
          json: {
            model: model.id,
            prompt,
            ...(duration ? { duration } : {}),
            ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
            ...(model.audio && input.audio !== undefined ? { generate_audio: input.audio } : {}),
            ...(input.startFrame ? { image: image(input.startFrame) } : {}),
            ...(input.endFrame ? { last_frame: image(input.endFrame) } : {}),
            ...(references.length ? { reference_images: references.map(image) } : {}),
          },
        },
        this.http,
        context,
      ),
    );
    return { id: encodeMediaJob({ request: started.request_id }), status: "queued" };
  }

  async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    const job = decodeMediaJob(savedJob, id);
    const status = parseMediaResponse(
      videoStatus,
      await mediaRequestJson(
        `${API}/videos/${encodeURIComponent(job.request)}`,
        { headers: this.headers() },
        this.http,
        context,
      ),
    );
    if (status.status === "pending")
      return { id, status: "running", ...(status.progress ? { progress: status.progress } : {}) };
    if (status.status !== "done") {
      if (status.status === "failed" || status.status === "expired")
        return { id, status: "failed" };
      throw new MediaGenerationError("provider_failure");
    }
    // A finished video that moderation withheld has no link.
    if (status.video?.respect_moderation === false || !status.video?.url)
      return { id, status: "failed", code: "content_policy" };
    return {
      id,
      status: "completed",
      output: await downloadMediaOutput(status.video.url, "video", this.http, context),
    };
  }
}

export const xaiMedia: MediaProviderDefinition = {
  catalog: { name: "xAI", fields: [{ name: "apiKey", label: "API key", secret: true }] },
  modelConnections: [{ provider: "xai", auth: "api_key" }],
  models: MODELS,
  create: (credential, options) =>
    new XaiMediaGenerationProvider(
      mediaCredentialSecret(credential, "apiKey", xaiMedia.modelConnections),
      options,
    ),
};
