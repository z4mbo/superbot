import * as ImagePicker from "expo-image-picker";
import { loadImageManipulator } from "../../lib/composer/pick-attachments";

const AVATAR_PHOTO_SIZE = 256;

/** False on binaries that cannot shrink a photo, which would make it too large to save. */
export function canPickAvatarPhoto(): boolean {
  return loadImageManipulator() !== null;
}

/**
 * Picks a photo, lets the system crop it square, and returns it as the small webp data URL a bot
 * avatar stores. Null when the user cancels.
 */
export async function pickAvatarPhoto(): Promise<string | null> {
  const manipulator = loadImageManipulator();
  if (!manipulator) return null;
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  const side = Math.min(asset.width, asset.height);
  const image = await manipulator.ImageManipulator.manipulate(asset.uri)
    .crop({
      originX: (asset.width - side) / 2,
      originY: (asset.height - side) / 2,
      width: side,
      height: side,
    })
    .resize({ width: AVATAR_PHOTO_SIZE, height: AVATAR_PHOTO_SIZE })
    .renderAsync();
  const saved = await image.saveAsync({
    format: manipulator.SaveFormat.WEBP,
    compress: 0.9,
    base64: true,
  });
  return saved.base64 ? `data:image/webp;base64,${saved.base64}` : null;
}
