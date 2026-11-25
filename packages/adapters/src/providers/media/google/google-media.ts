import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaImageEditInput,
  MediaInputImage,
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
  imageBase64,
  MEDIA_IMAGE_DEADLINE_MS,
  MEDIA_INLINE_RESPONSE_BYTES,
  mediaRequestJson,
  parseMediaResponse,
} from "../../../media/media-provider-http.js";
import {
  checkMediaInput,
  mediaCredentialSecret,
  nearestAspectRatio,
  nearestResolution,
  resolveMediaModel,
  sizeResolution,
} from "../../../media/media-provider-input.js";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

// Imagen 4 (shut down 2026-08-17) and Veo (preview shut down 2026-10-22) are not offered. The
// one video model left takes a synchronous call only, so this provider makes no video.
// 4K is left out of the sizes: a 4K PNG is past the attachment limit.
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
];

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

/** Nano Banana image models through the Gemini API, with a Gemini API key. */
export class GoogleMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "google";
  readonly capabilities = { images: true, imageEdit: true, video: false, offline: false };
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

  async generateVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
  }

  async pollVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
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
