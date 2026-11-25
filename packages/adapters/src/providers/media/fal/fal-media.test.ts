import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
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
import { FalMediaGenerationProvider, falMedia } from "./fal-media.js";

const job = {
  request_id: "job",
  status_url: "https://queue.fal.run/fal-ai/wan/requests/job/status",
  response_url: "https://queue.fal.run/fal-ai/wan/requests/job",
};
const jobId = JSON.stringify({ status: job.status_url, response: job.response_url });
const imageResult = { images: [{ url: "https://cdn.example.test/image.png" }] };
const videoResult = { video: { url: "https://cdn.example.test/video.mp4" } };
const png = (headers?: HeadersInit) => new Response(PNG, { headers });
const mp4 = (headers?: HeadersInit) => new Response(MP4, { headers });

/** The provider the environment builds: one image and one video model, legacy request bodies. */
function legacy(...responses: Response[]) {
  const mocked = mediaFetch(...responses);
  return {
    ...mocked,
    provider: new FalMediaGenerationProvider({
      apiKey: "fake-key",
      imageModel: "fal-ai/flux/schnell",
      videoModel: "fal-ai/wan/v2.2-a14b/text-to-video",
      ...mocked.http,
    }),
  };
}
/** The provider a connected account builds, with the curated models. */
function connected(...responses: Response[]) {
  const mocked = mediaFetch(...responses);
  return {
    ...mocked,
    provider: falMedia.create({ kind: "key", fields: { apiKey: "fake-key" } }, mocked.http),
  };
}

describe("fal queue", () => {
  it("translates one image generation and downloads without forwarding credentials", async () => {
    const { fetch, call, provider } = legacy(
      json(job),
      json({ status: "COMPLETED" }),
      json(imageResult),
      png(),
    );
    expect(await provider.generateImage({ prompt: "draw" }, context)).toEqual({
      mimeType: "image/png",
      bytes: PNG,
    });
    expect(call(0).url).toBe("https://queue.fal.run/fal-ai/flux/schnell");
    expect(call(0).headers.get("authorization")).toBe("Key fake-key");
    expect(call(0).json()).toEqual({
      prompt: "draw",
      num_images: 1,
      image_size: "square",
      output_format: "png",
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(call(3).headers.has("authorization")).toBe(false);
  });

  it("translates async submission, queue status, completion and failure", async () => {
    const { provider, call } = legacy(
      json(job),
      json({ status: "IN_PROGRESS" }),
      json({ status: "COMPLETED" }),
      json(videoResult),
      mp4(),
      json({ status: "COMPLETED", error: "private provider failure" }),
    );
    expect(await provider.generateVideo({ prompt: "move" }, context)).toEqual({
      id: jobId,
      status: "queued",
    });
    expect(call(0).json()).toMatchObject({ num_frames: 65, resolution: "480p" });
    expect(await provider.pollVideo(jobId, context)).toMatchObject({ status: "running" });
    expect(await provider.pollVideo(jobId, context)).toMatchObject({
      status: "completed",
      output: { mimeType: "video/mp4", bytes: MP4 },
    });
    expect(call(3).url).toBe(job.response_url);
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "failed" });
  });

  it("polls a job another instance submitted", async () => {
    const { provider } = connected(json({ status: "IN_QUEUE" }));
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "queued" });
  });

  it("reads the output format from the bytes, not the label", async () => {
    const { provider } = legacy(
      json({ status: "COMPLETED" }),
      json(videoResult),
      mp4({ "content-type": "application/octet-stream" }),
    );
    expect(await provider.pollVideo(jobId, context)).toMatchObject({
      output: { mimeType: "video/mp4" },
    });
    await expect(
      legacy(
        json({ status: "COMPLETED" }),
        json(videoResult),
        new Response("<html>", { headers: { "content-type": "video/mp4" } }),
      ).provider.pollVideo(jobId, context),
    ).rejects.toMatchObject({ code: "provider_failure" });
  });

  it.each([
    [429, "rate_limit"],
    [401, "authentication"],
    [403, "authentication"],
    [503, "provider_failure"],
  ])("sanitizes HTTP %i without retrying", async (status, code) => {
    const { provider, fetch } = legacy(
      new Response("private provider response fake-key", { status: Number(status) }),
    );
    const error = await provider.generateImage({ prompt: "draw" }, context).catch((e) => e);
    expect(error).toMatchObject({ code, message: `Media generation: ${code}` });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps a content-policy refusal", async () => {
    const { provider } = connected(
      json(
        { detail: [{ loc: ["body", "prompt"], msg: "flagged", type: "content_policy_violation" }] },
        { status: 422 },
      ),
    );
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toMatchObject({
      code: "content_policy",
    });
    const refused = connected(
      json({ status: "COMPLETED", error: "flagged", error_type: "content_policy_violation" }),
    );
    expect(await refused.provider.pollVideo(jobId, context)).toEqual({
      id: jobId,
      status: "failed",
      code: "content_policy",
    });
  });

  it("sanitizes network errors and malformed responses", async () => {
    const { provider, fetch } = legacy();
    fetch.mockRejectedValueOnce(new Error("fake-key private endpoint"));
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toThrow(
      "Media generation: provider_failure",
    );
    fetch.mockResolvedValueOnce(new Response("bad JSON"));
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toThrow(
      "Media generation: provider_failure",
    );
    await expect(
      legacy(json({ status: "unknown" })).provider.pollVideo(jobId, context),
    ).rejects.toMatchObject({ code: "provider_failure" });
  });

  it("rejects unsupported capabilities, invalid prompts and bad job ids before HTTP", async () => {
    const { provider, fetch } = legacy();
    await expect(provider.generateImage({ prompt: " " }, context)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      provider.generateVideo({ prompt: "x".repeat(4001) }, context),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(provider.pollVideo("not json", context)).rejects.toMatchObject({
      code: "invalid_input",
    });
    // The environment's single model takes nothing beyond the prompt.
    await expect(
      provider.generateImage({ prompt: "draw", referenceImages: [inputPng] }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      new FalMediaGenerationProvider({ apiKey: "fake" }).generateVideo({ prompt: "move" }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("rejects oversized output with and without Content-Length", async () => {
    for (const headers of [
      new Headers({ "content-length": String(ATTACHMENT_MAX_BYTES + 1) }),
      new Headers(),
    ]) {
      const { provider } = legacy(
        json({ status: "COMPLETED" }),
        json(videoResult),
        new Response(new Uint8Array(ATTACHMENT_MAX_BYTES + 1), { headers }),
      );
      await expect(provider.pollVideo(jobId, context)).rejects.toMatchObject({
        code: "output_limit",
      });
    }
  });

  it("does not call another output failure that mentions a size a limit", async () => {
    const body = new ReadableStream({
      pull: (controller) => controller.error(new Error("upstream entity too large")),
    });
    const { provider } = legacy(
      json({ status: "COMPLETED" }),
      json(videoResult),
      new Response(body),
    );
    await expect(provider.pollVideo(jobId, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
  });

  it("rejects cross-origin queue URLs before forwarding credentials", async () => {
    const { provider, fetch } = legacy(
      json({ ...job, status_url: "https://attacker.example.test/status" }),
    );
    await expect(provider.generateVideo({ prompt: "move" }, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const saved = JSON.stringify({ status: "https://attacker.example.test/s", response: "x" });
    await expect(provider.pollVideo(saved, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://127.0.0.1/private",
    "http://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
  ])("rejects unsafe output URL %s", async (url) => {
    const { provider, fetch } = legacy(json({ status: "COMPLETED" }), json({ video: { url } }));
    await expect(provider.pollVideo(jobId, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects redirects from output downloads", async () => {
    const { provider } = legacy(
      json({ status: "COMPLETED" }),
      json(videoResult),
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );
    await expect(provider.pollVideo(jobId, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
  });

  it("preserves cancellation without making a submission", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, fetch } = legacy();
    await expect(
      provider.generateImage({ prompt: "draw" }, { ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("fal curated models", () => {
  const submitted = (app: string) => ({
    request_id: "r1",
    status_url: `https://queue.fal.run/${app}/requests/r1/status`,
    response_url: `https://queue.fal.run/${app}/requests/r1`,
  });

  it("sends the default image model's fields and edits through its edit endpoint", async () => {
    const { provider, call } = connected(
      json(submitted("google/nano-banana-2.1")),
      json({ status: "COMPLETED" }),
      json(imageResult),
      png(),
      json(submitted("google/nano-banana-2.1")),
      json({ status: "COMPLETED" }),
      json(imageResult),
      png(),
    );
    await provider.generateImage(
      { prompt: "draw", aspectRatio: "16:10", size: "2048x1152" },
      context,
    );
    expect(call(0).url).toBe("https://queue.fal.run/google/nano-banana-2.1");
    expect(call(0).json()).toEqual({
      prompt: "draw",
      num_images: 1,
      output_format: "png",
      aspect_ratio: "3:2",
      resolution: "2K",
    });
    await provider.editImage?.({ prompt: "night", image: inputPng }, context);
    expect(call(4).url).toBe("https://queue.fal.run/google/nano-banana-2.1/edit");
    expect(call(4).json()).toMatchObject({ prompt: "night", image_urls: [pngDataUrl] });
  });

  it("picks the Seedance endpoint from the input", async () => {
    const { provider, call } = connected(
      json(submitted("bytedance/seedance-2.5")),
      json(submitted("bytedance/seedance-2.5")),
      json(submitted("bytedance/seedance-2.5")),
    );
    await provider.generateVideo(
      { prompt: "move", durationSeconds: 40, resolution: "4k", aspectRatio: "16:9", audio: false },
      context,
    );
    expect(call(0).url).toBe("https://queue.fal.run/bytedance/seedance-2.5/text-to-video");
    expect(call(0).json()).toEqual({
      prompt: "move",
      duration: "30",
      resolution: "1080p",
      aspect_ratio: "16:9",
      generate_audio: false,
    });
    await provider.generateVideo(
      { prompt: "move", startFrame: inputPng, endFrame: inputPng },
      context,
    );
    expect(call(1).url).toBe("https://queue.fal.run/bytedance/seedance-2.5/image-to-video");
    expect(call(1).json()).toEqual({
      prompt: "move",
      image_url: pngDataUrl,
      end_image_url: pngDataUrl,
    });
    await provider.generateVideo({ prompt: "move", referenceImages: [inputPng] }, context);
    expect(call(2).url).toBe("https://queue.fal.run/bytedance/seedance-2.5/reference-to-video");
    expect(call(2).json()).toEqual({ prompt: "move", image_urls: [pngDataUrl] });
  });

  it("refuses inputs a model cannot take", async () => {
    const { provider, fetch } = connected();
    await expect(
      provider.generateVideo({ prompt: "move", endFrame: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateVideo(
        { prompt: "move", startFrame: inputPng, referenceImages: [inputPng] },
        context,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.editImage?.({ prompt: "x", image: inputPng, mask: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateImage({ prompt: "x", model: "bytedance/seedance-2.5" }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateImage(
        { prompt: "x", referenceImages: [{ bytes: PNG, mimeType: "image/jpeg" }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a custom model the prompt alone", async () => {
    const { provider, call } = connected(json(submitted("owner/app")));
    await provider.generateVideo({ prompt: "move", model: "owner/app/v2" }, context);
    expect(call(0).url).toBe("https://queue.fal.run/owner/app/v2");
    expect(call(0).json()).toEqual({ prompt: "move" });
    await expect(
      provider.generateVideo({ prompt: "move", model: "owner/app", startFrame: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateVideo({ prompt: "move", model: "../escape" }, context),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
