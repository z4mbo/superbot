import { describe, expect, it } from "vitest";
import {
  mediaContext as context,
  inputPng,
  json,
  MP4,
  mediaFetch,
  PNG,
  pngDataUrl,
} from "../../../media/media-provider.test-support.js";
import { replicateMedia } from "./replicate-media.js";

const key = { kind: "key", fields: { apiToken: "fake-token" } } as const;
const jobId = JSON.stringify({ prediction: "p1" });
const prediction = (status: string, output: unknown = null) => ({
  id: "p1",
  model: "m",
  version: "hidden",
  input: {},
  status,
  output,
  error: null,
  urls: { get: "https://api.replicate.com/v1/predictions/p1" },
});
function build(...responses: Response[]) {
  const mocked = mediaFetch(...responses);
  return { ...mocked, provider: replicateMedia.create(key, mocked.http) };
}

describe("Replicate media", () => {
  it("creates an image prediction that finishes within the wait", async () => {
    const { provider, call } = build(
      json(prediction("succeeded", "https://replicate.delivery/x/out.png"), { status: 201 }),
      new Response(PNG),
    );
    expect(await provider.generateImage({ prompt: "draw", aspectRatio: "16:9" }, context)).toEqual({
      mimeType: "image/png",
      bytes: PNG,
    });
    expect(call(0).url).toBe(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions",
    );
    expect(call(0).headers.get("authorization")).toBe("Bearer fake-token");
    expect(call(0).headers.get("prefer")).toBe("wait=60");
    expect(call(0).json()).toEqual({
      input: { prompt: "draw", output_format: "png", aspect_ratio: "16:9" },
    });
    expect(call(1).headers.has("authorization")).toBe(false);
  });

  it("polls an image that outlasts the wait, reading the first of several outputs", async () => {
    const { provider, call } = build(
      json(prediction("processing"), { status: 202 }),
      json(
        prediction("succeeded", [
          "https://replicate.delivery/x/1.png",
          "https://replicate.delivery/x/2.png",
        ]),
      ),
      new Response(PNG),
    );
    await provider.editImage?.(
      { prompt: "night", model: "bytedance/seedream-4.5", image: inputPng },
      context,
    );
    expect(call(0).json()).toEqual({
      input: { prompt: "night", max_images: 1, image_input: [pngDataUrl] },
    });
    expect(call(1).url).toBe("https://api.replicate.com/v1/predictions/p1");
    expect(call(2).url).toBe("https://replicate.delivery/x/1.png");
  });

  it("uploads a large input first and passes its file URL", async () => {
    const large = new Uint8Array(300 * 1024);
    large.set(PNG);
    const { provider, call } = build(
      json({ id: "f1", urls: { get: "https://api.replicate.com/v1/files/f1" } }, { status: 201 }),
      json(prediction("succeeded", "https://replicate.delivery/x/out.png"), { status: 201 }),
      new Response(PNG),
    );
    await provider.editImage?.(
      { prompt: "night", image: { bytes: large, mimeType: "image/png" } },
      context,
    );
    expect(call(0).url).toBe("https://api.replicate.com/v1/files");
    expect(call(0).body).toBeInstanceOf(FormData);
    expect(call(1).json()).toMatchObject({
      input: { input_images: ["https://api.replicate.com/v1/files/f1"] },
    });
  });

  it("fails an image prediction that failed", async () => {
    const { provider } = build(json({ ...prediction("failed"), error: "private reason" }));
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
  });

  it("submits a video and polls it on a fresh instance", async () => {
    const {
      provider: submitter,
      call,
      http,
    } = build(
      json(prediction("starting"), { status: 201 }),
      json(prediction("starting")),
      json(prediction("processing")),
      json(prediction("succeeded", "https://replicate.delivery/x/v.mp4")),
      new Response(MP4),
      json(prediction("canceled")),
    );
    expect(
      await submitter.generateVideo(
        {
          prompt: "move",
          startFrame: inputPng,
          endFrame: inputPng,
          durationSeconds: 5,
          resolution: "4k",
          audio: true,
        },
        context,
      ),
    ).toEqual({ id: jobId, status: "queued" });
    expect(call(0).url).toBe(
      "https://api.replicate.com/v1/models/kwaivgi/kling-v3-video/predictions",
    );
    expect(call(0).headers.has("prefer")).toBe(false);
    expect(call(0).json()).toEqual({
      input: {
        prompt: "move",
        start_image: pngDataUrl,
        end_image: pngDataUrl,
        mode: "pro",
        duration: 5,
        generate_audio: true,
      },
    });
    const provider = replicateMedia.create(key, http);
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "queued" });
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "running" });
    expect(await provider.pollVideo(jobId, context)).toEqual({
      id: jobId,
      status: "completed",
      output: { mimeType: "video/mp4", bytes: MP4 },
    });
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "failed" });
  });

  it("maps Kling's fields", async () => {
    const { provider, call } = build(json(prediction("starting"), { status: 201 }));
    await provider.generateVideo(
      {
        prompt: "move",
        model: "kwaivgi/kling-v3-video",
        durationSeconds: 30,
        resolution: "720p",
        aspectRatio: "1:1",
      },
      context,
    );
    expect(call(0).json()).toEqual({
      input: { prompt: "move", aspect_ratio: "1:1", mode: "standard", duration: 15 },
    });
  });

  it("refuses what the listed models cannot take, and models it does not list", async () => {
    const { provider, fetch } = build();
    await expect(
      provider.generateVideo({ prompt: "x", endFrame: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateVideo({ prompt: "x", referenceImages: [inputPng] }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.editImage?.({ prompt: "x", image: inputPng, mask: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateImage({ prompt: "x", model: "someone/model" }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authentication"],
    [429, "rate_limit"],
    [422, "provider_failure"],
  ])("maps HTTP %i", async (status, code) => {
    const { provider } = build(
      json({ title: "x", detail: "fake-token", status }, { status: Number(status) }),
    );
    const error = await provider.generateVideo({ prompt: "x" }, context).catch((e) => e);
    expect(error).toMatchObject({ code, message: `Media generation: ${code}` });
  });
});
