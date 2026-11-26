import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaImageEditInput,
  MediaVideoInput,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import { FAKE_VIDEO_BASE64 } from "./fake-media-assets.js";
import type {
  MediaModelDescriptor,
  MediaProviderCredential,
  MediaProviderDefinition,
} from "./media-provider-descriptor.js";

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0u8AAAAASUVORK5CYII=";

/** A key value the scripted provider refuses, so tests reach the authentication failure. */
export const SCRIPTED_MEDIA_REJECTED_KEY = "rejected-key";
/** A prompt containing this makes the scripted video fail when it is checked. */
export const SCRIPTED_MEDIA_FAILING_PROMPT = "[fail]";

export const SCRIPTED_MEDIA_MODELS: readonly MediaModelDescriptor[] = [
  {
    id: "scripted-image",
    name: "Scripted image",
    kind: "image",
    default: true,
    edit: true,
    mask: true,
    referenceImages: 2,
    aspectRatios: ["1:1", "3:2", "2:3"],
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    qualities: ["low", "medium", "high"],
  },
  {
    id: "scripted-video",
    name: "Scripted video",
    kind: "video",
    default: true,
    startFrame: true,
    endFrame: true,
    audio: true,
    durationSeconds: { min: 2, max: 8 },
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["480p", "720p"],
  },
];

/**
 * Deterministic media provider: no network, no billing. It records every call so tests can
 * see what reached the provider, and fails on demand through its key or prompt.
 */
export class ScriptedMediaProvider implements MediaGenerationProvider {
  readonly id = "scripted";
  readonly capabilities = { images: true, imageEdit: true, video: true, offline: true };
  readonly calls: Array<{
    operation: "generate" | "edit" | "video" | "poll";
    input?: MediaGenerationInput;
    jobId?: string;
  }> = [];

  constructor(
    private readonly options: {
      credential?: MediaProviderCredential;
      /** How many checks report the video still running before it completes. */
      pollsUntilDone?: number;
    } = {},
  ) {}

  private authenticate(context: AdapterContext) {
    context.signal.throwIfAborted();
    const credential = this.options.credential;
    const key =
      credential?.kind === "key" ? credential.fields.apiKey : (credential?.token ?? undefined);
    if (key === SCRIPTED_MEDIA_REJECTED_KEY) throw new MediaGenerationError("authentication");
  }

  private image(): GeneratedMedia {
    return { mimeType: "image/png", bytes: Buffer.from(PIXEL_PNG, "base64") };
  }

  async generateImage(input: MediaGenerationInput, context: AdapterContext) {
    this.authenticate(context);
    this.calls.push({ operation: "generate", input });
    return this.image();
  }

  async editImage(input: MediaImageEditInput, context: AdapterContext) {
    this.authenticate(context);
    this.calls.push({ operation: "edit", input });
    return this.image();
  }

  async generateVideo(input: MediaVideoInput, context: AdapterContext): Promise<MediaVideoJob> {
    this.authenticate(context);
    this.calls.push({ operation: "video", input });
    const model = input.model ?? "scripted-video";
    const fails = input.prompt.includes(SCRIPTED_MEDIA_FAILING_PROMPT);
    return { id: `scripted:${model}${fails ? ":fail" : ""}`, status: "queued", progress: 0 };
  }

  private checks = 0;

  async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    this.authenticate(context);
    this.calls.push({ operation: "poll", jobId: id });
    if (!id.startsWith("scripted:")) throw new MediaGenerationError("invalid_input");
    if (id.endsWith(":fail")) return { id, status: "failed" };
    if (this.checks++ < (this.options.pollsUntilDone ?? 0)) {
      return { id, status: "running", progress: 50 };
    }
    return {
      id,
      status: "completed",
      output: { mimeType: "video/mp4", bytes: Buffer.from(FAKE_VIDEO_BASE64, "base64") },
    };
  }
}

/**
 * Whether this server was set up for offline runs: the scripted agent runtime (tests and
 * end-to-end fixtures) or the offline media provider as its own media setup. A production
 * server sets neither, so the scripted provider is never offered there.
 */
export function scriptedMediaOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.AGENT_RUNTIME === "scripted" ||
    env.MEDIA_GENERATION_PROVIDER?.trim().toLowerCase() === "fake"
  );
}

/** Offered only on a server set up for offline runs: local fixtures and end-to-end tests. */
export const scriptedMedia: MediaProviderDefinition = {
  catalog: {
    name: "Scripted",
    fields: [
      { name: "keyId", label: "Key ID", secret: false },
      { name: "apiKey", label: "API key", secret: true },
    ],
  },
  available: () => scriptedMediaOffered(),
  models: SCRIPTED_MEDIA_MODELS,
  create: (credential) => new ScriptedMediaProvider({ credential }),
};
