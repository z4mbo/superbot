import type {
  MediaGenerationInput,
  MediaImageEditInput,
  MediaQuality,
  MediaVideoInput,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import type {
  MediaModelConnectionSource,
  MediaModelDescriptor,
  MediaProviderCredential,
} from "./media-provider-descriptor.js";
import { checkedInputImage, mediaPromptSchema } from "./media-provider-http.js";

const CUSTOM_MODEL_PATTERN = /^[A-Za-z0-9_][\w.:-]*(?:\/[A-Za-z0-9_][\w.:-]*)*$/;

/**
 * The model a call uses: the one it names, or the provider's default for the kind. A model the
 * provider does not list is taken only when it takes custom models, and then with no input
 * beyond the prompt, since nothing says what else it can take.
 */
export function resolveMediaModel(
  models: readonly MediaModelDescriptor[],
  kind: "image" | "video",
  requested: string | undefined,
  customModels = false,
): MediaModelDescriptor {
  const id = requested?.trim();
  const listed = id
    ? models.find((model) => model.id === id)
    : models.find((model) => model.kind === kind && model.default);
  if (listed) {
    if (listed.kind !== kind) throw new MediaGenerationError("unsupported");
    return listed;
  }
  if (!id || !customModels) throw new MediaGenerationError("unsupported");
  if (id.length > 200 || !CUSTOM_MODEL_PATTERN.test(id))
    throw new MediaGenerationError("invalid_input");
  return { id, name: id, kind };
}

/**
 * Checks what a call asks of its model and answers the trimmed prompt. Inputs that change what
 * is made and that the model cannot take are refused; hints are left to the adapter to map.
 */
export function checkMediaInput(
  model: MediaModelDescriptor,
  input: MediaGenerationInput & Partial<MediaImageEditInput> & Partial<MediaVideoInput>,
  call: "image" | "edit" | "video",
): string {
  const prompt = mediaPromptSchema.safeParse(input);
  if (!prompt.success) throw new MediaGenerationError("invalid_input");
  const references = input.referenceImages ?? [];
  if (references.length > (model.referenceImages ?? 0))
    throw new MediaGenerationError("unsupported");
  if (call === "edit") {
    if (!model.edit || !input.image) throw new MediaGenerationError("unsupported");
    if (input.mask && !model.mask) throw new MediaGenerationError("unsupported");
  }
  if (call === "video") {
    if (input.startFrame && !model.startFrame) throw new MediaGenerationError("unsupported");
    if (input.endFrame && !model.endFrame) throw new MediaGenerationError("unsupported");
    if (input.audio === true && !model.audio) throw new MediaGenerationError("unsupported");
  }
  for (const image of [...references, input.image, input.mask, input.startFrame, input.endFrame])
    if (image) checkedInputImage(image);
  return prompt.data.prompt;
}

function ratio(value: string | undefined): number | undefined {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return undefined;
  const [width, height] = [Number(match[1]), Number(match[2])];
  return width > 0 && height > 0 ? width / height : undefined;
}

/** Width over height a call asks for, from its aspect ratio or its pixel size. */
export function requestedRatio(input: { aspectRatio?: string; size?: string }) {
  return ratio(input.aspectRatio) ?? ratio(input.size);
}

/** The allowed aspect ratio nearest the one asked for, or undefined when none was asked. */
export function nearestAspectRatio(
  input: { aspectRatio?: string; size?: string },
  allowed: readonly string[],
): string | undefined {
  const wanted = requestedRatio(input);
  if (wanted === undefined) return undefined;
  return nearestBy(allowed, (value) => {
    const candidate = ratio(value);
    return candidate === undefined ? undefined : Math.abs(Math.log(candidate / wanted));
  });
}

/** The allowed pixel size nearest the one asked for: the closest shape, then the closest area. */
export function nearestSize(
  input: { aspectRatio?: string; size?: string },
  allowed: readonly string[],
): string | undefined {
  const size = input.size?.trim().toLowerCase();
  if (size && allowed.includes(size)) return size;
  const wanted = requestedRatio(input);
  if (wanted === undefined) return undefined;
  const area = size ? pixels(size) : undefined;
  return nearestBy(allowed, (value) => {
    const candidate = ratio(value);
    if (candidate === undefined) return undefined;
    const shape = Math.abs(Math.log(candidate / wanted));
    const areaGap = area ? Math.abs(Math.log((pixels(value) ?? area) / area)) / 100 : 0;
    return shape + areaGap;
  });
}

function pixels(size: string): number | undefined {
  const match = size.match(/^(\d+)x(\d+)$/i);
  return match ? Number(match[1]) * Number(match[2]) : undefined;
}

/** The allowed resolution ("720p", "2k") nearest the one asked for. */
export function nearestResolution(
  requested: string | undefined,
  allowed: readonly string[],
): string | undefined {
  const wanted = resolutionValue(requested);
  if (wanted === undefined) return undefined;
  return nearestBy(allowed, (value) => {
    const candidate = resolutionValue(value);
    return candidate === undefined ? undefined : Math.abs(candidate - wanted);
  });
}

function resolutionValue(value: string | undefined): number | undefined {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*([pk])$/i);
  if (!match) return undefined;
  // Lines for "720p"; "1k" and "2k" read as their usual line counts.
  return match[2]!.toLowerCase() === "k" ? Number(match[1]) * 1080 : Number(match[1]);
}

/** The allowed length nearest the one asked for, in seconds. */
export function nearestDuration(
  requested: number | undefined,
  allowed: readonly number[],
): number | undefined {
  if (requested === undefined || !Number.isFinite(requested)) return undefined;
  return nearestBy(allowed, (value) => Math.abs(value - requested));
}

/** A length clamped into the model's range and rounded to whole seconds. */
export function clampDuration(
  requested: number | undefined,
  range: { min: number; max: number } | undefined,
): number | undefined {
  if (requested === undefined || !Number.isFinite(requested) || !range) return undefined;
  return Math.min(Math.max(Math.round(requested), range.min), range.max);
}

const QUALITY_ORDER: readonly MediaQuality[] = ["low", "medium", "high"];

/** The quality asked for, or the nearest the model has; "auto" and no answer leave it out. */
export function nearestQuality<T extends string>(
  requested: MediaQuality | undefined,
  allowed: readonly T[],
): T | undefined {
  if (!requested) return undefined;
  if ((allowed as readonly string[]).includes(requested)) return requested as T;
  const rank = QUALITY_ORDER.indexOf(requested);
  if (rank < 0) return undefined;
  return nearestBy(allowed, (value) => {
    const candidate = QUALITY_ORDER.indexOf(value as MediaQuality);
    return candidate < 0 ? undefined : Math.abs(candidate - rank);
  });
}

function nearestBy<T>(values: readonly T[], distance: (value: T) => number | undefined) {
  let best: T | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const gap = distance(value);
    if (gap !== undefined && gap < bestDistance) {
      best = value;
      bestDistance = gap;
    }
  }
  return best;
}

/**
 * The secret a provider authenticates with: its own pasted field, or the token of a model
 * connection it lists as one it can borrow. Any other credential is refused.
 */
export function mediaCredentialSecret(
  credential: MediaProviderCredential,
  field: string,
  connections: readonly MediaModelConnectionSource[] = [],
): string {
  const secret =
    credential.kind === "key"
      ? credential.fields[field]
      : connections.some(
            (source) => source.provider === credential.provider && source.auth === credential.auth,
          )
        ? credential.token
        : undefined;
  const trimmed = secret?.trim();
  if (!trimmed) throw new MediaGenerationError("authentication");
  return trimmed;
}

/**
 * A pixel size as the named resolution it reaches, to pick a model's nearest one: its long edge
 * in thousands ("2k") or its short edge in lines ("1080p").
 */
export function sizeResolution(size: string | undefined, style: "k" | "p"): string | undefined {
  const match = size?.trim().match(/^(\d+)x(\d+)$/i);
  if (!match) return undefined;
  const [width, height] = [Number(match[1]), Number(match[2])];
  return style === "k" ? `${Math.max(width, height) / 1000}k` : `${Math.min(width, height)}p`;
}
