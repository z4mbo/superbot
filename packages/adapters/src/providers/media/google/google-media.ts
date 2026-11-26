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
  downloadProviderMedia,
  encodeMediaJob,
  imageBase64,
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
  nearestResolution,
  resolveMediaModel,
  sizeResolution,
} from "../../../media/media-provider-input.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const API = `${BASE}/models`;
/**
 * An Omni request answers once the video is made, with the file it will be served from; it is
 * held this long. The file is then polled until it is ready, like any queued video.
 */
const VIDEO_SUBMIT_DEADLINE_MS = 5 * 60_000;
/** First and last frame interpolation makes videos of at most ten seconds. */
const TWO_FRAME_MAX_SECONDS = 10;
const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

// Imagen 4 and Veo 3.1 are shut down and not offered. 4K is left out of the image sizes and the
// video resolutions: a 4K file is past the attachment limit.
const MODELS: readonly MediaModelDescriptor[] = [
  {
    id: "gemini-nano-banana-2.1",
    name: "Nano Banana 2.1",
    kind: "image",
    default: true,
    edit: true,
    referenceImages: 14,
    aspectRatios: [...RATIOS, "1:4", "4:1", "1:8", "8:1"],
    resolutions: ["1K", "2K"],
  },
  {
    id: "gemini-3-pro-image",
    name: "Nano Banana Pro",
    kind: "image",
    edit: true,
    referenceImages: 14,
    aspectRatios: RATIOS,
    resolutions: ["1K", "2K"],
  },
  {
    id: "gemini-omni-1.2-flash",
    name: "Gemini Omni Flash",
    kind: "video",
    default: true,
    startFrame: true,
    endFrame: true,
    audio: true,
    durationSeconds: { min: 3, max: 15 },
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["360p", "720p", "1080p"],
  },
];

/** The interaction as REST answers it: the video's file is in the model's output step. */
const interaction = z.object({
  status: z.string().nullish(),
  steps: z
    .array(
      z.object({
        type: z.string(),
        content: z
          .array(z.object({ type: z.string().nullish(), uri: z.string().nullish() }))
          .nullish(),
      }),
    )
    .nullish(),
});
const fileState = z.object({ state: z.string().nullish() });
const FILE_ID = /\/files\/([\w-]{1,200})(?:[:?]|$)/;
const savedJob = z.object({ file: z.string().regex(/^[\w-]{1,200}$/) });

const response = z.object({
  promptFeedback: z.object({ blockReason: z.string().nullish() }).nullish(),
  candidates: z
    .array(
      z.object({
        finishReason: z.string().nullish(),
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  thought: z.boolean().nullish(),
                  inlineData: z.object({ mimeType: z.string(), data: z.string() }).nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
});
/** Finish reasons that mean the request or its image was refused. */
const REFUSED = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
]);

const part = (image: MediaInputImage) => ({
  inline_data: { mime_type: image.mimeType, data: imageBase64(image) },
});

/** Nano Banana images and Gemini Omni video through the Gemini API, with a Gemini API key. */
export class GoogleMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "google";
  readonly capabilities = { images: true, imageEdit: true, video: true, offline: false };
  constructor(
    private readonly apiKey: string,
    private readonly http: MediaHttpOptions = {},
  ) {}

  async generateImage(
    input: MediaGenerationInput,
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const model = resolveMediaModel(MODELS, "image", input.model);
    const prompt = checkMediaInput(model, input, "image");
    return this.generate(model, input, prompt, input.referenceImages ?? [], context);
  }

  async editImage(input: MediaImageEditInput, context: AdapterContext): Promise<GeneratedMedia> {
    const model = resolveMediaModel(MODELS, "image", input.model);
    const prompt = checkMediaInput(
      { ...model, referenceImages: (model.referenceImages ?? 1) - 1 },
      input,
      "edit",
    );
    return this.generate(
      model,
      input,
      prompt,
      [input.image, ...(input.referenceImages ?? [])],
      context,
    );
  }

  private async generate(
    model: MediaModelDescriptor,
    input: MediaGenerationInput,
    prompt: string,
    images: MediaInputImage[],
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const aspectRatio = nearestAspectRatio(input, model.aspectRatios ?? []);
    const imageSize = nearestResolution(sizeResolution(input.size, "k"), model.resolutions ?? []);
    const result = parseMediaResponse(
      response,
      await mediaRequestJson(
        `${API}/${model.id}:generateContent`,
        {
          headers: { "x-goog-api-key": this.apiKey },
          json: {
            contents: [{ role: "user", parts: [...images.map(part), { text: prompt }] }],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"],
              ...(aspectRatio || imageSize
                ? {
                    imageConfig: {
                      ...(aspectRatio ? { aspectRatio } : {}),
                      ...(imageSize ? { imageSize } : {}),
                    },
                  }
                : {}),
            },
          },
          signal: deadlineSignal(MEDIA_IMAGE_DEADLINE_MS, context.signal),
          maxBytes: MEDIA_INLINE_RESPONSE_BYTES,
        },
        this.http,
        context,
      ),
    );
    if (result.promptFeedback?.blockReason) throw new MediaGenerationError("content_policy");
    const candidate = result.candidates?.[0];
    // Thought images are drafts; the last image that is not one is the answer.
    const final = candidate?.content?.parts
      ?.filter((item) => item.inlineData && !item.thought)
      .at(-1)?.inlineData;
    if (final) return decodeBase64Image(final.data);
    if (REFUSED.has(candidate?.finishReason ?? ""))
      throw new MediaGenerationError("content_policy");
    throw new MediaGenerationError("provider_failure");
  }

  async generateVideo(input: MediaVideoInput, context: AdapterContext): Promise<MediaVideoJob> {
    const model = resolveMediaModel(MODELS, "video", input.model);
    const prompt = checkMediaInput(model, input, "video");
    // The model always makes sound, and an end frame needs the frame it starts from.
    if (input.audio === false || (input.endFrame && !input.startFrame))
      throw new MediaGenerationError("unsupported");
    const frames = [input.startFrame, input.endFrame].filter((frame): frame is MediaInputImage =>
      Boolean(frame),
    );
    const range =
      frames.length === 2
        ? { min: model.durationSeconds!.min, max: TWO_FRAME_MAX_SECONDS }
        : model.durationSeconds;
    const duration = clampDuration(input.durationSeconds, range);
    const aspectRatio = nearestAspectRatio(input, model.aspectRatios ?? []);
    const resolution = nearestResolution(input.resolution, model.resolutions ?? []);
    const result = parseMediaResponse(
      interaction,
      await mediaRequestJson(
        `${BASE}/interactions`,
        {
          headers: { "x-goog-api-key": this.apiKey },
          json: {
            model: model.id,
            input: frames.length
              ? [
                  ...frames.map((frame) => ({
                    type: "image",
                    data: imageBase64(frame),
                    mime_type: frame.mimeType,
                  })),
                  { type: "text", text: prompt },
                ]
              : prompt,
            response_format: {
              type: "video",
              delivery: "uri",
              ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
              ...(resolution ? { resolution } : {}),
              ...(duration ? { duration: `${duration}s` } : {}),
            },
          },
          signal: deadlineSignal(VIDEO_SUBMIT_DEADLINE_MS, context.signal),
        },
        this.http,
        context,
      ),
    );
    const uri = result.steps
      ?.filter((step) => step.type === "model_output")
      .flatMap((step) => step.content ?? [])
      .find((part) => part.type === "video" && part.uri)?.uri;
    // Only the file's id is kept: the poll builds its own URL on the API's host.
    const file = uri?.match(FILE_ID)?.[1];
    if (!file) throw new MediaGenerationError("provider_failure");
    return { id: encodeMediaJob({ file }), status: "queued" };
  }

  async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    const job = decodeMediaJob(savedJob, id);
    const file = `${BASE}/files/${encodeURIComponent(job.file)}`;
    const headers = { "x-goog-api-key": this.apiKey };
    const { state } = parseMediaResponse(
      fileState,
      await mediaRequestJson(file, { headers }, this.http, context),
    );
    if (state === "FAILED") return { id, status: "failed" };
    if (state !== "ACTIVE") return { id, status: "running" };
    return {
      id,
      status: "completed",
      output: await downloadProviderMedia(
        `${file}:download?alt=media`,
        headers,
        "video",
        this.http,
        context,
      ),
    };
  }
}

export const googleMedia: MediaProviderDefinition = {
  catalog: { name: "Google Gemini", fields: [{ name: "apiKey", label: "API key", secret: true }] },
  modelConnections: [{ provider: "google", auth: "api_key" }],
  models: MODELS,
  create: (credential, options) =>
    new GoogleMediaGenerationProvider(
      mediaCredentialSecret(credential, "apiKey", googleMedia.modelConnections),
      options,
    ),
};
