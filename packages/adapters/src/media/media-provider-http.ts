import type {
  AdapterContext,
  GeneratedMedia,
  MediaImageMimeType,
  MediaInputImage,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BASE64_LENGTH, ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { cancelResponseBody, deadlineSignal, pollUntil, ResponseTooLargeError } from "@rakazo/core";
import { z } from "zod";
import type { ResolveHostname } from "../web/web-ssrf.js";
import { fetchSafeWebBytes, readBodyCapped } from "../web/web-ssrf.js";
import { detectImageMimeType } from "./image-mime-type.js";

export const mediaPromptSchema = z.object({ prompt: z.string().trim().min(1).max(4000) });
/** The image formats a generated image may arrive in; anything else is refused. */
export const GENERATED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set<GeneratedMedia["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
export function validateGeneratedMedia(output: GeneratedMedia, kind: "image" | "video") {
  const supported =
    kind === "video"
      ? output.mimeType === "video/mp4"
      : GENERATED_IMAGE_MIME_TYPES.has(output.mimeType);
  if (!supported || !output.bytes.byteLength) {
    throw new MediaGenerationError("provider_failure");
  }
  if (output.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new MediaGenerationError("output_limit");
  }
}

/** What every adapter is built with besides its credential. */
export interface MediaHttpOptions {
  fetch?: typeof fetch;
  resolveHostname?: ResolveHostname;
}

/** How long one API call (not the whole generation) may take. */
export const MEDIA_REQUEST_TIMEOUT_MS = 30_000;
/** How long a synchronous image generation may take, polling included. */
export const MEDIA_IMAGE_DEADLINE_MS = 180_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const ERROR_BODY_BYTES = 16 * 1024;
const JSON_BODY_BYTES = 256 * 1024;
/**
 * One base64 image at the attachment limit, allowing a CRLF after every 64 characters (servers
 * wrap lines and JSON escapes each break to four bytes; the decoded size is the real limit), plus
 * room for the JSON around it.
 */
export const MEDIA_INLINE_RESPONSE_BYTES =
  Math.ceil(ATTACHMENT_MAX_BASE64_LENGTH * (1 + 4 / 64)) + 64 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export interface MediaRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Sent as a JSON body. */
  json?: unknown;
  /** Sent as a multipart body. */
  form?: FormData;
  /** The call's signal; a {@link MEDIA_REQUEST_TIMEOUT_MS} deadline under the context's when absent. */
  signal?: AbortSignal;
  /** Largest successful body read; error bodies are read only to classify them. */
  maxBytes?: number;
  /**
   * Whether a refused request was refused for what it asked to make. It reads the error body,
   * which never leaves the helper: not in an error, a message or a log.
   */
  isPolicyRefusal?: (status: number, body: unknown) => boolean;
}

/**
 * One API call. No redirects, a capped body, and every failure turned into a
 * {@link MediaGenerationError} whose message carries only its code, never a body, URL or key.
 */
export async function mediaRequestBytes(
  url: string,
  request: MediaRequest,
  http: MediaHttpOptions,
  context: AdapterContext,
): Promise<Uint8Array> {
  context.signal.throwIfAborted();
  const signal = request.signal ?? deadlineSignal(MEDIA_REQUEST_TIMEOUT_MS, context.signal);
  try {
    const response = await (http.fetch ?? fetch)(url, {
      method: request.method ?? (request.json !== undefined || request.form ? "POST" : "GET"),
      headers: {
        ...request.headers,
        ...(request.json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: request.json !== undefined ? JSON.stringify(request.json) : request.form,
      signal,
      redirect: "error",
    });
    if (!response.ok) throw await refusal(response, request, signal);
    return await readBodyCapped(response, request.maxBytes ?? JSON_BODY_BYTES, signal);
  } catch (error) {
    throw mediaFailure(error, context);
  }
}

/** {@link mediaRequestBytes} for a JSON answer. */
export async function mediaRequestJson(
  url: string,
  request: MediaRequest,
  http: MediaHttpOptions,
  context: AdapterContext,
): Promise<unknown> {
  const bytes = await mediaRequestBytes(url, request, http, context);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new MediaGenerationError("provider_failure");
  }
}

/** Parses an answer with `schema`, failing as the provider's fault when it does not fit. */
export function parseMediaResponse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MediaGenerationError("provider_failure");
  return parsed.data;
}

async function refusal(
  response: Response,
  request: MediaRequest,
  signal: AbortSignal,
): Promise<MediaGenerationError> {
  let body: unknown;
  if (request.isPolicyRefusal) {
    try {
      const bytes = await readBodyCapped(response, ERROR_BODY_BYTES, signal);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      body = undefined;
    }
  } else {
    cancelResponseBody(response);
  }
  if (request.isPolicyRefusal?.(response.status, body))
    return new MediaGenerationError("content_policy");
  if (response.status === 429) return new MediaGenerationError("rate_limit");
  if (response.status === 401 || response.status === 403)
    return new MediaGenerationError("authentication");
  return new MediaGenerationError("provider_failure");
}

/**
 * The error to throw for any failure in a generation: cancellation stays cancellation, a media
 * error stays itself, an oversized body is the output limit, and anything else (whose message may
 * hold a URL or a body) becomes a bare provider failure.
 */
export function mediaFailure(error: unknown, context: AdapterContext): unknown {
  if (context.signal.aborted) return context.signal.reason;
  if (error instanceof MediaGenerationError) return error;
  return new MediaGenerationError(
    error instanceof ResponseTooLargeError ? "output_limit" : "provider_failure",
  );
}

/** A generated image sent inline as base64, its format read from the bytes. */
export function decodeBase64Image(raw: string): GeneratedMedia {
  // Some servers wrap base64 lines.
  const encoded = raw.replace(/\s/g, "");
  if (encoded.length > ATTACHMENT_MAX_BASE64_LENGTH) throw new MediaGenerationError("output_limit");
  // Buffer.from skips characters that are not base64, so damaged data would decode short.
  if (!encoded || encoded.length % 4 || !BASE64_PATTERN.test(encoded))
    throw new MediaGenerationError("provider_failure");
  return imageFromBytes(new Uint8Array(Buffer.from(encoded, "base64")));
}

function imageFromBytes(bytes: Uint8Array): GeneratedMedia {
  // The format is read from the bytes: servers differ in what they return and how they label it.
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType || !GENERATED_IMAGE_MIME_TYPES.has(mimeType))
    throw new MediaGenerationError("provider_failure");
  const output = { bytes, mimeType: mimeType as MediaImageMimeType };
  validateGeneratedMedia(output, "image");
  return output;
}

function videoFromBytes(bytes: Uint8Array): GeneratedMedia {
  // An MP4 file opens with an `ftyp` box.
  if (bytes.byteLength < 12 || Buffer.from(bytes.subarray(4, 8)).toString("latin1") !== "ftyp")
    throw new MediaGenerationError("provider_failure");
  const output: GeneratedMedia = { bytes, mimeType: "video/mp4" };
  validateGeneratedMedia(output, "video");
  return output;
}

/**
 * Downloads a generated file from the URL a provider answered with. The URL is untrusted: public
 * DNS is pinned, private addresses and redirects are refused, and no credential is sent to its
 * host. The format is read from the bytes, never the label.
 */
export async function downloadMediaOutput(
  url: string,
  kind: "image" | "video",
  http: MediaHttpOptions,
  context: AdapterContext,
  signal: AbortSignal = context.signal,
): Promise<GeneratedMedia> {
  try {
    const result = await fetchSafeWebBytes(url, {
      fetch: http.fetch,
      resolveHostname: http.resolveHostname,
      signal,
      maxBytes: ATTACHMENT_MAX_BYTES,
      maxRedirects: 0,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    return kind === "image" ? imageFromBytes(result.body) : videoFromBytes(result.body);
  } catch (error) {
    throw mediaFailure(error, context);
  }
}

/**
 * Downloads a generated file from the provider's own API, which takes the credential. A redirect
 * (to the provider's storage) is followed as an untrusted output URL, without the credential.
 */
export async function downloadProviderMedia(
  url: string,
  headers: Record<string, string>,
  kind: "image" | "video",
  http: MediaHttpOptions,
  context: AdapterContext,
): Promise<GeneratedMedia> {
  context.signal.throwIfAborted();
  const signal = deadlineSignal(DOWNLOAD_TIMEOUT_MS, context.signal);
  let location: string | undefined;
  try {
    const response = await (http.fetch ?? fetch)(url, { headers, signal, redirect: "manual" });
    const redirect = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && redirect) {
      cancelResponseBody(response);
      location = new URL(redirect, url).href;
    } else {
      if (!response.ok) throw await refusal(response, {}, signal);
      const bytes = await readBodyCapped(response, ATTACHMENT_MAX_BYTES, signal);
      return kind === "image" ? imageFromBytes(bytes) : videoFromBytes(bytes);
    }
  } catch (error) {
    throw mediaFailure(error, context);
  }
  return downloadMediaOutput(location, kind, http, context, signal);
}

/** An input image, checked to be what it says it is and within the attachment limit. */
export function checkedInputImage(image: MediaInputImage): MediaInputImage {
  if (
    !image.bytes.byteLength ||
    image.bytes.byteLength > ATTACHMENT_MAX_BYTES ||
    detectImageMimeType(image.bytes) !== image.mimeType
  )
    throw new MediaGenerationError("invalid_input");
  return image;
}

export function imageBase64(image: MediaInputImage): string {
  return Buffer.from(checkedInputImage(image).bytes).toString("base64");
}

/** An input image as a `data:` URL, the way most JSON APIs take one inline. */
export function imageDataUrl(image: MediaInputImage): string {
  return `data:${image.mimeType};base64,${imageBase64(image)}`;
}

/** An input image as a multipart file part. */
export function imageBlob(image: MediaInputImage): Blob {
  return new Blob([Buffer.from(checkedInputImage(image).bytes)], { type: image.mimeType });
}

/** A job id: what a poll in another process needs, as compact JSON, never a secret. */
export function encodeMediaJob(job: Record<string, string>): string {
  return JSON.stringify(job);
}

/** Reads a job id {@link encodeMediaJob} wrote; anything else is the caller's mistake. */
export function decodeMediaJob<T extends z.ZodTypeAny>(schema: T, id: string): z.infer<T> {
  let value: unknown;
  try {
    value = JSON.parse(id);
  } catch {
    throw new MediaGenerationError("invalid_input");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MediaGenerationError("invalid_input");
  return parsed.data;
}

/**
 * Polls a queued image inside its generation's deadline, for APIs that make images the way they
 * make videos. `check` answers undefined while the job runs.
 */
export async function waitForMediaJob<T>(
  check: () => Promise<T | undefined>,
  signal: AbortSignal,
  context: AdapterContext,
): Promise<T> {
  try {
    return (await pollUntil(check, {
      intervalMs: (looks) => Math.min(500 * looks, 3_000),
      timeoutMs: MEDIA_IMAGE_DEADLINE_MS,
      signal,
      onTimeout: () => {
        throw new MediaGenerationError("provider_failure");
      },
    })) as T;
  } catch (error) {
    throw mediaFailure(error, context);
  }
}
