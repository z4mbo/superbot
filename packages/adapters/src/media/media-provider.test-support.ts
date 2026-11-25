import type { AdapterContext, MediaInputImage } from "@rakazo/adapter-kit";
import { vi } from "vitest";
import { FAKE_VIDEO_BASE64 } from "./fake-media-assets.js";

export const mediaContext: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  operationId: "op",
  traceId: "trace",
  signal: new AbortController().signal,
};
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
export const MP4 = new Uint8Array(Buffer.from(FAKE_VIDEO_BASE64, "base64"));
export const pngBase64 = Buffer.from(PNG).toString("base64");
export const inputPng: MediaInputImage = { bytes: PNG, mimeType: "image/png" };
export const inputJpeg: MediaInputImage = { bytes: JPEG, mimeType: "image/jpeg" };
export const pngDataUrl = `data:image/png;base64,${pngBase64}`;
export const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), init);
/** A public address for every host, so output downloads pass the SSRF check offline. */
export const publicHost = async () => [{ address: "93.184.216.34", family: 4 as const }];

/** A mocked fetch answering each call with the next response, and the calls it saw. */
export function mediaFetch(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const call = (index: number) => {
    const [url, init] = fetch.mock.calls[index]!;
    return {
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      json: () => JSON.parse(init?.body as string) as Record<string, unknown>,
      body: init?.body,
    };
  };
  return { fetch, call, http: { fetch, resolveHostname: publicHost } };
}
