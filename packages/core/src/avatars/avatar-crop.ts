/** The square of a source image an uploaded avatar keeps, in source pixels. */
export interface AvatarCrop {
  /** 1 fits the image's short side; larger values zoom in. */
  zoom: number;
  /** Centre of the kept square. */
  x: number;
  y: number;
}

export const AVATAR_CROP_MAX_ZOOM = 4;

export function centeredAvatarCrop(image: { width: number; height: number }): AvatarCrop {
  return { zoom: 1, x: image.width / 2, y: image.height / 2 };
}

/** Keeps the zoom in range and the square inside the image. */
export function clampAvatarCrop(
  image: { width: number; height: number },
  crop: AvatarCrop,
): AvatarCrop {
  const zoom = Math.min(AVATAR_CROP_MAX_ZOOM, Math.max(1, crop.zoom));
  const half = Math.min(image.width, image.height) / zoom / 2;
  return {
    zoom,
    x: Math.min(image.width - half, Math.max(half, crop.x)),
    y: Math.min(image.height - half, Math.max(half, crop.y)),
  };
}

/** The kept square's top-left corner and side, ready for a canvas draw. */
export function avatarCropSquare(
  image: { width: number; height: number },
  crop: AvatarCrop,
): { left: number; top: number; side: number } {
  const clamped = clampAvatarCrop(image, crop);
  const side = Math.min(image.width, image.height) / clamped.zoom;
  return { left: clamped.x - side / 2, top: clamped.y - side / 2, side };
}
