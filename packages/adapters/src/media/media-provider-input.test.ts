import { describe, expect, it } from "vitest";
import { inputPng } from "./media-provider.test-support.js";
import type { MediaModelDescriptor } from "./media-provider-descriptor.js";
import {
  checkMediaInput,
  clampDuration,
  mediaCredentialSecret,
  nearestAspectRatio,
  nearestDuration,
  nearestQuality,
  nearestResolution,
  nearestSize,
  resolveMediaModel,
  sizeResolution,
} from "./media-provider-input.js";

const models: MediaModelDescriptor[] = [
  { id: "img", name: "Image", kind: "image", default: true, edit: true },
  { id: "vid", name: "Video", kind: "video", default: true, startFrame: true },
];

describe("media model choice", () => {
  it("takes the named or default model of the kind", () => {
    expect(resolveMediaModel(models, "image", undefined).id).toBe("img");
    expect(resolveMediaModel(models, "video", " vid ").id).toBe("vid");
    expect(() => resolveMediaModel(models, "image", "vid")).toThrow("unsupported");
    expect(() => resolveMediaModel(models, "image", "other")).toThrow("unsupported");
  });

  it("takes a custom model only when allowed and well formed", () => {
    expect(resolveMediaModel(models, "video", "owner/app", true)).toEqual({
      id: "owner/app",
      name: "owner/app",
      kind: "video",
    });
    expect(() => resolveMediaModel(models, "video", "../x", true)).toThrow("invalid_input");
    expect(() => resolveMediaModel(models, "video", "a b", true)).toThrow("invalid_input");
  });

  it("refuses inputs that change what is made", () => {
    const [image, video] = models as [MediaModelDescriptor, MediaModelDescriptor];
    expect(checkMediaInput(image, { prompt: " draw " }, "image")).toBe("draw");
    expect(() =>
      checkMediaInput(image, { prompt: "x", referenceImages: [inputPng] }, "image"),
    ).toThrow("unsupported");
    expect(() =>
      checkMediaInput(image, { prompt: "x", image: inputPng, mask: inputPng }, "edit"),
    ).toThrow("unsupported");
    expect(() => checkMediaInput(video, { prompt: "x", endFrame: inputPng }, "video")).toThrow(
      "unsupported",
    );
    expect(() => checkMediaInput(video, { prompt: "x", audio: true }, "video")).toThrow(
      "unsupported",
    );
    expect(
      checkMediaInput(video, { prompt: "x", audio: false, startFrame: inputPng }, "video"),
    ).toBe("x");
    expect(() => checkMediaInput(image, { prompt: "" }, "image")).toThrow("invalid_input");
  });
});

describe("media hints", () => {
  it("maps shapes, sizes and resolutions to the nearest allowed", () => {
    expect(nearestAspectRatio({ aspectRatio: "16:10" }, ["1:1", "3:2", "16:9"])).toBe("3:2");
    expect(nearestAspectRatio({ size: "1080x1920" }, ["1:1", "9:16", "auto"])).toBe("9:16");
    expect(nearestAspectRatio({}, ["1:1"])).toBeUndefined();
    expect(nearestSize({ aspectRatio: "16:9" }, ["1024x1024", "1536x1024", "1024x1536"])).toBe(
      "1536x1024",
    );
    expect(nearestSize({ size: "1024X1024" }, ["1024x1024"])).toBe("1024x1024");
    expect(nearestResolution("4k", ["480p", "720p", "1080p"])).toBe("1080p");
    expect(nearestResolution("2k", ["1K", "2K"])).toBe("2K");
    expect(nearestResolution("huge", ["720p"])).toBeUndefined();
    expect(sizeResolution("2048x1152", "k")).toBe("2.048k");
    expect(sizeResolution("1920x1080", "p")).toBe("1080p");
  });

  it("maps quality and length", () => {
    expect(nearestQuality("high", ["low", "medium"])).toBe("medium");
    expect(nearestQuality("auto", ["low", "medium"])).toBeUndefined();
    expect(nearestQuality("low", ["low"])).toBe("low");
    expect(clampDuration(40, { min: 4, max: 30 })).toBe(30);
    expect(clampDuration(2.4, { min: 1, max: 15 })).toBe(2);
    expect(nearestDuration(7, [5, 10])).toBe(5);
    expect(nearestDuration(undefined, [5])).toBeUndefined();
  });
});

describe("media credentials", () => {
  it("reads its own field or a borrowed connection it lists", () => {
    const sources = [{ provider: "p", auth: "api_key" as const }];
    expect(mediaCredentialSecret({ kind: "key", fields: { apiKey: " k " } }, "apiKey")).toBe("k");
    expect(
      mediaCredentialSecret(
        { kind: "model_connection", provider: "p", auth: "api_key", token: "t" },
        "apiKey",
        sources,
      ),
    ).toBe("t");
    expect(() =>
      mediaCredentialSecret(
        { kind: "model_connection", provider: "p", auth: "oauth", token: "t" },
        "apiKey",
        sources,
      ),
    ).toThrow("authentication");
    expect(() => mediaCredentialSecret({ kind: "key", fields: { apiKey: " " } }, "apiKey")).toThrow(
      "authentication",
    );
  });
});
