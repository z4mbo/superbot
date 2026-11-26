import type { AgentInputImage } from "@rakazo/adapter-kit";
import { detectImageMimeType } from "../image-mime-type.js";

export type SniffedMedia =
  | { modality: "image"; mimeType: AgentInputImage["mimeType"] }
  | { modality: "video"; mimeType: "video/mp4" | "video/quicktime" | "video/webm" };

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/**
 * What a file is, read from its first bytes; its name and any declared type are never trusted.
 * Undefined for anything that is not a supported image or video.
 */
export function sniffMedia(bytes: Uint8Array): SniffedMedia | undefined {
  const image = detectImageMimeType(bytes);
  if (image) return { modality: "image", mimeType: image };
  // ISO base media: a box size, then "ftyp" and the major brand.
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    // HEIF and AVIF stills share the container but are not video.
    if (/^(heic|heix|heim|heis|hevc|hevm|hevs|mif1|msf1|avif|avis)$/.test(brand)) return undefined;
    return { modality: "video", mimeType: brand === "qt  " ? "video/quicktime" : "video/mp4" };
  }
  // Matroska / WebM: the EBML header.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return { modality: "video", mimeType: "video/webm" };
  return undefined;
}
