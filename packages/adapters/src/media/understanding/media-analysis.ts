import { deadlineSignal, ResponseTooLargeError, redactSecrets } from "@rakazo/core";
import type { ResolveHostname } from "../../network/network-address.js";
import { fetchSafeWebBytes } from "../../web/web-ssrf.js";
import { mediaUnavailableMessage } from "./media-analysis.prompt.js";
import type { SniffedMedia } from "./media-sniff.js";
import { sniffMedia } from "./media-sniff.js";

export type MediaModality = "image" | "video";

export const MEDIA_MAX_BYTES: Record<MediaModality, number> = {
  image: 10 * 1024 * 1024,
  video: 20 * 1024 * 1024,
};
const TIMEOUT_MS: Record<MediaModality, number> = { image: 60_000, video: 120_000 };
export const MEDIA_ANALYSIS_MAX_CHARS = 8_000;
/** Output tokens the analysis model may spend on one answer. */
export const MEDIA_ANALYSIS_MAX_TOKENS = 2_000;
const QUESTION_MAX_CHARS = 2_000;
const URL_MAX_CHARS = 2_048;

/** One image or video, already read and identified, and what to look for in it. */
export type MediaAnalysisInput = SniffedMedia & {
  name: string;
  data: Uint8Array;
  question?: string;
};

/**
 * A connected model that reads one kind of media. A run gets one only for a kind its model, or
 * another model its owner connected, declares it can read.
 */
export interface MediaAnalyzer {
  /** The analysis text; throws when the model call fails. */
  analyze(input: MediaAnalysisInput, signal: AbortSignal): Promise<string>;
}

export type MediaAnalyzers = Partial<Record<MediaModality, MediaAnalyzer>>;

/** Thrown by a reader when the file is larger than the cap it was given. */
export class MediaTooLargeError extends Error {
  constructor() {
    super("Media file is too large");
    this.name = "MediaTooLargeError";
  }
}

/** Where a tool call's media comes from. Each reader enforces `maxBytes` and its own access rules. */
export interface MediaSourceReaders {
  workspace(path: string, maxBytes: number): Promise<Uint8Array>;
  /** Undefined when the attachment is not in this conversation. */
  attachment(id: string, maxBytes: number): Promise<{ name: string; data: Uint8Array } | undefined>;
  url(url: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
}

type Source =
  | { kind: "path"; value: string }
  | { kind: "attachment"; value: string }
  | { kind: "url"; value: string };

export type MediaAnalysisResult =
  | { analysis: string; truncated?: true; source: string }
  | { error: string; source?: string };

const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function sourceOf(args: Record<string, unknown>): Source | { error: string } {
  const given = (["path", "attachment", "url"] as const)
    .map((kind) => ({ kind, value: nonEmpty(args[kind]) }))
    .filter((source): source is Source => source.value !== undefined);
  if (given.length !== 1) return { error: "Give exactly one of path, attachment or url." };
  return given[0]!;
}

/** `attachments/<id>.png` as listed to the model, or the bare id. */
function attachmentId(value: string): string | undefined {
  const id = value.replace(/^attachments\//, "").replace(/\.[a-z0-9]{1,8}$/i, "");
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
}

/** A climb out of the folder a path starts in; the computer bounds everything else, as for read_file. */
function climbsOut(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

async function readSource(
  source: Source,
  modality: MediaModality,
  readers: MediaSourceReaders,
  signal: AbortSignal,
): Promise<{ name: string; data: Uint8Array } | { error: string }> {
  const maxBytes = MEDIA_MAX_BYTES[modality];
  const tooLarge = `The ${modality} is larger than ${maxBytes / (1024 * 1024)} MB.`;
  try {
    if (source.kind === "path") {
      if (climbsOut(source.value)) return { error: "path must stay inside the workspace" };
      const data = await readers.workspace(source.value, maxBytes);
      return { name: source.value.split("/").pop() || source.value, data };
    }
    if (source.kind === "attachment") {
      const id = attachmentId(source.value);
      const found = id ? await readers.attachment(id, maxBytes) : undefined;
      return found ?? { error: "That attachment is not in this conversation." };
    }
    if (source.value.length > URL_MAX_CHARS) return { error: "url is too long" };
    let url: URL;
    try {
      url = new URL(source.value);
    } catch {
      return { error: "url must be an https URL" };
    }
    if (url.protocol !== "https:") return { error: "url must be an https URL" };
    const data = await readers.url(url.href, maxBytes, signal);
    return { name: url.pathname.split("/").pop() || url.hostname, data };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof MediaTooLargeError || error instanceof ResponseTooLargeError)
      return { error: tooLarge };
    return {
      error:
        source.kind === "url"
          ? "Could not fetch that URL. Only public https addresses can be read."
          : source.kind === "path"
            ? "file not found or unreadable"
            : "That attachment could not be read.",
    };
  }
}

/**
 * vision_analyze and video_analyze: read one image or video the run may see, have a connected
 * model that can read that kind describe it, and return text only. Without such a model nothing
 * is read or sent, and the result says so.
 */
export async function analyzeMediaFromTool(options: {
  modality: MediaModality;
  args: Record<string, unknown>;
  analyzer: MediaAnalyzer | undefined;
  readers: MediaSourceReaders;
  signal: AbortSignal;
  /** Values never returned, even when the media or the model repeats them. */
  secrets: readonly string[];
}): Promise<MediaAnalysisResult> {
  const { modality, args, analyzer, readers, signal, secrets } = options;
  if (!analyzer) return { error: mediaUnavailableMessage(modality) };
  const source = sourceOf(args);
  if ("error" in source) return source;
  const label = source.kind === "url" ? "url" : `${source.kind} ${source.value}`;
  const question = nonEmpty(args.question);
  if (question && question.length > QUESTION_MAX_CHARS)
    return { error: `question must be at most ${QUESTION_MAX_CHARS} characters` };
  const read = await readSource(source, modality, readers, signal);
  if ("error" in read) return { ...read, source: label };
  if (read.data.byteLength > MEDIA_MAX_BYTES[modality])
    return { error: `The ${modality} is too large.`, source: label };
  const sniffed = sniffMedia(read.data);
  if (!sniffed || sniffed.modality !== modality)
    return {
      error:
        modality === "video"
          ? "Not a supported video (MP4, MOV or WebM)."
          : "Not a supported image (PNG, JPEG, GIF or WebP).",
      source: label,
    };
  let text: string;
  try {
    text = await analyzer.analyze(
      { ...sniffed, name: read.name, data: read.data, question },
      deadlineSignal(TIMEOUT_MS[modality], signal),
    );
  } catch {
    // The provider's own error can carry request details; the model gets a fixed message.
    signal.throwIfAborted();
    return { error: `The ${modality} could not be analyzed. Try again later.`, source: label };
  }
  const analysis = redactSecrets(text.trim(), [...secrets]);
  if (!analysis) return { error: `The model returned no description.`, source: label };
  return analysis.length > MEDIA_ANALYSIS_MAX_CHARS
    ? { analysis: analysis.slice(0, MEDIA_ANALYSIS_MAX_CHARS), truncated: true, source: label }
    : { analysis, source: label };
}

/**
 * Fetches model-supplied media the way web_fetch treats model-supplied URLs: public https hosts
 * only, every redirect checked, no credentials or cookies sent, and the body capped.
 */
export async function fetchMediaUrl(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  seams: { fetch?: typeof globalThis.fetch; resolveHostname?: ResolveHostname } = {},
): Promise<Uint8Array> {
  const response = await fetchSafeWebBytes(url, {
    ...seams,
    maxBytes,
    signal,
    allowedPorts: [443],
    timeoutMs: 30_000,
  });
  if (!response.url.startsWith("https:")) throw new Error("Redirected away from https");
  return response.body;
}
