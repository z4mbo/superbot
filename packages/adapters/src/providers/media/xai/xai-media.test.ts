import { describe, expect, it } from "vitest";
import {
  mediaContext as context,
  inputPng,
  json,
  MP4,
  mediaFetch,
  PNG,
  pngBase64,
  pngDataUrl,
} from "../../../media/media-provider.test-support.js";
import { xaiMedia } from "./xai-media.js";

const key = { kind: "key", fields: { apiKey: "fake-key" } } as const;
const jobId = JSON.stringify({ request: "req-1" });
function build(...responses: Response[]) {
  const mocked = mediaFetch(...responses);
  return { ...mocked, provider: xaiMedia.create(key, mocked.http) };
}

describe("xAI media", () => {
  it("generates an image inline with mapped hints", async () => {
    const { provider, call } = build(
      json({ data: [{ b64_json: pngBase64, mime_type: "image/png" }] }),
    );
    expect(
      await provider.generateImage(
        { prompt: "draw", aspectRatio: "16:10", size: "2048x1280", quality: "high" },
        context,
      ),
    ).toEqual({ mimeType: "image/png", bytes: PNG });
    expect(call(0).url).toBe("https://api.x.ai/v1/images/generations");
    expect(call(0).headers.get("authorization")).toBe("Bearer fake-key");
    expect(call(0).json()).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "draw",
      n: 1,
      response_format: "b64_json",
      aspect_ratio: "3:2",
      resolution: "2k",
      quality: "medium",
    });
  });

  it("edits one image, and several through the images list", async () => {
    const { provider, call } = build(
      json({ data: [{ b64_json: pngBase64 }] }),
      json({ data: [{ b64_json: pngBase64 }] }),
    );
    await provider.editImage?.({ prompt: "night", image: inputPng }, context);
    expect(call(0).url).toBe("https://api.x.ai/v1/images/edits");
    expect(call(0).json()).toMatchObject({ image: { url: pngDataUrl } });
    await provider.editImage?.(
      { prompt: "night", image: inputPng, referenceImages: [inputPng] },
      context,
    );
    expect(call(1).json()).toMatchObject({ images: [{ url: pngDataUrl }, { url: pngDataUrl }] });
  });

  it("downloads a linked image without the key", async () => {
    const { provider, call } = build(
      json({ data: [{ url: "https://imgen.x.ai/out.jpg" }] }),
      new Response(PNG),
    );
    expect((await provider.generateImage({ prompt: "draw" }, context)).mimeType).toBe("image/png");
    expect(call(1).headers.has("authorization")).toBe(false);
  });

  it("refuses a mask, too many references and unknown models before HTTP", async () => {
    const { provider, fetch } = build();
    await expect(
      provider.editImage?.({ prompt: "x", image: inputPng, mask: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.editImage?.(
        { prompt: "x", image: inputPng, referenceImages: Array(5).fill(inputPng) },
        context,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateVideo(
        { prompt: "x", model: "grok-imagine-video-1.5-lite", endFrame: inputPng },
        context,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateImage({ prompt: "x", model: "grok-2-image" }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("submits a video with frames, references and sound", async () => {
    const { provider, call } = build(json({ request_id: "req-1" }), json({ request_id: "req-2" }));
    expect(
      await provider.generateVideo(
        {
          prompt: "move",
          startFrame: inputPng,
          endFrame: inputPng,
          durationSeconds: 20,
          resolution: "1080p",
          aspectRatio: "16:9",
          audio: false,
        },
        context,
      ),
    ).toEqual({ id: jobId, status: "queued" });
    expect(call(0).url).toBe("https://api.x.ai/v1/videos/generations");
    expect(call(0).json()).toEqual({
      model: "grok-imagine-video-1.5",
      prompt: "move",
      duration: 15,
      aspect_ratio: "16:9",
      resolution: "1080p",
      generate_audio: false,
      image: { url: pngDataUrl },
      last_frame: { url: pngDataUrl },
    });
    await provider.generateVideo(
      { prompt: "move", referenceImages: [inputPng], resolution: "1080p" },
      context,
    );
    // Reference-to-video renders at most 720p.
    expect(call(1).json()).toMatchObject({
      resolution: "720p",
      reference_images: [{ url: pngDataUrl }],
    });
  });

  it("polls on a fresh instance: pending, done, withheld and failed", async () => {
    const { provider, call } = build(
      json({ status: "pending", progress: 40 }),
      json({
        status: "done",
        video: { url: "https://vidgen.x.ai/v.mp4", duration: 8, respect_moderation: true },
      }),
      new Response(MP4),
      json({ status: "done", video: { url: null, respect_moderation: false } }),
      json({ status: "failed", error: { code: "invalid_argument", message: "private" } }),
      json({ status: "expired" }),
    );
    expect(await provider.pollVideo(jobId, context)).toEqual({
      id: jobId,
      status: "running",
      progress: 40,
    });
    expect(call(0).url).toBe("https://api.x.ai/v1/videos/req-1");
    expect(await provider.pollVideo(jobId, context)).toEqual({
      id: jobId,
      status: "completed",
      output: { mimeType: "video/mp4", bytes: MP4 },
    });
    expect(call(2).headers.has("authorization")).toBe(false);
    expect(await provider.pollVideo(jobId, context)).toEqual({
      id: jobId,
      status: "failed",
      code: "content_policy",
    });
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "failed" });
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "failed" });
  });

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [429, "rate_limit"],
    [400, "provider_failure"],
  ])("maps HTTP %i", async (status, code) => {
    const { provider } = build(new Response("private fake-key", { status: Number(status) }));
    const error = await provider.generateImage({ prompt: "draw" }, context).catch((e) => e);
    expect(error).toMatchObject({ code, message: `Media generation: ${code}` });
  });

  it("rejects malformed answers and job ids", async () => {
    await expect(
      build(json({ data: [] })).provider.generateImage({ prompt: "draw" }, context),
    ).rejects.toMatchObject({ code: "provider_failure" });
    await expect(
      build(json({ status: "weird" })).provider.pollVideo(jobId, context),
    ).rejects.toMatchObject({ code: "provider_failure" });
    await expect(
      build().provider.pollVideo(JSON.stringify({ request: "../x" }), context),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("borrows an API-key model connection only", () => {
    expect(
      xaiMedia.create(
        { kind: "model_connection", provider: "xai", auth: "api_key", token: "k" },
        {},
      ).id,
    ).toBe("xai");
    expect(() =>
      xaiMedia.create({ kind: "model_connection", provider: "xai", auth: "oauth", token: "k" }, {}),
    ).toThrow();
    expect(() => xaiMedia.create({ kind: "key", fields: {} }, {})).toThrow();
  });
});
