import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { createMediaGenerationProvider } from "./media-generation-factory.js";
import { ScriptedMediaProvider } from "./scripted-media-provider.js";

const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  operationId: "op",
  traceId: "trace",
  signal: new AbortController().signal,
};

describe("media generation connection", () => {
  it("defaults to disabled and requires explicit models and credentials", () => {
    expect(createMediaGenerationProvider({})).toBeUndefined();
    expect(
      createMediaGenerationProvider({ MEDIA_GENERATION_PROVIDER: "disabled" }),
    ).toBeUndefined();
    expect(
      createMediaGenerationProvider({ MEDIA_GENERATION_PROVIDER: "fake" })?.capabilities.offline,
    ).toBe(true);
    expect(() => createMediaGenerationProvider({ MEDIA_GENERATION_PROVIDER: "unknown" })).toThrow();
    expect(() => createMediaGenerationProvider({ MEDIA_GENERATION_PROVIDER: "fal" })).toThrow();
    expect(
      createMediaGenerationProvider({
        MEDIA_GENERATION_PROVIDER: "fal",
        MEDIA_GENERATION_API_KEY: "fake-key",
        MEDIA_GENERATION_IMAGE_MODEL: "fal-ai/flux/schnell",
        MEDIA_GENERATION_BASE_URL: "https://media.example.test",
      })?.capabilities,
    ).toEqual({ images: true, video: false, offline: false });
    // A blank base URL falls back to the provider's own default instead of failing to parse.
    expect(
      createMediaGenerationProvider({
        MEDIA_GENERATION_PROVIDER: "fal",
        MEDIA_GENERATION_API_KEY: "fake-key",
        MEDIA_GENERATION_IMAGE_MODEL: "fal-ai/flux/schnell",
        MEDIA_GENERATION_BASE_URL: " ",
      })?.id,
    ).toBe("fal");
  });
  it("selects the images API provider for images only", () => {
    const env = {
      MEDIA_GENERATION_PROVIDER: "openai",
      MEDIA_GENERATION_API_KEY: "fake-key",
      MEDIA_GENERATION_IMAGE_MODEL: "image-model",
    };
    expect(createMediaGenerationProvider(env)?.capabilities).toEqual({
      images: true,
      video: false,
      offline: false,
    });
    expect(createMediaGenerationProvider({ ...env, MEDIA_GENERATION_BASE_URL: "" })?.id).toBe(
      "openai",
    );
    expect(() =>
      createMediaGenerationProvider({ ...env, MEDIA_GENERATION_VIDEO_MODEL: "video-model" }),
    ).toThrow("images only");
    expect(() =>
      createMediaGenerationProvider({
        ...env,
        MEDIA_GENERATION_IMAGE_MODEL: "",
        MEDIA_GENERATION_VIDEO_MODEL: "video-model",
      }),
    ).toThrow("images only");
    expect(() => createMediaGenerationProvider({ ...env, MEDIA_GENERATION_API_KEY: "" })).toThrow(
      "credentials",
    );
  });
  it("has an offline image and async video implementation", async () => {
    const provider = new ScriptedMediaProvider();
    expect((await provider.generateImage({ prompt: "draw" }, context)).mimeType).toBe("image/png");
    const job = await provider.generateVideo({ prompt: "move" }, context);
    expect(job.status).toBe("queued");
    expect((await provider.pollVideo(job.id, context)).status).toBe("completed");
  });
});
