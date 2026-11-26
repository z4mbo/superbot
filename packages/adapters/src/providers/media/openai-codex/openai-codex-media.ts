import { randomUUID } from "node:crypto";
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
  imageDataUrl,
  MEDIA_IMAGE_DEADLINE_MS,
  MEDIA_INLINE_RESPONSE_BYTES,
  mediaRequestBytes,
} from "../../../media/media-provider-http.js";
import {
  checkMediaInput,
  mediaCredentialSecret,
  nearestQuality,
  nearestSize,
  resolveMediaModel,
} from "../../../media/media-provider-input.js";
import { modelProviders } from "../../../models/model-provider-registry.js";

/** The Responses endpoint the Codex client calls with a ChatGPT sign-in. */
const API = "https://chatgpt.com/backend-api/codex/responses";
/** The chat model that hosts the image tool: the one a new ChatGPT connection preselects. */
const HOST_MODEL = modelProviders["openai-codex"].recommendedModel;
/** Images one request carries: an edited image and its references together. */
const INPUT_IMAGES = 5;
/**
 * The stream repeats the finished image in its closing event, so it holds the image's base64
 * twice, plus the events around it.
 */
const STREAM_BYTES = MEDIA_INLINE_RESPONSE_BYTES * 2 + 256 * 1024;

const gptImage = (id: string, name: string, extra: Partial<MediaModelDescriptor> = {}) =>
  ({
    id,
    name,
    kind: "image",
    edit: true,
    referenceImages: INPUT_IMAGES,
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    qualities: ["low", "medium", "high"],
    ...extra,
  }) satisfies MediaModelDescriptor;

// The image tool's models; the sign-in makes no video (the video API it would need shut down).
const MODELS: readonly MediaModelDescriptor[] = [
  gptImage("gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst", { default: true }),
  gptImage("gpt-image-2.5-flare", "GPT Image 2.5 Flare"),
  gptImage("gpt-image-2", "GPT Image 2"),
];

const errorCode = z.object({ error: z.object({ code: z.string().nullish() }) });
const REFUSALS = new Set([
  "moderation_blocked",
  "content_policy_violation",
  "invalid_prompt",
  "cyber_policy",
  "bio_policy",
  "misalignment_policy_violation",
]);

function isRefusal(status: number, body: unknown) {
  const parsed = errorCode.safeParse(body);
  return status === 400 && parsed.success && REFUSALS.has(parsed.data.error.code ?? "");
}

const streamEvent = z.object({
  type: z.string(),
  item: z.object({ type: z.string(), result: z.string().nullish() }).nullish(),
  response: z.object({ error: z.object({ code: z.string().nullish() }).nullish() }).nullish(),
  error: z.object({ code: z.string().nullish() }).nullish(),
});

/**
 * The finished image from a Responses event stream: the `image_generation_call` item's base64
 * result. A failed response is a refusal when its code says so, a provider failure otherwise.
 */
export function imageFromResponseStream(body: string): GeneratedMedia {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let parsed: z.infer<typeof streamEvent>;
    try {
      const event = streamEvent.safeParse(JSON.parse(data));
      if (!event.success) continue;
      parsed = event.data;
    } catch {
      continue;
    }
    if (parsed.type === "response.failed" || parsed.type === "error") {
      const code = parsed.response?.error?.code ?? parsed.error?.code ?? "";
      throw new MediaGenerationError(REFUSALS.has(code) ? "content_policy" : "provider_failure");
    }
    if (
      parsed.type === "response.output_item.done" &&
      parsed.item?.type === "image_generation_call" &&
      parsed.item.result
    ) {
      return decodeBase64Image(parsed.item.result);
    }
  }
  throw new MediaGenerationError("provider_failure");
}

const inputImage = (image: MediaInputImage) => ({
  type: "input_image",
  image_url: imageDataUrl(image),
});

/**
 * GPT Image for people signed in with ChatGPT: the Codex Responses endpoint with the
 * `image_generation` tool, answered as an event stream. Images and edits only.
 */
export class OpenAICodexMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "openai-codex";
  readonly capabilities = { images: true, imageEdit: true, video: false, offline: false };
  constructor(
    private readonly token: string,
    private readonly accountId: string,
    private readonly http: MediaHttpOptions = {},
  ) {}

  async generateImage(
    input: MediaGenerationInput,
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const model = resolveMediaModel(MODELS, "image", input.model);
    const prompt = checkMediaInput(model, input, "image");
    const references = input.referenceImages ?? [];
    // References steer a new image; with none, the tool is told to make one rather than edit.
    return this.request(
      model,
      input,
      prompt,
      references,
      references.length ? "auto" : "generate",
      context,
    );
  }

  async editImage(input: MediaImageEditInput, context: AdapterContext): Promise<GeneratedMedia> {
    const model = resolveMediaModel(MODELS, "image", input.model);
    const prompt = checkMediaInput(
      { ...model, referenceImages: (model.referenceImages ?? 1) - 1 },
      input,
      "edit",
    );
    const images = [input.image, ...(input.referenceImages ?? [])];
    return this.request(model, input, prompt, images, "edit", context);
  }

  private async request(
    model: MediaModelDescriptor,
    input: MediaGenerationInput,
    prompt: string,
    images: readonly MediaInputImage[],
    action: "generate" | "edit" | "auto",
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const size = nearestSize(input, model.sizes ?? []);
    const quality = nearestQuality(input.quality, model.qualities ?? []);
    const session = randomUUID();
    const bytes = await mediaRequestBytes(
      API,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "chatgpt-account-id": this.accountId,
          "OpenAI-Beta": "responses=experimental",
          originator: "rakazo",
          accept: "text/event-stream",
          "session-id": session,
          "x-client-request-id": session,
        },
        json: {
          model: HOST_MODEL,
          store: false,
          stream: true,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: prompt }, ...images.map(inputImage)],
            },
          ],
          tools: [
            {
              type: "image_generation",
              model: model.id,
              action,
              ...(size ? { size } : {}),
              ...(quality ? { quality } : {}),
            },
          ],
          tool_choice: { type: "image_generation" },
        },
        signal: deadlineSignal(MEDIA_IMAGE_DEADLINE_MS, context.signal),
        maxBytes: STREAM_BYTES,
        isPolicyRefusal: isRefusal,
      },
      this.http,
      context,
    );
    return imageFromResponseStream(new TextDecoder().decode(bytes));
  }

  async generateVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
  }

  async pollVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
  }
}

export const openaiCodexMedia: MediaProviderDefinition = {
  catalog: { name: "ChatGPT", fields: [] },
  modelConnections: [{ provider: "openai-codex", auth: "oauth" }],
  models: MODELS,
  create: (credential, options) => {
    const token = mediaCredentialSecret(credential, "", openaiCodexMedia.modelConnections);
    // The borrowed sign-in names its account, read the same way a model run reads it.
    const accountId = credential.kind === "model_connection" ? credential.accountId?.trim() : "";
    if (!accountId) throw new MediaGenerationError("authentication");
    return new OpenAICodexMediaGenerationProvider(token, accountId, options);
  },
};
