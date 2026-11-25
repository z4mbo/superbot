import type { AdapterContext } from "./types.js";

export type MediaImageMimeType = "image/png" | "image/jpeg" | "image/webp";
/** An image handed to a provider: a reference, an edit source, a mask or a video frame. */
export type MediaInputImage = { bytes: Uint8Array; mimeType: MediaImageMimeType };
export type MediaQuality = "low" | "medium" | "high" | "auto";

/**
 * What every generation takes. Only the prompt is required. A provider maps a size, aspect
 * ratio or quality its model has no setting for onto the nearest one it has, or leaves it out.
 * It refuses with `unsupported`, and never silently drops, an input that changes what is
 * made and that the model cannot take: a reference image, a mask, a frame or sound.
 */
export type MediaGenerationInput = {
  prompt: string;
  /** The provider's own model id; its default for the call when omitted. */
  model?: string;
  /** Width to height, such as "16:9". */
  aspectRatio?: string;
  /** Pixels as "1024x1024", for a model that takes a size instead of an aspect ratio. */
  size?: string;
  quality?: MediaQuality;
  /** Images that steer the result without being edited themselves. */
  referenceImages?: MediaInputImage[];
};
export type MediaImageEditInput = MediaGenerationInput & {
  image: MediaInputImage;
  /** Marks the part of the image to change. */
  mask?: MediaInputImage;
};
export type MediaVideoInput = MediaGenerationInput & {
  startFrame?: MediaInputImage;
  endFrame?: MediaInputImage;
  durationSeconds?: number;
  /** Such as "480p", "720p" or "1080p". */
  resolution?: string;
  /** Whether the video carries generated sound. */
  audio?: boolean;
};
export type GeneratedMedia = {
  bytes: Uint8Array;
  mimeType: MediaImageMimeType | "video/mp4";
};
export type MediaVideoJob =
  | { id: string; status: "queued" | "running"; progress?: number }
  | { id: string; status: "completed"; output: GeneratedMedia }
  | { id: string; status: "failed" };
export interface MediaGenerationProvider {
  readonly id: string;
  readonly capabilities: {
    images: boolean;
    /** Changes a source image through `editImage`. Absent means it cannot. */
    imageEdit?: boolean;
    video: boolean;
    offline: boolean;
  };
  generateImage(input: MediaGenerationInput, context: AdapterContext): Promise<GeneratedMedia>;
  /** Present only on a provider that can edit; the caller checks `capabilities.imageEdit`. */
  editImage?(input: MediaImageEditInput, context: AdapterContext): Promise<GeneratedMedia>;
  generateVideo(input: MediaVideoInput, context: AdapterContext): Promise<MediaVideoJob>;
  /**
   * The job id is all that is saved between submitting and polling, and the poll may run in
   * another process on a provider built again from the same credential. So the id holds
   * whatever the poll needs (the model, a status path), and never a secret.
   */
  pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob>;
}
export type MediaGenerationErrorCode =
  | "invalid_input"
  | "unsupported"
  | "authentication"
  | "rate_limit"
  | "content_policy"
  | "provider_failure"
  | "output_limit";
export class MediaGenerationError extends Error {
  constructor(public readonly code: MediaGenerationErrorCode) {
    super(`Media generation: ${code}`);
    this.name = "MediaGenerationError";
  }
}
