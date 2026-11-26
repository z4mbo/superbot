import { z } from "zod";
import type { ResearchProvider } from "../../../web/research/research-provider.js";
import {
  boundedInteger,
  postProviderJson,
  publicResultUrl,
  ResearchProviderError,
} from "../../../web/research/research-provider.js";

const ENDPOINT = "https://api.exa.ai/search";
const LABEL = "Exa";
const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
/** Per result: a highlight excerpt, or page text when the call asks for it. */
const HIGHLIGHT_CHARS = 1_000;
const TEXT_CHARS = 4_000;
const MAX_DOMAINS = 20;

const responseSchema = z.object({
  results: z.array(
    z.object({
      url: z.string().max(8_192),
      title: z.string().nullish(),
      publishedDate: z.string().nullish(),
      text: z.string().nullish(),
      highlights: z.array(z.string()).nullish(),
    }),
  ),
});

/** Search through Exa with the person's own key. */
export const exaSearchProvider: ResearchProvider = {
  descriptor: { id: "exa", label: LABEL, toolName: "exa_search", capability: "search" },
  async run(args, key, options) {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new ResearchProviderError("query is required");
    const maxResults = boundedInteger(args.maxResults, DEFAULT_RESULTS, 1, MAX_RESULTS);
    const fullText = args.contents === "text";
    const chars = fullText ? TEXT_CHARS : HIGHLIGHT_CHARS;
    const includeDomains = domains(args.includeDomains);
    const excludeDomains = domains(args.excludeDomains);
    const startPublishedDate = isoDate(args.publishedAfter);
    const body = {
      query,
      numResults: maxResults,
      type: "auto",
      ...(includeDomains.length ? { includeDomains } : {}),
      ...(excludeDomains.length ? { excludeDomains } : {}),
      ...(startPublishedDate ? { startPublishedDate } : {}),
      contents: fullText
        ? { text: { maxCharacters: TEXT_CHARS } }
        : { highlights: { maxCharacters: HIGHLIGHT_CHARS } },
    };
    const raw = await postProviderJson({
      label: LABEL,
      url: ENDPOINT,
      key,
      headers: { "x-api-key": key },
      body,
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      options,
    });
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success)
      throw new ResearchProviderError(`${LABEL} returned an unexpected response.`);
    const results = parsed.data.results.flatMap((result) => {
      const url = publicResultUrl(result.url);
      if (!url) return [];
      const snippet = (
        fullText ? (result.text ?? "") : (result.highlights ?? []).join(" … ") || result.text || ""
      )
        .trim()
        .slice(0, chars);
      return [
        {
          title: result.title?.trim().slice(0, 500) || url,
          url,
          ...(result.publishedDate ? { publishedDate: result.publishedDate.slice(0, 40) } : {}),
          snippet,
        },
      ];
    });
    return { results: results.slice(0, maxResults) };
  },
};

/** Host names, optionally with a path prefix, as the search filter takes them. */
function domains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) =>
      entry
        .trim()
        .replace(/^https?:\/\//i, "")
        .toLowerCase(),
    )
    .filter((entry) => entry.length > 0 && entry.length <= 253 && !/\s/.test(entry))
    .slice(0, MAX_DOMAINS);
}

/** An ISO 8601 timestamp from a date the model gave, or undefined when it is not one. */
function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const at = Date.parse(value.trim());
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}
