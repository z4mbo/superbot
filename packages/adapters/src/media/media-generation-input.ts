import type {
  MediaGenerationInput,
  MediaImageEditInput,
  MediaInputImage,
  MediaQuality,
  MediaVideoInput,
} from "@rakazo/adapter-kit";
import type { MediaModelDescriptor } from "./media-provider-descriptor.js";
import type { MediaJob } from "./media-router.js";

/** A call's options the chosen model cannot take; the message tells the model what it can. */
export class MediaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaInputError";
  }
}

/** Reads one image a call names: "attached", an artifact id, or a workspace path. */
export type MediaImageLoader = (reference: string, field: string) => Promise<MediaInputImage>;

const QUALITIES: readonly MediaQuality[] = ["low", "medium", "high", "auto"];
const MAX_REFERENCE_IMAGES = 8;

function text(args: Record<string, unknown>, field: string, max = 200): string | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length > max)
    throw new MediaInputError(`${field} must be a string of at most ${max} characters.`);
  return value.trim() || undefined;
}

function oneOf(
  field: string,
  value: string | undefined,
  allowed: readonly string[] | undefined,
  model: MediaModelDescriptor | undefined,
) {
  if (value === undefined || !model || !allowed?.length || allowed.includes(value)) return;
  throw new MediaInputError(`${model.id} takes ${field} ${allowed.join(", ")}; not "${value}".`);
}

function refuse(model: MediaModelDescriptor | undefined, what: string): never {
  throw new MediaInputError(`${model?.id ?? "This model"} ${what}.`);
}

/**
 * The provider input for one call, checked against the chosen model's descriptor. A model with
 * no descriptor (the server default, or an id the provider takes unlisted) is left to refuse
 * what it cannot take itself.
 */
export async function prepareMediaInput(
  job: MediaJob,
  args: Record<string, unknown>,
  model: MediaModelDescriptor | undefined,
  modelId: string | undefined,
  loadImage: MediaImageLoader,
): Promise<MediaGenerationInput | MediaImageEditInput | MediaVideoInput> {
  const prompt = text(args, "prompt", 4000);
  if (!prompt) throw new MediaInputError("A prompt of 1–4000 characters is required.");
  const aspectRatio = text(args, "aspectRatio", 20);
  oneOf("aspectRatio", aspectRatio, model?.aspectRatios, model);
  const base: MediaGenerationInput = {
    prompt,
    ...(modelId ? { model: modelId } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
  };
  if (job === "video") {
    const resolution = text(args, "resolution", 20);
    oneOf("resolution", resolution, model?.resolutions, model);
    const duration = args.durationSeconds;
    if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration)))
      throw new MediaInputError("durationSeconds must be a number.");
    const range = model?.durationSeconds;
    if (duration !== undefined && model && range && (duration < range.min || duration > range.max))
      refuse(model, `makes ${range.min}–${range.max} second videos`);
    if (duration !== undefined && model && !range) refuse(model, "takes no duration");
    const audio = args.audio;
    if (audio !== undefined && typeof audio !== "boolean")
      throw new MediaInputError("audio must be true or false.");
    if (audio === true && model && !model.audio) refuse(model, "makes no sound");
    const start = text(args, "startFrame", 1000);
    const end = text(args, "endFrame", 1000);
    if (start && model && !model.startFrame) refuse(model, "takes no start frame");
    if (end && model && !model.endFrame) refuse(model, "takes no end frame");
    if (args.referenceImages !== undefined)
      throw new MediaInputError(
        "generate_video takes startFrame and endFrame, not referenceImages.",
      );
    return {
      ...base,
      ...(resolution ? { resolution } : {}),
      ...(duration !== undefined ? { durationSeconds: duration } : {}),
      ...(audio !== undefined ? { audio } : {}),
      ...(start ? { startFrame: await loadImage(start, "startFrame") } : {}),
      ...(end ? { endFrame: await loadImage(end, "endFrame") } : {}),
    } satisfies MediaVideoInput;
  }
  const size = text(args, "size", 20);
  oneOf("size", size, model?.sizes, model);
  const quality = text(args, "quality", 10);
  if (quality && !QUALITIES.includes(quality as MediaQuality))
    throw new MediaInputError(`quality is one of ${QUALITIES.join(", ")}.`);
  oneOf("quality", quality, model?.qualities, model);
  const references = args.referenceImages;
  if (
    references !== undefined &&
    (!Array.isArray(references) ||
      references.length > MAX_REFERENCE_IMAGES ||
      references.some((entry) => typeof entry !== "string" || !entry.trim()))
  )
    throw new MediaInputError(`referenceImages is a list of up to ${MAX_REFERENCE_IMAGES} images.`);
  const referenceList = (references as string[] | undefined) ?? [];
  const allowed = model?.referenceImages ?? 0;
  if (model && referenceList.length > allowed)
    refuse(
      model,
      allowed ? `takes at most ${allowed} reference images` : "takes no reference images",
    );
  const image: MediaGenerationInput = {
    ...base,
    ...(size ? { size } : {}),
    ...(quality ? { quality: quality as MediaQuality } : {}),
    ...(referenceList.length
      ? {
          referenceImages: await Promise.all(
            referenceList.map((entry) => loadImage(entry.trim(), "referenceImages")),
          ),
        }
      : {}),
  };
  if (job === "image") {
    if (args.image !== undefined || args.mask !== undefined)
      throw new MediaInputError("To change an existing image, use edit_image.");
    return image;
  }
  const source = text(args, "image", 1000);
  if (!source) throw new MediaInputError("image names the image to change.");
  const mask = text(args, "mask", 1000);
  if (mask && model && !model.mask) refuse(model, "takes no mask");
  return {
    ...image,
    image: await loadImage(source, "image"),
    ...(mask ? { mask: await loadImage(mask, "mask") } : {}),
  } satisfies MediaImageEditInput;
}
