import { ORPCError } from "@orpc/server";

/** The JSON object a voice route was sent; anything else reads as an empty body. */
export function parseVoiceRequestBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function decodeAudioBase64(value: string): Uint8Array {
  if (!value.trim()) throw new ORPCError("BAD_REQUEST", { message: "Recording is empty." });
  // Decoding skips what is not base64 rather than failing; an empty result is refused later.
  return new Uint8Array(Buffer.from(value, "base64"));
}
