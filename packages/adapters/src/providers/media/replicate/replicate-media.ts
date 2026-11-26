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
  checkedInputImage,
  decodeMediaJob,
  downloadMediaOutput,
  encodeMediaJob,
  imageBlob,
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
} from "../../../media/media-provider-input.js";

const API = "https://api.replicate.com/v1";
/** Larger inputs are uploaded first; Replicate takes data URLs only for small files. */
const DATA_URL_BYTES = 256 * 1024;
/** How long a create call asks Replicate to hold the answer for a finished image. */
const PREFER_WAIT = "wait=60";

const MODELS: readonly MediaModelDescriptor[] = [
  {
    id: "black-forest-labs/flux-2-pro",
    name: "FLUX.2 Pro",
    kind: "image",
    default: true,
    edit: true,
    referenceImages: 8,
    aspectRatios: ["1:1", "16:9", "3:2", "2:3", "4:5", "5:4", "9:16", "3:4", "4:3"],
  },
  {
    id: "bytedance/seedream-4.5",
    name: "Seedream 4.5",
    kind: "image",
    edit: true,
    referenceImages: 14,
    aspectRatios: ["1:1", "4:3", "3:4", "4:5", "5:4", "16:9", "9:16", "3:2", "2:3", "21:9", "9:21"],
  },
  {
    id: "kwaivgi/kling-v3-video",
    name: "Kling 3",
    kind: "video",
    default: true,
    startFrame: true,
    endFrame: true,
    audio: true,
    durationSeconds: { min: 3, max: 15 },
    aspectRatios: ["16:9", "9:16", "1:1"],
    resolutions: ["720p", "1080p"],
  },
];

const prediction = z.object({
  id: z.string().regex(/^[\w-]{1,200}$/),
  status: z.string(),
  output: z.union([z.string(), z.array(z.string())]).nullish(),
});
const uploaded = z.object({ urls: z.object({ get: z.string().url() }) });
const savedJob = z.object({ prediction: z.string().regex(/^[\w-]{1,200}$/) });

type Call = MediaGenerationInput & Partial<MediaImageEditInput> & Partial<MediaVideoInput>;

/** Replicate's predictions API for the official models listed here, with an API token. */
export class ReplicateMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "replicate";
  readonly capabilities = { images: true, imageEdit: true, video: true, offline: false };
  constructor(
    private readonly apiToken: string,
    private readonly http: MediaHttpOptions = {},
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.apiToken}` };
  }

  /** An input file: inline when small, otherwise uploaded and passed by its Replicate URL. */
  private async file(image: MediaInputImage, context: AdapterContext): Promise<string> {
    if (checkedInputImage(image).bytes.byteLength <= DATA_URL_BYTES) return imageDataUrl(image);
    const form = new FormData();
    form.append("content", imageBlob(image), `input.${image.mimeType.split("/")[1]}`);
    const result = parseMediaResponse(
      uploaded,
      await mediaRequestJson(`${API}/files`, { headers: this.headers(), form }, this.http, context),
    );
    if (!result.urls.get.startsWith(`${API}/files/`))
      throw new MediaGenerationError("provider_failure");
    return result.urls.get;
  }

  private async files(images: MediaInputImage[], context: AdapterContext) {
    const urls: string[] = [];
    for (const image of images) urls.push(await this.file(image, context));
    return urls;
  }

  /** The prediction input for a listed model; each names its fields its own way. */
  private async input(
    model: MediaModelDescriptor,
    call: Call & { prompt: string },
    context: AdapterContext,
  ) {
    const images = await this.files(
      [...(call.image ? [call.image] : []), ...(call.referenceImages ?? [])],
      context,
    );
    const aspectRatio = nearestAspectRatio(call, model.aspectRatios ?? []);
    const start = call.startFrame ? await this.file(call.startFrame, context) : undefined;
    const end = call.endFrame ? await this.file(call.endFrame, context) : undefined;
    if (end && !start) throw new MediaGenerationError("unsupported");
    const resolution = nearestResolution(call.resolution, model.resolutions ?? []);
    const audio = call.audio === undefined ? {} : { generate_audio: call.audio };
    switch (model.id) {
      case "black-forest-labs/flux-2-pro":
        return {
          prompt: call.prompt,
          output_format: "png",
          ...(images.length ? { input_images: images } : {}),
          ...(aspectRatio
            ? { aspect_ratio: aspectRatio }
            : images.length
              ? { aspect_ratio: "match_input_image" }
              : {}),
        };
      case "bytedance/seedream-4.5":
        return {
          prompt: call.prompt,
          max_images: 1,
          ...(images.length ? { image_input: images } : {}),
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        };
      case "kwaivgi/kling-v3-video": {
        const duration = clampDuration(call.durationSeconds, model.durationSeconds);
        return {
          prompt: call.prompt,
          ...(start ? { start_image: start } : {}),
          ...(end ? { end_image: end } : {}),
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          ...(resolution ? { mode: resolution === "1080p" ? "pro" : "standard" } : {}),
          ...(duration ? { duration } : {}),
          ...audio,
        };
      }
      default:
        throw new MediaGenerationError("unsupported");
    }
  }

  private async create(
    call: Call,
    kind: "image" | "edit" | "video",
    context: AdapterContext,
    signal?: AbortSignal,
  ) {
    const model = resolveMediaModel(MODELS, kind === "video" ? "video" : "image", call.model);
    const prompt = checkMediaInput(
      kind === "edit" ? { ...model, referenceImages: (model.referenceImages ?? 1) - 1 } : model,
      call,
      kind,
    );
    const input = await this.input(model, { ...call, prompt }, context);
    return parseMediaResponse(
      prediction,
      await mediaRequestJson(
        `${API}/models/${model.id}/predictions`,
        {
          headers: { ...this.headers(), ...(kind === "video" ? {} : { Prefer: PREFER_WAIT }) },
          json: { input },
          signal,
        },
        this.http,
        context,
      ),
    );
  }

  private async get(id: string, context: AdapterContext) {
    return parseMediaResponse(
      prediction,
      await mediaRequestJson(
        `${API}/predictions/${encodeURIComponent(id)}`,
        { headers: this.headers() },
        this.http,
        context,
      ),
    );
  }

  private async image(call: Call, kind: "image" | "edit", context: AdapterContext) {
    const signal = deadlineSignal(MEDIA_IMAGE_DEADLINE_MS, context.signal);
    const deadline = { ...context, signal };
    try {
      let current = await this.create(call, kind, deadline, signal);
      const output = await waitForMediaJob(
        async () => {
          const found = outputUrl(current);
          if (found) return found;
          current = await this.get(current.id, deadline);
          return outputUrl(current);
        },
        signal,
        context,
      );
      return await downloadMediaOutput(output, "image", this.http, context, signal);
    } catch (error) {
      throw mediaFailure(error, context);
    }
  }

  generateImage(input: MediaGenerationInput, context: AdapterContext): Promise<GeneratedMedia> {
    return this.image(input, "image", context);
  }

  editImage(input: MediaImageEditInput, context: AdapterContext): Promise<GeneratedMedia> {
    return this.image(input, "edit", context);
  }

  async generateVideo(input: MediaVideoInput, context: AdapterContext): Promise<MediaVideoJob> {
    const created = await this.create(input, "video", context);
    return { id: encodeMediaJob({ prediction: created.id }), status: "queued" };
  }

  async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    const job = decodeMediaJob(savedJob, id);
    const current = await this.get(job.prediction, context);
    if (["failed", "canceled", "aborted"].includes(current.status)) return { id, status: "failed" };
    if (current.status === "starting") return { id, status: "queued" };
    if (current.status === "processing") return { id, status: "running" };
    const output = outputUrl(current);
    if (!output) throw new MediaGenerationError("provider_failure");
    return {
      id,
      status: "completed",
      output: await downloadMediaOutput(output, "video", this.http, context),
    };
  }
}

/** The file a finished prediction made; undefined while it runs. */
function outputUrl(current: z.infer<typeof prediction>): string | undefined {
  if (["failed", "canceled", "aborted"].includes(current.status))
    throw new MediaGenerationError("provider_failure");
  if (current.status !== "succeeded") return undefined;
  const output = Array.isArray(current.output) ? current.output[0] : current.output;
  if (!output) throw new MediaGenerationError("provider_failure");
  return output;
}

export const replicateMedia: MediaProviderDefinition = {
  catalog: { name: "Replicate", fields: [{ name: "apiToken", label: "API token", secret: true }] },
  models: MODELS,
  create: (credential, options) =>
    new ReplicateMediaGenerationProvider(mediaCredentialSecret(credential, "apiToken"), options),
};
