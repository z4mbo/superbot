import { describe, expect, it } from "vitest";
import { avatarCropSquare, centeredAvatarCrop, clampAvatarCrop } from "./avatar-crop.js";

const landscape = { width: 400, height: 200 };

describe("avatar crop", () => {
  it("starts on the centred square of the short side", () => {
    expect(avatarCropSquare(landscape, centeredAvatarCrop(landscape))).toEqual({
      left: 100,
      top: 0,
      side: 200,
    });
  });

  it("zooms around the chosen centre", () => {
    expect(avatarCropSquare(landscape, { zoom: 2, x: 300, y: 100 })).toEqual({
      left: 250,
      top: 50,
      side: 100,
    });
  });

  it("keeps the square inside the image and the zoom in range", () => {
    expect(clampAvatarCrop(landscape, { zoom: 9, x: -50, y: 999 })).toEqual({
      zoom: 4,
      x: 25,
      y: 175,
    });
    expect(clampAvatarCrop(landscape, { zoom: 0.2, x: 0, y: 0 })).toEqual({
      zoom: 1,
      x: 100,
      y: 100,
    });
  });
});
