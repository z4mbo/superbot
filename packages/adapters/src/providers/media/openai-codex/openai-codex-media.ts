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

/** The image endpoints the Codex client itself calls with a ChatGPT sign-in. */
const API = "https://chatgpt.com/backend-api/codex/images";
const AUTH_CLAIMS = "https://api.openai.com/auth";
/** The Codex client sends at most five images to an edit. */
const EDIT_IMAGES = 5;

// The sign-in's image endpoints take only the model the Codex client sends.
const MODELS: readonly MediaModelDescriptor[] = [
  {
    id: "gpt-image-2",
    name: "GPT Image 2",
    kind: "image",
    default: true,
    edit: true,
    referenceImages: EDIT_IMAGES,
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    qualities: ["low", "medium", "high"],
  },
];

const imagesResponse = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).min(1),
});
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

/** The ChatGPT account the sign-in belongs to: given with it, or read from its access token. */
export function chatgptAccountId(token: string, accountId?: string): string | undefined {
  if (accountId?.trim()) return accountId.trim();
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    const id = payload?.[AUTH_CLAIMS]?.chatgpt_account_id ?? payload?.chatgpt_account_id;
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  } catch {
    return undefined;
  }
}

const image = (input: MediaInputImage) => ({ image_url: imageDataUrl(input) });

/** GPT Image for people signed in with ChatGPT, through the Codex backend; images only. */
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
    return references.length
      ? this.request("edits", model, input, { prompt, images: references.map(image) }, context)
      : this.request("generations", model, input, { prompt }, context);
  }

  async editImage(input: MediaImageEditInput, context: AdapterContext): Promise<GeneratedMedia> {
    const model = resolveMediaModel(MODELS, "image", input.model);
    const prompt = checkMediaInput(
      { ...model, referenceImages: (model.referenceImages ?? 1) - 1 },
      input,
      "edit",
    );
    const images = [input.image, ...(input.referenceImages ?? [])].map(image);
    return this.request("edits", model, input, { prompt, images }, context);
  }

  private async request(
    endpoint: "generations" | "edits",
    model: MediaModelDescriptor,
    input: MediaGenerationInput,
    body: Record<string, unknown>,
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const size = nearestSize(input, model.sizes ?? []);
    const quality = nearestQuality(input.quality, model.qualities ?? []);
    const result = parseMediaResponse(
      imagesResponse,
      await mediaRequestJson(
        `${API}/${endpoint}`,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            "chatgpt-account-id": this.accountId,
            originator: "rakazo",
            accept: "application/json",
            "x-codex-image-turn-id": randomUUID(),
          },
          json: {
            ...body,
            model: model.id,
            n: 1,
            ...(size ? { size } : {}),
            ...(quality ? { quality } : {}),
          },
          signal: deadlineSignal(MEDIA_IMAGE_DEADLINE_MS, context.signal),
          maxBytes: MEDIA_INLINE_RESPONSE_BYTES,
          isPolicyRefusal: isRefusal,
        },
        this.http,
        context,
      ),
    );
    return decodeBase64Image(result.data[0]!.b64_json);
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
    const accountId = chatgptAccountId(
      token,
      credential.kind === "model_connection" ? credential.accountId : undefined,
    );
    if (!accountId) throw new MediaGenerationError("authentication");
    return new OpenAICodexMediaGenerationProvider(token, accountId, options);
  },
};
