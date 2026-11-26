import { existsSync, readFileSync } from "node:fs";
import { BUILD_APP_PROMPT } from "@rakazo/plugin-sdk/guide";
import type { AstroIntegration } from "astro";
import { getMarkdownAlternate } from "./agent-content";
import { BUILD_AN_APP_PATH, BUILD_APP_PROMPT_PATH, DOCS_REDIRECTS, docsPath } from "./docs";
import { DEFAULT_LOCALE, isLocale } from "./i18n/locales";
import { localizedPath, TRANSLATED_PAGES } from "./i18n/translations";
import { SITE_URL } from "./site";

const OG_IMAGE = /<meta property="og:image" content="([^"]+)"/;

/** Built pages whose Open Graph image is missing from the build, e.g. a blog post with no rendered card. */
function missingOgImages(pathnames: string[], dir: URL): string[] {
  return pathnames.flatMap((pathname) => {
    const html = new URL(`./${pathname}index.html`, dir);
    if (!existsSync(html)) return [];
    const image = OG_IMAGE.exec(readFileSync(html, "utf8"))?.[1];
    if (!image) return [];
    const url = new URL(image, SITE_URL);
    if (url.origin !== new URL(SITE_URL).origin) return [];
    return existsSync(new URL(`.${url.pathname}`, dir)) ? [] : [`/${pathname} → ${url.pathname}`];
  });
}

/** Built pages whose Markdown twin, which the middleware serves to agents, was not built. */
function missingMarkdownTwins(pathnames: string[], dir: URL): string[] {
  return pathnames.flatMap((pathname) => {
    if (!existsSync(new URL(`./${pathname}index.html`, dir))) return [];
    const twin = getMarkdownAlternate(`/${pathname}`);
    return twin && !existsSync(new URL(`.${twin}`, dir)) ? [`/${pathname} → ${twin}`] : [];
  });
}

/** Registered pages (English or translated) that were not built, and localized pages that are not registered. */
function translationMismatches(pathnames: string[]): string[] {
  const built = new Set(pathnames.map((pathname) => `/${pathname}`));
  const registered = new Set(
    Object.entries(TRANSLATED_PAGES).flatMap(([path, locales]) => [
      path,
      ...locales.map((locale) => localizedPath(path, locale)),
    ]),
  );
  const unbuilt = [...registered].filter((path) => !built.has(path));
  const unregistered = [...built].filter((path) => {
    const first = path.split("/")[1];
    return (
      first !== DEFAULT_LOCALE && isLocale(first) && path.endsWith("/") && !registered.has(path)
    );
  });
  return [
    ...unbuilt.map((path) => `${path} is in TRANSLATED_PAGES but was not built`),
    ...unregistered.map((path) => `${path} was built but is missing from TRANSLATED_PAGES`),
  ];
}

const PROMPT_TEXT = /<code data-copy-prompt-text[^>]*>([\s\S]*?)<\/code>/g;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  "#x27": "'",
};

function decodeHtml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, name: string) => ENTITIES[name] ?? "");
}

/** Pages whose copy-prompt block does not hold exactly the exported Build an app prompt. */
function promptMismatches(dir: URL): string[] {
  const problems = ["/", BUILD_AN_APP_PATH].flatMap((path) => {
    const html = new URL(`.${path}index.html`, dir);
    if (!existsSync(html)) return [`${path} was not built`];
    const embedded = [...readFileSync(html, "utf8").matchAll(PROMPT_TEXT)].map((match) =>
      decodeHtml(match[1] ?? ""),
    );
    if (embedded.length === 0) return [`${path} has no Build an app prompt`];
    return embedded.every((text) => text === BUILD_APP_PROMPT)
      ? []
      : [`${path} embeds a Build an app prompt that differs from @rakazo/plugin-sdk/guide`];
  });
  const text = new URL(`.${BUILD_APP_PROMPT_PATH}`, dir);
  if (!existsSync(text) || readFileSync(text, "utf8") !== `${BUILD_APP_PROMPT}\n`) {
    problems.push(`${BUILD_APP_PROMPT_PATH} does not serve the Build an app prompt`);
  }
  return problems;
}

/** Old docs slugs that vercel.json does not redirect to their new page. */
function missingDocsRedirects(dir: URL): string[] {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", dir), "utf8")) as {
    redirects?: { source: string; destination: string }[];
  };
  const redirects = new Map(config.redirects?.map((entry) => [entry.source, entry.destination]));
  return Object.entries(DOCS_REDIRECTS).flatMap(([from, to]) => {
    const page = docsPath(to);
    const expected: [string, string][] = [
      [`/docs/${from}`, page],
      [`/docs/${from}/`, page],
      [`/docs/${from}.md`, `${page.slice(0, -1)}.md`],
    ];
    return expected
      .filter(([source, destination]) => redirects.get(source) !== destination)
      .map(([source, destination]) => `vercel.json must redirect ${source} to ${destination}`);
  });
}

/**
 * Fails the build on a missing Open Graph image or Markdown twin, a translation the registry does
 * not match, a Build an app prompt that differs from the SDK's, or an old docs slug left unredirected.
 */
export function buildChecks(): AstroIntegration {
  return {
    name: "build-checks",
    hooks: {
      "astro:build:done": ({ dir, pages }) => {
        const pathnames = pages.map((page) => page.pathname);
        const problems = [
          ...missingOgImages(pathnames, dir).map(
            (page) =>
              `Missing Open Graph image for ${page}. Render it with scripts/render-og.mjs in the marketing repository.`,
          ),
          ...missingMarkdownTwins(pathnames, dir).map(
            (page) => `Missing Markdown twin for ${page}. Add a .md endpoint beside the page.`,
          ),
          ...translationMismatches(pathnames),
          ...promptMismatches(dir),
          ...missingDocsRedirects(dir),
        ];
        if (problems.length > 0) throw new Error(problems.join("\n"));
      },
    },
  };
}
