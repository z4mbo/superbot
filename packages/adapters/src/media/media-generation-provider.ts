import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { FAKE_VIDEO_BASE64 } from "./fake-media-assets.js";

export { FalMediaGenerationProvider } from "../providers/media/fal/fal-media.js";
export {
  GENERATED_IMAGE_MIME_TYPES,
  mediaPromptSchema,
  validateGeneratedMedia,
} from "./media-provider-http.js";

/** Deterministic provider; no network or billing. */
export class FakeMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "fake";
  readonly capabilities = { images: true, video: true, offline: true };
  async generateImage(
    _input: MediaGenerationInput,
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    context.signal.throwIfAborted();
    return {
      mimeType: "image/png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0u8AAAAASUVORK5CYII=",
        "base64",
      ),
    };
  }
  async generateVideo(
    _input: MediaGenerationInput,
    context: AdapterContext,
  ): Promise<MediaVideoJob> {
    context.signal.throwIfAborted();
    return { id: "fake-video", status: "queued", progress: 0 };
  }
  async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    context.signal.throwIfAborted();
    return {
      id,
      status: "completed",
      output: {
        mimeType: "video/mp4",
        bytes: Buffer.from(FAKE_VIDEO_BASE64, "base64"),
      },
    };
  }
}
