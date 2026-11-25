import { BUILD_AN_APP_PATH, BUILD_APP_PROMPT_PATH } from "./docs";
import { APPS_PLATFORM_COPY } from "./i18n/apps-platform";
import { getHomeCopy, HOME_CHANNELS, HOME_FEATURE_KINDS, HOME_MODEL_PROVIDERS } from "./i18n/home";
import { DEFAULT_LOCALE, isLocale } from "./i18n/locales";
import {
  APP_URL,
  GITHUB_URL,
  SELF_HOST_GUIDE_PATH,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
} from "./site";

export const AGENT_DISCOVERY_LINKS =
  '</llms.txt>; rel="describedby"; type="text/plain", </.well-known/ai-catalog.json>; rel="ai-catalog"; type="application/ai-catalog+json"';

const home = getHomeCopy("en");
const apps = APPS_PLATFORM_COPY;

export const HOME_MARKDOWN = `# ${SITE_NAME}

${SITE_DESCRIPTION}

${home.hero.lead}

## ${apps.store.heading}

${apps.store.copy}

${apps.store.sections.map((section) => `- **${section.title}:** ${section.body}`).join("\n")}

## ${apps.platform.heading}

${apps.platform.copy}

${apps.platform.capabilities.map((item) => `- **${item.title}:** ${item.body}`).join("\n")}

### ${apps.platform.example.heading}

${apps.platform.example.copy}

${apps.platform.steps.map((step, index) => `${index + 1}. **${step.title}:** ${step.body}`).join("\n")}

- [Build an app](${SITE_URL}${BUILD_AN_APP_PATH})
- [Build an app prompt](${SITE_URL}${BUILD_APP_PROMPT_PATH}): paste it into a coding agent.

## ${home.channels.heading}

${home.channels.copy}

${HOME_CHANNELS.map((channel) => `- ${channel.name}${channel.selfHosted ? ` (${home.selfHost.heading})` : ""}`).join("\n")}

## ${home.features.heading}

${HOME_FEATURE_KINDS.map((kind) => `- **${home.features.items[kind].title}:** ${home.features.items[kind].body}`).join("\n")}

## ${home.selfHost.heading}

${home.selfHost.copy}

${home.selfHost.features.map((feature) => `- **${feature.title}:** ${feature.body}`).join("\n")}

${home.selfHost.worksWith}: ${HOME_MODEL_PROVIDERS.join(", ")}.

## ${home.openSource.heading}

${home.openSource.copy}

## FAQ

${home.faq.items.map((item) => `### ${item.question}\n\n${item.answer}`).join("\n\n")}

## ${home.cta.heading}

${home.cta.copy}

- [Web app](${APP_URL})
- [Docs](${SITE_URL}/docs/)
- [Self-hosting guide](${SITE_URL}${SELF_HOST_GUIDE_PATH})
- [Source code](${GITHUB_URL})
- [Agent instructions](${SITE_URL}/llms.txt)
- [Sitemap](${SITE_URL}/sitemap-index.xml)
`;

export const NOT_FOUND_MARKDOWN = `# Page not found

The requested ${SITE_NAME} page does not exist.

- [Agent instructions](${SITE_URL}/llms.txt)
- [Site map](${SITE_URL}/sitemap-index.xml)
- [Home](${SITE_URL}/)
- [Docs](${SITE_URL}/docs/)
`;

type MediaPreference = {
  quality: number;
  specificity: number;
};

export type Representation = "html" | "markdown";

function normalizePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

function preferenceFor(accept: string, desiredType: string): MediaPreference {
  const [desiredMajor, desiredMinor] = desiredType.split("/");
  let best: MediaPreference = { quality: 0, specificity: -1 };

  for (const rawRange of accept.split(",")) {
    const [rawType = "", ...rawParameters] = rawRange.trim().toLowerCase().split(";");
    const [major, minor] = rawType.trim().split("/");
    if (!major || !minor) continue;

    const specificity =
      major === desiredMajor && minor === desiredMinor
        ? 2
        : major === desiredMajor && minor === "*"
          ? 1
          : major === "*" && minor === "*"
            ? 0
            : -1;
    if (specificity < 0) continue;

    const qualityParameter = rawParameters.find((parameter) => parameter.trim().startsWith("q="));
    const parsedQuality = qualityParameter
      ? Number.parseFloat(qualityParameter.trim().slice(2))
      : 1;
    const quality =
      Number.isFinite(parsedQuality) && parsedQuality >= 0 && parsedQuality <= 1
        ? parsedQuality
        : 0;

    if (
      specificity > best.specificity ||
      (specificity === best.specificity && quality > best.quality)
    ) {
      best = { quality, specificity };
    }
  }

  return best;
}

export function negotiateRepresentation(acceptHeader: string | null): Representation {
  if (!acceptHeader?.trim()) return "html";

  const markdown = preferenceFor(acceptHeader, "text/markdown");
  const html = preferenceFor(acceptHeader, "text/html");

  if (markdown.quality > html.quality) return "markdown";
  if (
    markdown.quality > 0 &&
    markdown.quality === html.quality &&
    markdown.specificity > html.specificity
  )
    return "markdown";
  return "html";
}

/** Pages built without a Markdown twin: translations, which share the English one, and claim forms. */
function hasNoTwin(pathname: string): boolean {
  const [, first] = pathname.split("/");
  return (
    (first !== DEFAULT_LOCALE && isLocale(first)) || /^\/integrations\/[^/]+\/claim$/.test(pathname)
  );
}

/** The path of a page's Markdown twin, which every other page has beside its HTML. */
export function getMarkdownAlternate(pathname: string): string | undefined {
  const normalizedPathname = normalizePathname(pathname);
  if (normalizedPathname === "/") return "/index.md";
  // A path such as `//host/x` would name another origin once resolved as a URL.
  if (!/^\/[^/\\]/.test(normalizedPathname) || normalizedPathname.includes("\\")) return undefined;
  return hasNoTwin(normalizedPathname) ? undefined : `${normalizedPathname}.md`;
}

export function markdownResponse(body: string, method = "GET", status = 200): Response {
  return new Response(method === "HEAD" ? null : body, {
    status,
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Language": "en",
      "Content-Type": "text/markdown; charset=utf-8",
      Link: AGENT_DISCOVERY_LINKS,
      Vary: "Accept, Accept-Encoding",
      ...(status === 404 ? { "X-Robots-Tag": "noindex" } : {}),
    },
  });
}
