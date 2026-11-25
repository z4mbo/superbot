import { describe, expect, it } from "vitest";
import {
  mediaContext as context,
  inputPng,
  json,
  MP4,
  mediaFetch,
  pngDataUrl,
} from "../../../media/media-provider.test-support.js";
import { byteplusMedia } from "./byteplus-media.js";

const API = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";
const jobId = JSON.stringify({ task: "cgt-1" });
function build(...responses: Response[]) {
  const mocked = mediaFetch(...responses);
  return {
    ...mocked,
    provider: byteplusMedia.create({ kind: "key", fields: { apiKey: "fake-key" } }, mocked.http),
  };
}

describe("Seedance on ModelArk", () => {
  it("submits text to video with mapped settings", async () => {
    const { provider, call } = build(json({ id: "cgt-1" }));
    expect(
      await provider.generateVideo(
        { prompt: "move", aspectRatio: "16:10", resolution: "4k", durationSeconds: 2, audio: true },
        context,
      ),
    ).toEqual({ id: jobId, status: "queued" });
    expect(call(0).url).toBe(API);
    expect(call(0).headers.get("authorization")).toBe("Bearer fake-key");
    expect(call(0).json()).toEqual({
      model: "dreamina-seedance-2-5-260628",
      content: [{ type: "text", text: "move" }],
      ratio: "16:9",
      resolution: "1080p",
      duration: 4,
      generate_audio: true,
      watermark: false,
    });
  });

  it("sends first and last frames without a ratio, and references by role", async () => {
    const { provider, call } = build(json({ id: "cgt-1" }), json({ id: "cgt-2" }));
    await provider.generateVideo(
      { prompt: "move", startFrame: inputPng, endFrame: inputPng, aspectRatio: "1:1" },
      context,
    );
    expect(call(0).json()).toEqual({
      model: "dreamina-seedance-2-5-260628",
      content: [
        { type: "text", text: "move" },
        { type: "image_url", role: "first_frame", image_url: { url: pngDataUrl } },
        { type: "image_url", role: "last_frame", image_url: { url: pngDataUrl } },
      ],
      watermark: false,
    });
    await provider.generateVideo(
      { prompt: "move", model: "dreamina-seedance-2-5-flash-261115", referenceImages: [inputPng] },
      context,
    );
    expect(call(1).json()).toMatchObject({
      model: "dreamina-seedance-2-5-flash-261115",
      content: [
        { type: "text", text: "move" },
        { type: "image_url", role: "reference_image", image_url: { url: pngDataUrl } },
      ],
    });
  });

  it("refuses mixed tasks, a lone last frame and images", async () => {
    const { provider, fetch } = build();
    await expect(
      provider.generateVideo({ prompt: "x", endFrame: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateVideo(
        { prompt: "x", startFrame: inputPng, referenceImages: [inputPng] },
        context,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(provider.generateImage({ prompt: "x" }, context)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(provider.capabilities.images).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a moderation refusal at submission", async () => {
    const { provider } = build(
      json(
        { error: { code: "InputTextSensitiveContentDetected", message: "private" } },
        { status: 400 },
      ),
    );
    await expect(provider.generateVideo({ prompt: "x" }, context)).rejects.toMatchObject({
      code: "content_policy",
    });
  });

  it.each([
    [401, "authentication"],
    [429, "rate_limit"],
    [500, "provider_failure"],
  ])("maps HTTP %i", async (status, code) => {
    const { provider } = build(
      json({ error: { code: "x", message: "fake-key" } }, { status: Number(status) }),
    );
    const error = await provider.generateVideo({ prompt: "x" }, context).catch((e) => e);
    expect(error).toMatchObject({ code, message: `Media generation: ${code}` });
  });

  it("polls a task on a fresh instance through each state", async () => {
    const { provider, call } = build(
      json({ id: "cgt-1", status: "queued" }),
      json({ id: "cgt-1", status: "running" }),
      json({
        id: "cgt-1",
        status: "succeeded",
        content: { video_url: "https://ark-content.tos.example.test/v.mp4" },
      }),
      new Response(MP4),
      json({
        status: "failed",
        error: { code: "OutputVideoSensitiveContentDetected", message: "x" },
      }),
      json({ status: "expired", error: null }),
    );
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "queued" });
    expect(call(0).url).toBe(`${API}/cgt-1`);
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "running" });
    expect(await provider.pollVideo(jobId, context)).toEqual({
      id: jobId,
      status: "completed",
      output: { mimeType: "video/mp4", bytes: MP4 },
    });
    expect(call(3).headers.has("authorization")).toBe(false);
    expect(await provider.pollVideo(jobId, context)).toEqual({
      id: jobId,
      status: "failed",
      code: "content_policy",
    });
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "failed" });
  });

  it("rejects malformed answers and job ids", async () => {
    await expect(
      build(json({})).provider.generateVideo({ prompt: "x" }, context),
    ).rejects.toMatchObject({
      code: "provider_failure",
    });
    await expect(
      build(json({ status: "succeeded", content: {} })).provider.pollVideo(jobId, context),
    ).rejects.toMatchObject({ code: "provider_failure" });
    await expect(build().provider.pollVideo("{}", context)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
