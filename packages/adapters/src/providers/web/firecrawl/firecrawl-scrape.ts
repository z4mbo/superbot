import { z } from "zod";
import type { ResearchProvider } from "../../../web/research/research-provider.js";
import {
  postProviderJson,
  publicResultUrl,
  ResearchProviderError,
} from "../../../web/research/research-provider.js";
import { clampMaxChars, clampOffset, pageWindow } from "../../../web/web-limits.js";
import { assertSafeWebUrl } from "../../../web/web-ssrf.js";

const ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const LABEL = "Firecrawl";
/** What the scrape itself may take; the request deadline leaves room around it. */
const SCRAPE_TIMEOUT_MS = 45_000;
const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const responseSchema = z.object({
  success: z.boolean(),
  error: z.string().nullish(),
  data: z
    .object({
      markdown: z.string().nullish(),
      metadata: z
        .object({
          title: z.union([z.string(), z.array(z.string())]).nullish(),
          url: z.string().nullish(),
          sourceURL: z.string().nullish(),
          statusCode: z.number().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/** One page as markdown through Firecrawl, with the person's own key. */
export const firecrawlScrapeProvider: ResearchProvider = {
  descriptor: {
    id: "firecrawl",
    label: LABEL,
    toolName: "firecrawl_scrape",
    capability: "page_read",
  },
  async run(args, key, options) {
    const requested = typeof args.url === "string" ? args.url.trim() : "";
    if (!requested) throw new ResearchProviderError("url is required");
    const maxChars = clampMaxChars(args.maxChars);
    let offset: number;
    try {
      offset = clampOffset(args.offset);
    } catch (error) {
      throw new ResearchProviderError(error instanceof Error ? error.message : "offset is invalid");
    }
    // The same checks web_fetch makes, before the URL is disclosed to the provider.
    let url: URL;
    try {
      url = await assertSafeWebUrl(requested, options.resolveHostname, options.signal);
    } catch (error) {
      if (options.signal.aborted) throw error;
      throw new ResearchProviderError(
        error instanceof Error ? error.message : "URL is not allowed",
      );
    }
    const raw = await postProviderJson({
      label: LABEL,
      url: ENDPOINT,
      key,
      headers: { authorization: `Bearer ${key}` },
      body: {
        url: url.href,
        formats: ["markdown"],
        onlyMainContent: args.onlyMainContent !== false,
        timeout: SCRAPE_TIMEOUT_MS,
      },
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      options,
    });
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success)
      throw new ResearchProviderError(`${LABEL} returned an unexpected response.`);
    const markdown = parsed.data.data?.markdown ?? "";
    if (!parsed.data.success || !/\S/.test(markdown))
      throw new ResearchProviderError(`${LABEL} returned no readable content for this page.`);
    const metadata = parsed.data.data?.metadata;
    const pageUrl = publicResultUrl(metadata?.url) ?? url.href;
    const title = Array.isArray(metadata?.title) ? metadata.title[0] : metadata?.title;
    const status = metadata?.statusCode ?? undefined;
    return {
      url: pageUrl,
      title: title?.trim().slice(0, 500) || pageUrl,
      ...(status !== undefined && status >= 400 ? { pageStatus: status } : {}),
      ...pageWindow(markdown.slice(offset), maxChars, offset),
    };
  },
};
