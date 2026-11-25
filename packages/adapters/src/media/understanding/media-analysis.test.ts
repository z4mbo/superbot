import { describe, expect, it, vi } from "vitest";
import type { MediaAnalyzer, MediaSourceReaders } from "./media-analysis.js";
import {
  analyzeMediaFromTool,
  fetchMediaUrl,
  MEDIA_ANALYSIS_MAX_CHARS,
  MEDIA_MAX_BYTES,
  MediaTooLargeError,
} from "./media-analysis.js";
import { sniffMedia } from "./media-sniff.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const MP4 = Uint8Array.from([
  0,
  0,
  0,
  0x18,
  ...new TextEncoder().encode("ftypisom"),
  0,
  0,
  2,
  0,
  0x69,
  0x73,
  0x6f,
  0x6d,
]);
const TEXT = new TextEncoder().encode("just some notes, not an image");

function fakeReaders(data: Uint8Array = PNG) {
  return {
    workspace: vi.fn(async () => data),
    attachment: vi.fn(async () => ({ name: "photo.png", data })),
    url: vi.fn(async () => data),
  } satisfies MediaSourceReaders;
}

function fakeAnalyzer(answer = "Summary: a red square.\nVisible text: none") {
  const analyze = vi.fn<MediaAnalyzer["analyze"]>(async () => answer);
  return { analyze };
}

function run(
  options: Partial<Parameters<typeof analyzeMediaFromTool>[0]> & {
    args: Record<string, unknown>;
  },
) {
  return analyzeMediaFromTool({
    modality: "image",
    analyzer: fakeAnalyzer(),
    readers: fakeReaders(),
    signal: new AbortController().signal,
    secrets: [],
    ...options,
  });
}

describe("sniffMedia", () => {
  it("identifies media from its bytes, not its name", () => {
    expect(sniffMedia(PNG)).toEqual({ modality: "image", mimeType: "image/png" });
    expect(sniffMedia(MP4)).toEqual({ modality: "video", mimeType: "video/mp4" });
    expect(sniffMedia(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0]))).toEqual({
      modality: "video",
      mimeType: "video/webm",
    });
    expect(sniffMedia(TEXT)).toBeUndefined();
    // A HEIF still shares the video container.
    const heic = MP4.slice();
    heic.set(new TextEncoder().encode("heic"), 8);
    expect(sniffMedia(heic)).toBeUndefined();
  });
});

describe("vision_analyze", () => {
  it("reads a workspace file and returns the model's text", async () => {
    const readers = fakeReaders();
    const analyzer = fakeAnalyzer();
    const result = await run({
      args: { path: "charts/q3.png", question: "What trend?" },
      readers,
      analyzer,
    });
    expect(result).toEqual({
      analysis: "Summary: a red square.\nVisible text: none",
      source: "path charts/q3.png",
    });
    expect(readers.workspace).toHaveBeenCalledWith("charts/q3.png", MEDIA_MAX_BYTES.image);
    expect(analyzer.analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        modality: "image",
        mimeType: "image/png",
        name: "q3.png",
        data: PNG,
        question: "What trend?",
      }),
      expect.any(AbortSignal),
    );
  });

  it("reads an attachment of this conversation by its listed path", async () => {
    const readers = fakeReaders();
    const result = await run({ args: { attachment: "attachments/art_123.png" }, readers });
    expect(result).toMatchObject({ analysis: expect.stringContaining("red square") });
    expect(readers.attachment).toHaveBeenCalledWith("art_123", MEDIA_MAX_BYTES.image);
  });

  it("refuses an attachment the conversation does not carry", async () => {
    const readers = { ...fakeReaders(), attachment: vi.fn(async () => undefined) };
    const analyzer = fakeAnalyzer();
    expect(await run({ args: { attachment: "art_999" }, readers, analyzer })).toEqual({
      error: "That attachment is not in this conversation.",
      source: "attachment art_999",
    });
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });

  it("reads an https URL and never names it in the result", async () => {
    const readers = fakeReaders();
    const result = await run({ args: { url: "https://example.com/a/cat.png?token=abc" }, readers });
    expect(result).toMatchObject({ source: "url" });
    expect(readers.url).toHaveBeenCalledWith(
      "https://example.com/a/cat.png?token=abc",
      MEDIA_MAX_BYTES.image,
      expect.any(AbortSignal),
    );
  });

  it("says plainly when no connected model reads images, without reading or sending anything", async () => {
    const readers = fakeReaders();
    const result = await run({ args: { path: "photo.png" }, readers, analyzer: undefined });
    expect(result).toEqual({
      error:
        "No connected model can read images, so this image was not analyzed. Connect one in Settings → Models.",
    });
    expect(readers.workspace).not.toHaveBeenCalled();
  });

  it("needs exactly one source", async () => {
    const analyzer = fakeAnalyzer();
    for (const args of [{}, { path: "a.png", url: "https://example.com/a.png" }, { path: "  " }])
      expect(await run({ args, analyzer })).toEqual({
        error: "Give exactly one of path, attachment or url.",
      });
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });

  it("refuses a path that climbs out of the workspace", async () => {
    const readers = fakeReaders();
    for (const path of ["../other-bot/secret.png", "photos/../../etc/x.png", "a\\..\\b.png"])
      expect(await run({ args: { path }, readers })).toMatchObject({
        error: "path must stay inside the workspace",
      });
    expect(readers.workspace).not.toHaveBeenCalled();
  });

  it("rejects an oversize file with a clear message", async () => {
    const readers = {
      ...fakeReaders(),
      workspace: vi.fn(async () => {
        throw new MediaTooLargeError();
      }),
    };
    const analyzer = fakeAnalyzer();
    expect(await run({ args: { path: "huge.png" }, readers, analyzer })).toEqual({
      error: "The image is larger than 10 MB.",
      source: "path huge.png",
    });
    // A reader that ignored its cap is still refused.
    const big = new Uint8Array(MEDIA_MAX_BYTES.image + 1);
    big.set(PNG);
    expect(await run({ args: { path: "big.png" }, readers: fakeReaders(big), analyzer })).toEqual({
      error: "The image is too large.",
      source: "path big.png",
    });
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });

  it("refuses anything that is not an image, whatever its name says", async () => {
    const analyzer = fakeAnalyzer();
    for (const data of [TEXT, MP4])
      expect(
        await run({ args: { path: "fake.png" }, readers: fakeReaders(data), analyzer }),
      ).toEqual({
        error: "Not a supported image (PNG, JPEG, GIF or WebP).",
        source: "path fake.png",
      });
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });

  it("refuses a URL that is not https or that fetching blocks", async () => {
    const analyzer = fakeAnalyzer();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const readers = {
      ...fakeReaders(),
      url: (url: string, maxBytes: number, signal: AbortSignal) =>
        fetchMediaUrl(url, maxBytes, signal, {
          fetch,
          resolveHostname: async () => [{ address: "10.0.0.5", family: 4 }],
        }),
    };
    expect(await run({ args: { url: "http://example.com/a.png" }, readers, analyzer })).toEqual({
      error: "url must be an https URL",
      source: "url",
    });
    for (const url of ["https://internal.example/a.png", "https://169.254.169.254/latest"])
      expect(await run({ args: { url }, readers, analyzer })).toEqual({
        error: "Could not fetch that URL. Only public https addresses can be read.",
        source: "url",
      });
    expect(fetch).not.toHaveBeenCalled();
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });

  it("caps the analysis it returns", async () => {
    const result = await run({
      args: { path: "photo.png" },
      analyzer: fakeAnalyzer("x".repeat(MEDIA_ANALYSIS_MAX_CHARS * 3)),
    });
    expect(result).toMatchObject({ truncated: true });
    expect("analysis" in result && result.analysis.length).toBe(MEDIA_ANALYSIS_MAX_CHARS);
  });

  it("never returns a provider error body or a credential", async () => {
    const analyzer = {
      analyze: vi.fn(async () => {
        throw new Error('401 {"error":"invalid key sk-live-SECRET","request":"req_42"}');
      }),
    };
    const failed = await run({
      args: { path: "photo.png" },
      analyzer,
      secrets: ["sk-live-SECRET"],
    });
    expect(failed).toEqual({
      error: "The image could not be analyzed. Try again later.",
      source: "path photo.png",
    });
    expect(JSON.stringify(failed)).not.toMatch(/SECRET|req_42|401/);

    const echoed = await run({
      args: { path: "photo.png" },
      analyzer: fakeAnalyzer("Visible text: sk-live-SECRET"),
      secrets: ["sk-live-SECRET"],
    });
    expect(JSON.stringify(echoed)).not.toContain("sk-live-SECRET");
  });
});

describe("video_analyze", () => {
  it("analyzes a video with a model that reads video", async () => {
    const analyzer = fakeAnalyzer("Timeline: a cat jumps.\nTranscript: no audio");
    const readers = fakeReaders(MP4);
    const result = await run({ modality: "video", args: { path: "clip.mp4" }, analyzer, readers });
    expect(result).toEqual({
      analysis: "Timeline: a cat jumps.\nTranscript: no audio",
      source: "path clip.mp4",
    });
    expect(readers.workspace).toHaveBeenCalledWith("clip.mp4", MEDIA_MAX_BYTES.video);
    expect(analyzer.analyze).toHaveBeenCalledWith(
      expect.objectContaining({ modality: "video", mimeType: "video/mp4" }),
      expect.any(AbortSignal),
    );
  });

  it("says so when no connected model reads video", async () => {
    const readers = fakeReaders(MP4);
    expect(
      await run({ modality: "video", args: { path: "clip.mp4" }, analyzer: undefined, readers }),
    ).toEqual({
      error:
        "No connected model can read video, so this video was not analyzed. Connect one in Settings → Models.",
    });
    expect(readers.workspace).not.toHaveBeenCalled();
  });

  it("refuses an image passed as a video", async () => {
    const analyzer = fakeAnalyzer();
    expect(
      await run({
        modality: "video",
        args: { path: "clip.mp4" },
        analyzer,
        readers: fakeReaders(),
      }),
    ).toEqual({ error: "Not a supported video (MP4, MOV or WebM).", source: "path clip.mp4" });
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });
});

describe("fetchMediaUrl", () => {
  it("fetches public https media without sending credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(PNG));
    const body = await fetchMediaUrl(
      "https://cdn.example.com/cat.png",
      MEDIA_MAX_BYTES.image,
      new AbortController().signal,
      { fetch, resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }] },
    );
    expect(body).toEqual(PNG);
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(new Headers(init?.headers).get("cookie")).toBeNull();
  });
});
