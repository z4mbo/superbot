import { describe, expect, it } from "vitest";
import {
  mediaContext as context,
  inputPng,
  json,
  MP4,
  mediaFetch,
  PNG,
} from "../../../media/media-provider.test-support.js";
import { higgsfieldMedia } from "./higgsfield-media.js";

const key = { kind: "key", fields: { keyId: "key-id", keySecret: "key-secret" } } as const;
const jobId = JSON.stringify({ request: "req-1" });
const queued = {
  status: "queued",
  request_id: "req-1",
  status_url: "https://api.higgsfield.ai/requests/req-1/status",
};
function build(...responses: Response[]) {
  const mocked = mediaFetch(...responses);
  return { ...mocked, provider: higgsfieldMedia.create(key, mocked.http) };
}

describe("Higgsfield media", () => {
  it("submits an image, polls it and downloads it without the key", async () => {
    const { provider, call } = build(
      json(queued),
      json({
        status: "completed",
        request_id: "req-1",
        images: [{ url: "https://cdn.example.test/i.jpg" }],
      }),
      new Response(PNG),
    );
    expect(
      await provider.generateImage(
        { prompt: "draw", aspectRatio: "16:9", size: "1920x1080" },
        context,
      ),
    ).toEqual({ mimeType: "image/png", bytes: PNG });
    expect(call(0).url).toBe("https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard");
    expect(call(0).headers.get("authorization")).toBe("Key key-id:key-secret");
    expect(call(0).headers.get("idempotency-key")).toMatch(/^[0-9a-f]{64}$/);
    expect(call(0).json()).toEqual({
      prompt: "draw",
      batch_size: 1,
      aspect_ratio: "16:9",
      resolution: "1080p",
    });
    expect(call(1).url).toBe("https://api.higgsfield.ai/requests/req-1/status");
    expect(call(2).headers.has("authorization")).toBe(false);
  });

  it("keys a repeated submission in one operation the same, and a different one apart", async () => {
    const { provider, call } = build(json(queued), json(queued), json(queued));
    await provider.generateVideo({ prompt: "move" }, context);
    await provider.generateVideo({ prompt: "move" }, context);
    await provider.generateVideo({ prompt: "other" }, context);
    expect(call(0).headers.get("idempotency-key")).toBe(call(1).headers.get("idempotency-key"));
    expect(call(0).headers.get("idempotency-key")).not.toBe(call(2).headers.get("idempotency-key"));
  });

  it("maps an image refused as nsfw", async () => {
    const { provider } = build(json(queued), json({ status: "nsfw", request_id: "req-1" }));
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toMatchObject({
      code: "content_policy",
    });
  });

  it("submits a video and polls it on a fresh instance", async () => {
    const {
      provider: submitter,
      call,
      http,
    } = build(
      json(queued),
      json({ status: "in_progress", request_id: "req-1" }),
      json({
        status: "completed",
        request_id: "req-1",
        video: { url: "https://cdn.example.test/v.mp4" },
      }),
      new Response(MP4),
      json({ status: "nsfw", request_id: "req-1" }),
      json({ status: "failed", request_id: "req-1", error: "private" }),
    );
    expect(await submitter.generateVideo({ prompt: "move", durationSeconds: 8 }, context)).toEqual({
      id: jobId,
      status: "queued",
    });
    expect(call(0).url).toBe("https://api.higgsfield.ai/kling-video/v2.5-turbo/pro/text-to-video");
    expect(call(0).json()).toEqual({ prompt: "move", duration: 10 });
    // The poll runs on a provider built again from the same credential.
    const provider = higgsfieldMedia.create(key, http);
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "running" });
    expect(await provider.pollVideo(jobId, context)).toEqual({
      id: jobId,
      status: "completed",
      output: { mimeType: "video/mp4", bytes: MP4 },
    });
    expect(await provider.pollVideo(jobId, context)).toEqual({
      id: jobId,
      status: "failed",
      code: "content_policy",
    });
    expect(await provider.pollVideo(jobId, context)).toEqual({ id: jobId, status: "failed" });
  });

  it("refuses image inputs, which need an upload this adapter does not make", async () => {
    const { provider, fetch } = build();
    await expect(
      provider.generateVideo({ prompt: "x", startFrame: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateImage({ prompt: "x", referenceImages: [inputPng] }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(provider.capabilities.imageEdit).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [429, "rate_limit"],
    [422, "provider_failure"],
  ])("maps HTTP %i", async (status, code) => {
    const { provider } = build(json({ detail: "key-secret" }, { status: Number(status) }));
    const error = await provider.generateVideo({ prompt: "x" }, context).catch((e) => e);
    expect(error).toMatchObject({ code, message: `Media generation: ${code}` });
  });

  it("needs both key parts", () => {
    expect(() => higgsfieldMedia.create({ kind: "key", fields: { keyId: "id" } }, {})).toThrow(
      "authentication",
    );
  });
});
