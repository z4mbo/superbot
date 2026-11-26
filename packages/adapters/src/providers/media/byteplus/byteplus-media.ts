import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationProvider,
  MediaInputImage,
  MediaVideoInput,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
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
  mediaRequestJson,
  parseMediaResponse,
} from "../../../media/media-provider-http.js";
import {
  checkMediaInput,
  clampDuration,
  mediaCredentialSecret,
  nearestAspectRatio,
  nearestResolution,
  resolveMediaModel,
} from "../../../media/media-provider-input.js";

const API = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";
const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
/** Moderation refusals, at submission or in a failed task, all carry this in their code. */
const SENSITIVE = "SensitiveContentDetected";

// 4k is left out: a 4k video is far past the attachment limit.
const MODELS: readonly MediaModelDescriptor[] = [
  {
    id: "dreamina-seedance-2-5-260628",
    name: "Seedance 2.5",
    kind: "video",
    default: true,
    startFrame: true,
    endFrame: true,
    audio: true,
    referenceImages: 30,
    durationSeconds: { min: 4, max: 30 },
    aspectRatios: RATIOS,
    resolutions: ["480p", "720p", "1080p"],
  },
  {
    id: "dreamina-seedance-2-5-flash-261115",
    name: "Seedance 2.5 Flash",
    kind: "video",
    startFrame: true,
    endFrame: true,
    audio: true,
    referenceImages: 10,
    durationSeconds: { min: 4, max: 30 },
    aspectRatios: RATIOS,
    resolutions: ["480p", "720p"],
  },
];

const created = z.object({ id: z.string().regex(/^[\w.-]{1,200}$/) });
const task = z.object({
  status: z.string(),
  content: z.object({ video_url: z.string().nullish() }).nullish(),
  error: z.object({ code: z.string().nullish() }).nullish(),
});
const savedJob = z.object({ task: z.string().regex(/^[\w.-]{1,200}$/) });

function isRefusal(_status: number, body: unknown) {
  const code = z.object({ error: z.object({ code: z.string() }) }).safeParse(body);
  return code.success && code.data.error.code.includes(SENSITIVE);
}

const imageItem = (image: MediaInputImage, role: string) => ({
  type: "image_url",
  role,
  image_url: { url: imageDataUrl(image) },
});

/** Seedance through BytePlus ModelArk's video generation tasks, with an ARK API key. */
export class BytePlusMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "byteplus";
  readonly capabilities = { images: false, video: true, offline: false };
  constructor(
    private readonly apiKey: string,
    private readonly http: MediaHttpOptions = {},
  ) {}

  async generateImage(): Promise<GeneratedMedia> {
    throw new MediaGenerationError("unsupported");
  }

  async generateVideo(input: MediaVideoInput, context: AdapterContext): Promise<MediaVideoJob> {
    const model = resolveMediaModel(MODELS, "video", input.model);
    const prompt = checkMediaInput(model, input, "video");
    const references = input.referenceImages ?? [];
    // A task is text, frames or references; a last frame needs a first one.
    if ((input.endFrame && !input.startFrame) || (input.startFrame && references.length))
      throw new MediaGenerationError("unsupported");
    const frames = [
      ...(input.startFrame ? [imageItem(input.startFrame, "first_frame")] : []),
      ...(input.endFrame ? [imageItem(input.endFrame, "last_frame")] : []),
      ...references.map((image) => imageItem(image, "reference_image")),
    ];
    // Frame tasks take their shape from the first frame and accept only "adaptive".
    const ratio = input.startFrame ? undefined : nearestAspectRatio(input, RATIOS);
    const resolution = nearestResolution(input.resolution, model.resolutions ?? []);
    const duration = clampDuration(input.durationSeconds, model.durationSeconds);
    const result = parseMediaResponse(
      created,
      await mediaRequestJson(
        API,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          json: {
            model: model.id,
            content: [{ type: "text", text: prompt }, ...frames],
            ...(ratio ? { ratio } : {}),
            ...(resolution ? { resolution } : {}),
            ...(duration ? { duration } : {}),
            ...(input.audio !== undefined ? { generate_audio: input.audio } : {}),
            watermark: false,
          },
          isPolicyRefusal: isRefusal,
        },
        this.http,
        context,
      ),
    );
    return { id: encodeMediaJob({ task: result.id }), status: "queued" };
  }

  async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    const job = decodeMediaJob(savedJob, id);
    const status = parseMediaResponse(
      task,
      await mediaRequestJson(
        `${API}/${encodeURIComponent(job.task)}`,
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
        this.http,
        context,
      ),
    );
    switch (status.status) {
      case "queued":
        return { id, status: "queued" };
      case "running":
        return { id, status: "running" };
      case "succeeded":
        if (!status.content?.video_url) throw new MediaGenerationError("provider_failure");
        return {
          id,
          status: "completed",
          output: await downloadMediaOutput(status.content.video_url, "video", this.http, context),
        };
      case "failed":
      case "cancelled":
      case "expired":
        return status.error?.code?.includes(SENSITIVE)
          ? { id, status: "failed", code: "content_policy" }
          : { id, status: "failed" };
      default:
        throw new MediaGenerationError("provider_failure");
    }
  }
}

export const byteplusMedia: MediaProviderDefinition = {
  catalog: {
    name: "BytePlus ModelArk",
    fields: [{ name: "apiKey", label: "API key", secret: true }],
  },
  models: MODELS,
  create: (credential, options) =>
    new BytePlusMediaGenerationProvider(mediaCredentialSecret(credential, "apiKey"), options),
};
