import { getCollection } from "astro:content";
import { getMarkdownAlternate } from "./agent-content";
import { BUILD_APP_PROMPT_PATH, DOCS_PAGES, docsPath } from "./docs";
import type { AgentResourceGroup } from "./marketing-site";
import { marketing } from "./marketing-site";
import { GITHUB_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "./site";

const AGENT_INSTRUCTIONS_INTRO = `# ${SITE_NAME}

> ${SITE_DESCRIPTION}

## Canonical resources

- [AI Catalog](${SITE_URL}/.well-known/ai-catalog.json): machine-readable index of the public agent resources.
- [Website](${SITE_URL}/): product overview, the Store, the Apps platform, and common questions.
- [Website Markdown](${SITE_URL}/index.md): the English product overview as Markdown.
- [Docs](${SITE_URL}/docs/): getting started, building apps, using Superbot, and self-hosting. Each page has a Markdown version.
- [Build an app prompt](${SITE_URL}${BUILD_APP_PROMPT_PATH}): plain-text prompt for a coding agent building a Superbot app.
- [Source](${GITHUB_URL})
`;

/** Names the catalog's entries after the host the site is served from. */
const CATALOG_HOST = new URL(SITE_URL).host;

function markdownPath(path: string): string {
  const markdown = getMarkdownAlternate(path);
  if (!markdown) throw new Error(`No Markdown twin for ${path}`);
  return markdown;
}

/** Every page with a Markdown twin that agents should be able to find, built from the page data. */
export async function agentResourceGroups(): Promise<AgentResourceGroup[]> {
  const docs = new Map(
    (await getCollection("docs")).map((entry) => [entry.id, entry.data.description]),
  );
  return [
    {
      id: "doc",
      heading: "Docs",
      resources: DOCS_PAGES.map((page) => ({
        id: page.slug,
        name: page.label,
        path: docsPath(page.slug),
        summary: docs.get(page.slug),
      })),
    },
    ...(await marketing.agentResourceGroups(getCollection)),
  ];
}

export function agentInstructions(groups: readonly AgentResourceGroup[]): string {
  return [
    marketing.agentInstructionsIntro ?? AGENT_INSTRUCTIONS_INTRO,
    ...groups.flatMap((group) => [
      `### ${group.heading}`,
      "",
      ...group.resources.map(
        (resource) =>
          `- [${resource.name}](${SITE_URL}${resource.path}) ([Markdown](${SITE_URL}${markdownPath(resource.path)}))${resource.summary ? `: ${resource.summary}` : ""}`,
      ),
      "",
    ]),
  ].join("\n");
}

export function aiCatalog(groups: readonly AgentResourceGroup[]) {
  return {
    specVersion: "1.0",
    host: {
      displayName: SITE_NAME,
      documentationUrl: `${SITE_URL}${marketing.agentDocumentationPath ?? "/docs/"}`,
    },
    entries: [
      {
        identifier: `urn:air:${CATALOG_HOST}:docs:llms`,
        displayName: `${SITE_NAME} agent guide`,
        type: "text/plain",
        url: `${SITE_URL}/llms.txt`,
        description: "Product overview, agent-assisted setup guidance, and canonical resources.",
      },
      {
        identifier: `urn:air:${CATALOG_HOST}:docs:overview`,
        displayName: `${SITE_NAME} overview`,
        type: "text/markdown",
        url: `${SITE_URL}/index.md`,
        description: "Features, model choices, self-hosting, and common questions.",
      },
      ...marketing.agentCatalogEntries,
      ...groups.flatMap((group) =>
        group.resources.map((resource) => ({
          identifier: `urn:air:${CATALOG_HOST}:${group.id}:${resource.id}`,
          displayName: resource.name,
          type: "text/markdown",
          url: `${SITE_URL}${markdownPath(resource.path)}`,
          ...(resource.summary ? { description: resource.summary } : {}),
        })),
      ),
    ],
  };
}
