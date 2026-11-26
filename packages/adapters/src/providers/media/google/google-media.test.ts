import { describe, expect, it } from "vitest";
import {
  mediaContext as context,
  inputPng,
  json,
  MP4,
  mediaFetch,
  PNG,
  pngBase64,
} from "../../../media/media-provider.test-support.js";
import { googleMedia } from "./google-media.js";

const key = { kind: "key", fields: { apiKey: "fake-key" } } as const;
const answer = (parts: unknown[], finishReason = "STOP") => ({
  candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }],
});
function build(...responses: Response[]) {
  const mocked = mediaFetch(...responses);
  return { ...mocked, provider: googleMedia.create(key, mocked.http) };
}

describe("Gemini media", () => {
  it("generates an image, skipping thought images", async () => {
    const { provider, call } = build(
      json(
        answer([
          { text: "Here it is" },
          { inlineData: { mimeType: "image/png", data: "AAAA" }, thought: true },
          { inlineData: { mimeType: "image/png", data: pngBase64 } },
        ]),
      ),
    );
    expect(
      await provider.generateImage(
        { prompt: "draw", aspectRatio: "16:9", size: "2048x1152" },
        context,
      ),
    ).toEqual({ mimeType: "image/png", bytes: PNG });
    expect(call(0).url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent",
    );
    expect(call(0).headers.get("x-goog-api-key")).toBe("fake-key");
    expect(call(0).url).not.toContain("key=");
    expect(call(0).json()).toEqual({
      contents: [{ role: "user", parts: [{ text: "draw" }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
      },
    });
  });

  it("edits with the source image first, then references", async () => {
    const { provider, call } = build(
      json(answer([{ inlineData: { mimeType: "image/png", data: pngBase64 } }])),
    );
    await provider.editImage?.(
      {
        prompt: "night",
        model: "gemini-3-pro-image",
        image: inputPng,
        referenceImages: [inputPng],
      },
      context,
    );
    expect(call(0).url).toContain("/models/gemini-3-pro-image:generateContent");
    const part = { inline_data: { mime_type: "image/png", data: pngBase64 } };
    expect(call(0).json()).toMatchObject({
      contents: [{ parts: [part, part, { text: "night" }] }],
    });
  });

  it.each([
    ["a blocked prompt", { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }],
    ["an image withheld for safety", answer([{ text: "no" }], "IMAGE_SAFETY")],
  ])("maps %s to the content policy", async (_case, body) => {
    await expect(
      build(json(body)).provider.generateImage({ prompt: "draw" }, context),
    ).rejects.toMatchObject({ code: "content_policy" });
  });

  it("fails an answer with no image", async () => {
    await expect(
      build(json(answer([{ text: "words only" }]))).provider.generateImage(
        { prompt: "x" },
        context,
      ),
    ).rejects.toMatchObject({ code: "provider_failure" });
  });

  it("refuses masks, Imagen and Veo", async () => {
    const { provider, fetch } = build();
    await expect(
      provider.editImage?.({ prompt: "x", image: inputPng, mask: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    for (const model of ["imagen-4.0-generate-001", "veo-3.1-generate-preview"])
      await expect(provider.generateImage({ prompt: "x", model }, context)).rejects.toMatchObject({
        code: "unsupported",
      });
    await expect(
      provider.generateVideo({ prompt: "x", model: "veo-3.1-generate-preview" }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    // Omni always makes sound, and interpolates only from a first frame.
    await expect(
      provider.generateVideo({ prompt: "x", audio: false }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateVideo({ prompt: "x", endFrame: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("makes a video through an interaction and polls its file", async () => {
    const fileUri =
      "https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media";
    const { provider, call } = build(
      json({
        id: "v1_1",
        status: "completed",
        steps: [
          { type: "user_input", content: [{ type: "text", text: "move" }] },
          {
            type: "model_output",
            content: [{ type: "video", mime_type: "video/mp4", uri: fileUri }],
          },
        ],
      }),
      json({ name: "files/abc-123", state: "PROCESSING" }),
      json({ name: "files/abc-123", state: "ACTIVE" }),
      new Response(null, {
        status: 302,
        headers: { location: "https://storage.example.test/v.mp4" },
      }),
      new Response(MP4),
    );
    const job = await provider.generateVideo(
      {
        prompt: "move",
        startFrame: inputPng,
        endFrame: inputPng,
        durationSeconds: 14,
        aspectRatio: "9:16",
        resolution: "4k",
      },
      context,
    );
    expect(job).toEqual({ id: JSON.stringify({ file: "abc-123" }), status: "queued" });
    expect(call(0).url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(call(0).headers.get("x-goog-api-key")).toBe("fake-key");
    expect(call(0).json()).toEqual({
      model: "gemini-omni-1.2-flash",
      input: [
        { type: "image", data: pngBase64, mime_type: "image/png" },
        { type: "image", data: pngBase64, mime_type: "image/png" },
        { type: "text", text: "move" },
      ],
      // Two frames make at most ten seconds.
      response_format: {
        type: "video",
        delivery: "uri",
        aspect_ratio: "9:16",
        resolution: "1080p",
        duration: "10s",
      },
    });
    expect(await provider.pollVideo(job.id, context)).toEqual({ id: job.id, status: "running" });
    expect(call(1).url).toBe("https://generativelanguage.googleapis.com/v1beta/files/abc-123");
    expect(await provider.pollVideo(job.id, context)).toEqual({
      id: job.id,
      status: "completed",
      output: { mimeType: "video/mp4", bytes: MP4 },
    });
    expect(call(3).url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media",
    );
    // The storage link it redirects to is fetched without the key.
    expect(call(4).url).toBe("https://storage.example.test/v.mp4");
    expect(call(4).headers.get("x-goog-api-key")).toBeNull();
  });

  it("fails a video whose file failed, and an answer with no video", async () => {
    const id = JSON.stringify({ file: "abc-123" });
    const failed = build(json({ state: "FAILED" }));
    expect(await failed.provider.pollVideo(id, context)).toEqual({ id, status: "failed" });
    const empty = build(json({ status: "completed", steps: [] }));
    await expect(empty.provider.generateVideo({ prompt: "x" }, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
    await expect(failed.provider.pollVideo("not-json", context)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it.each([
    [400, "provider_failure"],
    [403, "authentication"],
    [429, "rate_limit"],
  ])("maps HTTP %i", async (status, code) => {
    const { provider } = build(
      json(
        { error: { code: status, message: "fake-key", status: "X" } },
        { status: Number(status) },
      ),
    );
    const error = await provider.generateImage({ prompt: "x" }, context).catch((e) => e);
    expect(error).toMatchObject({ code, message: `Media generation: ${code}` });
  });
});
