import { describe, expect, it } from "vitest";
import {
  mediaContext as context,
  inputPng,
  json,
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

  it("refuses video, masks, Imagen and Veo", async () => {
    const { provider, fetch } = build();
    expect(provider.capabilities.video).toBe(false);
    await expect(provider.generateVideo({ prompt: "x" }, context)).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(
      provider.editImage?.({ prompt: "x", image: inputPng, mask: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    for (const model of ["imagen-4.0-generate-001", "veo-3.1-generate-preview"])
      await expect(provider.generateImage({ prompt: "x", model }, context)).rejects.toMatchObject({
        code: "unsupported",
      });
    expect(fetch).not.toHaveBeenCalled();
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
