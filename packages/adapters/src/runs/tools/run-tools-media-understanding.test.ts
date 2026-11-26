import { SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MediaTooLargeError } from "../../media/understanding/media-analysis.js";
import { mediaUnderstandingTools, runMediaReaders } from "./run-tools-media-understanding.js";

// A stopped computer's snapshot is read beside the workspace tools; here every computer is running.
vi.mock("./run-stopped-file.js", () => ({ readStoppedRunFile: vi.fn(async () => undefined) }));

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

function context(options: { carried?: boolean; readFile?: () => Promise<Uint8Array> } = {}) {
  const artifactFind = vi.fn(async () => ({
    name: "photo.png",
    size: PNG.byteLength,
    storageKey: "k",
  }));
  const messageFind = vi.fn(async () => (options.carried === false ? null : { id: "message-1" }));
  const readFile = vi.fn(options.readFile ?? (async () => PNG));
  const get = vi.fn(async () => PNG);
  const finish = vi.fn((result: unknown) => result);
  const ctx = {
    deps: {
      prisma: { artifact: { findFirst: artifactFind }, message: { findFirst: messageFind } },
      artifacts: { get },
      sandbox: { readFile },
    },
    run: { id: "run-1", spaceId: "space-1" },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    source: { conversationThreadId: "conversation-1" },
    context: { signal: new AbortController().signal },
    computer: { mode: "private", get: vi.fn(async () => ({ id: "computer-1" })) },
    providers: { mediaAnalyzers: {} },
    secrets: [],
  };
  const call = { name: "vision_analyze", args: {}, finish };
  return { ctx, call, artifactFind, messageFind, readFile, get, finish };
}

describe("runMediaReaders", () => {
  it("reads an attachment only when a message of this conversation carries it as a file", async () => {
    const { ctx, call, messageFind, get } = context();
    const readers = runMediaReaders(ctx as never, call as never);
    await expect(readers.attachment("art_1", 1_000)).resolves.toEqual({
      name: "photo.png",
      data: PNG,
    });
    expect(messageFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "conversation-1",
          OR: [
            { blocks: { array_contains: [{ kind: "image", artifactId: "art_1" }] } },
            { blocks: { array_contains: [{ kind: "file", artifactId: "art_1" }] } },
          ],
        },
      }),
    );
    expect(get).toHaveBeenCalledWith("k", ctx.context);
  });

  it("refuses an attachment from another conversation without reading it", async () => {
    const { ctx, call, get } = context({ carried: false });
    const readers = runMediaReaders(ctx as never, call as never);
    await expect(readers.attachment("art_1", 1_000)).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses an attachment larger than the cap before reading it", async () => {
    const { ctx, call, get } = context();
    const readers = runMediaReaders(ctx as never, call as never);
    await expect(readers.attachment("art_1", 4)).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(get).not.toHaveBeenCalled();
  });

  it("reads a workspace file from the bot's own computer with the cap", async () => {
    const { ctx, call, readFile } = context();
    const readers = runMediaReaders(ctx as never, call as never);
    await expect(readers.workspace("photos/cat.png", 1_000)).resolves.toBe(PNG);
    expect(readFile).toHaveBeenCalledWith({ id: "computer-1" }, "photos/cat.png", ctx.context, {
      maxBytes: 1_000,
    });
  });

  it("reports a workspace file over the cap as too large", async () => {
    const { ctx, call } = context({
      readFile: async () => {
        throw new SandboxFileTooLargeError(1_000);
      },
    });
    const readers = runMediaReaders(ctx as never, call as never);
    await expect(readers.workspace("photos/cat.png", 1_000)).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );
  });
});

describe("mediaUnderstandingTools", () => {
  it("says plainly that no connected model reads the media, and reads nothing", async () => {
    for (const [name, kind] of [
      ["vision_analyze", "images"],
      ["video_analyze", "video"],
    ] as const) {
      const { ctx, call, readFile, finish } = context();
      await mediaUnderstandingTools[name]!(
        ctx as never,
        {
          ...call,
          name,
          args: { path: "photos/cat.png" },
        } as never,
      );
      expect(finish).toHaveBeenCalledWith({
        error: expect.stringMatching(new RegExp(`^No connected model can read ${kind}`)),
      });
      expect(readFile).not.toHaveBeenCalled();
    }
  });
});
