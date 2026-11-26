import { MediaGenerationError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  mediaContext as context,
  inputPng,
  json,
  MP4,
  mediaFetch,
  PNG,
  pngBase64,
} from "./media-provider.test-support.js";
import {
  checkedInputImage,
  decodeBase64Image,
  decodeMediaJob,
  downloadMediaOutput,
  encodeMediaJob,
  mediaRequestJson,
  waitForMediaJob,
} from "./media-provider-http.js";

describe("media provider requests", () => {
  it("sends JSON without following redirects and parses the answer", async () => {
    const { http, call } = mediaFetch(json({ ok: true }));
    expect(
      await mediaRequestJson(
        "https://api.example.test/x",
        { headers: { Authorization: "Bearer k" }, json: { a: 1 } },
        http,
        context,
      ),
    ).toEqual({ ok: true });
    expect(call(0).method).toBe("POST");
    expect(call(0).headers.get("content-type")).toBe("application/json");
    expect(http.fetch.mock.calls[0]![1]!.redirect).toBe("error");
    expect(http.fetch.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("classifies a refusal from its body without repeating it", async () => {
    const { http } = mediaFetch(json({ reason: "policy", secret: "fake-key" }, { status: 400 }));
    const isPolicyRefusal = vi.fn((_status: number, body: unknown) => {
      return (body as { reason?: string }).reason === "policy";
    });
    const error = await mediaRequestJson(
      "https://api.example.test/x",
      { json: {}, isPolicyRefusal },
      http,
      context,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaGenerationError);
    expect(error).toMatchObject({
      code: "content_policy",
      message: "Media generation: content_policy",
    });
    expect(isPolicyRefusal).toHaveBeenCalledWith(400, { reason: "policy", secret: "fake-key" });
  });

  it("stops at the body limit", async () => {
    const { http } = mediaFetch(new Response(new Uint8Array(2048)));
    await expect(
      mediaRequestJson("https://api.example.test/x", { maxBytes: 1024 }, http, context),
    ).rejects.toMatchObject({ code: "output_limit" });
  });

  it("keeps cancellation as the caller's own reason", async () => {
    const controller = new AbortController();
    const { http, fetch } = mediaFetch();
    fetch.mockImplementationOnce(async () => {
      controller.abort(new Error("stopped"));
      throw new Error("aborted with fake-key");
    });
    await expect(
      mediaRequestJson("https://api.example.test/x", {}, http, {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toThrow("stopped");
  });
});

describe("media provider outputs", () => {
  it("decodes inline images by their bytes", () => {
    expect(decodeBase64Image(pngBase64)).toEqual({ mimeType: "image/png", bytes: PNG });
    expect(() => decodeBase64Image(Buffer.from("text").toString("base64"))).toThrow(
      "provider_failure",
    );
  });

  it("downloads without credentials and reads a video by its bytes", async () => {
    const { http, call } = mediaFetch(new Response(MP4), new Response(PNG));
    expect(await downloadMediaOutput("https://cdn.example.test/v", "video", http, context)).toEqual(
      { mimeType: "video/mp4", bytes: MP4 },
    );
    expect(call(0).headers.has("authorization")).toBe(false);
    await expect(
      downloadMediaOutput("https://cdn.example.test/v", "video", http, context),
    ).rejects.toMatchObject({ code: "provider_failure" });
  });

  it("refuses a private output host before any request", async () => {
    const { fetch } = mediaFetch();
    await expect(
      downloadMediaOutput(
        "https://cdn.example.test/v",
        "image",
        { fetch, resolveHostname: async () => [{ address: "10.0.0.1", family: 4 }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "provider_failure" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("media provider inputs and jobs", () => {
  it("checks an input image is what it says", () => {
    expect(checkedInputImage(inputPng)).toBe(inputPng);
    expect(() => checkedInputImage({ bytes: PNG, mimeType: "image/webp" })).toThrow(
      "invalid_input",
    );
    expect(() => checkedInputImage({ bytes: new Uint8Array(), mimeType: "image/png" })).toThrow(
      "invalid_input",
    );
  });

  it("round-trips a job id and refuses anything else", () => {
    const schema = z.object({ task: z.string() });
    expect(decodeMediaJob(schema, encodeMediaJob({ task: "t1" }))).toEqual({ task: "t1" });
    expect(() => decodeMediaJob(schema, "{")).toThrow("invalid_input");
    expect(() => decodeMediaJob(schema, "{}")).toThrow("invalid_input");
  });

  it("gives up on a queued image at the deadline", async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn(async () => undefined);
      const waiting = waitForMediaJob(check, new AbortController().signal, context);
      const settled = expect(waiting).rejects.toMatchObject({ code: "provider_failure" });
      await vi.advanceTimersByTimeAsync(200_000);
      await settled;
      expect(check.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
