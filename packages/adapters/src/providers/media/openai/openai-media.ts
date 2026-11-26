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
  MediaProviderCredential,
  MediaProviderDefinition,
} from "../../../media/media-provider-descriptor.js";
import type { MediaHttpOptions } from "../../../media/media-provider-http.js";
import {
  decodeBase64Image,
  downloadMediaOutput,
  imageDataUrl,
  MEDIA_IMAGE_DEADLINE_MS,
  MEDIA_INLINE_RESPONSE_BYTES,
  mediaRequestJson,
  parseMediaResponse,
} from "../../../media/media-provider-http.js";
import {
  checkMediaInput,
  mediaCredentialSecret,
  nearestQuality,
  nearestSize,
  resolveMediaModel,
} from "../../../media/media-provider-input.js";

const API = "https://api.openai.com/v1";
const MODEL_ID_PATTERN = /^[\w.:/@+-]{1,200}$/;
const SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
const QUALITIES = ["low", "medium", "high"] as const;
/** An edit takes sixteen images: the one edited and the rest as references. */
const EDIT_IMAGES = 16;

const gptImage = (id: string, name: string, extra: Partial<MediaModelDescriptor> = {}) =>
  ({
    id,
    name,
    kind: "image",
    edit: true,
    mask: true,
    referenceImages: EDIT_IMAGES,
    sizes: SIZES,
    qualities: QUALITIES,
    ...extra,
  }) satisfies MediaModelDescriptor;

// gpt-image-1 shut down on 2026-10-23 and is not offered.
const MODELS: readonly MediaModelDescriptor[] = [
  gptImage("gpt-image-2.6-sunburst", "GPT Image 2.6 Sunburst", { default: true }),
  gptImage("gpt-image-2.6-flare", "GPT Image 2.6 Flare"),
  gptImage("gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst"),
  gptImage("gpt-image-2.5-flare", "GPT Image 2.5 Flare"),
  gptImage("gpt-image-2", "GPT Image 2"),
];

const imagesResponse = z.object({
  data: z
    .array(
      z.union([z.object({ b64_json: z.string().min(1) }), z.object({ url: z.string().min(1) })]),
    )
    .min(1),
});
const errorCode = z.object({ error: z.object({ code: z.string().nullish() }) });

/** The Images API answers a moderation refusal with a 400 whose code says so. */
function isRefusal(status: number, body: unknown) {
  const parsed = errorCode.safeParse(body);
  return status === 400 && parsed.success && parsed.data.error.code === "moderation_blocked";
}

const image = (input: MediaInputImage) => ({ image_url: imageDataUrl(input) });

export interface OpenAIMediaOptions extends MediaHttpOptions {
  apiKey: string;
  /** A single model, as the environment names it; replaces the listed models. */
  imageModel?: string;
  /** The listed models, for a provider built from a connected account. */
  models?: readonly MediaModelDescriptor[];
  /** A server that speaks the same API. */
  baseUrl?: string;
}

/**
 * The Images API (`/images/generations`, `/images/edits`). Servers that speak the same API work
 * through the base URL. It returns the image inline or as a link, which is downloaded like any
 * untrusted output URL; it has no video.
 */
export class OpenAIMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "openai";
  readonly capabilities;
  private readonly base: string;
  private readonly models: readonly MediaModelDescriptor[];
  constructor(private readonly options: OpenAIMediaOptions) {
    const url = new URL(options.baseUrl ?? API);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid media generation base URL");
    if (options.imageModel !== undefined && !MODEL_ID_PATTERN.test(options.imageModel))
      throw new Error("Invalid media model id");
    this.base = url.href.replace(/\/$/, "");
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
    ];
    this.capabilities = {
      images: this.models.length > 0,
      ...(this.models.some((model) => model.edit) ? { imageEdit: true } : {}),
      video: false,
      offline: false,
    };
  }

  async generateImage(
    input: MediaGenerationInput,
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const model = resolveMediaModel(this.models, "image", input.model);
    const prompt = checkMediaInput(model, input, "image");
    const references = input.referenceImages ?? [];
    // Generation takes no image; references go through an edit, which steers from them.
    return references.length
      ? this.request("edits", model, input, { prompt, images: references.map(image) }, context)
      : this.request("generations", model, input, { prompt }, context);
  }

  async editImage(input: MediaImageEditInput, context: AdapterContext): Promise<GeneratedMedia> {
    const model = resolveMediaModel(this.models, "image", input.model);
    const prompt = checkMediaInput(
      { ...model, referenceImages: (model.referenceImages ?? 1) - 1 },
      input,
      "edit",
    );
    return this.request(
      "edits",
      model,
      input,
      {
        prompt,
        // A mask applies to the first image, the one edited.
        images: [input.image, ...(input.referenceImages ?? [])].map(image),
        ...(input.mask ? { mask: image(input.mask) } : {}),
      },
      context,
    );
  }

  private async request(
    endpoint: "generations" | "edits",
    model: MediaModelDescriptor,
    input: MediaGenerationInput,
    body: Record<string, unknown>,
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const signal = deadlineSignal(MEDIA_IMAGE_DEADLINE_MS, context.signal);
    const size = nearestSize(input, model.sizes ?? []);
    const quality = nearestQuality(input.quality, model.qualities ?? []);
    const result = parseMediaResponse(
      imagesResponse,
      await mediaRequestJson(
        `${this.base}/images/${endpoint}`,
        {
          headers: { Authorization: `Bearer ${this.options.apiKey}` },
          json: {
            model: model.id,
            ...body,
            n: 1,
            ...(size ? { size } : {}),
            ...(quality ? { quality } : {}),
          },
          signal,
          maxBytes: MEDIA_INLINE_RESPONSE_BYTES,
          isPolicyRefusal: isRefusal,
        },
        this.options,
        context,
      ),
    );
    const item = result.data[0]!;
    return "b64_json" in item
      ? decodeBase64Image(item.b64_json)
      : downloadMediaOutput(item.url, "image", this.options, context, signal);
  }

  async generateVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
  }

  async pollVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
  }
}

/** A borrowed connection's own endpoint, when it has one; the vendor's otherwise. */
function baseUrl(credential: MediaProviderCredential) {
  return credential.kind === "model_connection" ? credential.baseUrl : undefined;
}

export const openaiMedia: MediaProviderDefinition = {
  catalog: { name: "OpenAI", fields: [{ name: "apiKey", label: "API key", secret: true }] },
  modelConnections: [{ provider: "openai", auth: "api_key" }],
  models: MODELS,
  create: (credential, options) =>
    new OpenAIMediaGenerationProvider({
      ...options,
      apiKey: mediaCredentialSecret(credential, "apiKey", openaiMedia.modelConnections),
      models: MODELS,
      baseUrl: baseUrl(credential),
    }),
};
