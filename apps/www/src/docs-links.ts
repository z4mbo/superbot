import { DOCS_PAGES, docsPath, docsSlugForFile } from "./docs";
import { GITHUB_BRANCH, GITHUB_URL } from "./site";

const REPO = new URL("https://repo.invalid/");
const MARKDOWN_LINK = /(\]\()([^)\s]+)(\))/g;

/** Resolves a repo doc's relative links: published docs become site pages, any other file opens on GitHub. */
export function rewriteDocsLinks(markdown: string, slug: string): string {
  const file = DOCS_PAGES.find((page) => page.slug === slug)?.file ?? slug;
  const source = new URL(`docs/${file}.md`, REPO);
  return markdown.replace(MARKDOWN_LINK, (match, open: string, href: string, close: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return match;
    const target = new URL(href, source);
    if (target.origin !== REPO.origin) return match;
    const doc = /^\/docs\/([\w/-]+)\.md$/.exec(target.pathname)?.[1];
    const page = doc ? docsSlugForFile(doc) : undefined;
    const resolved = page
      ? `${docsPath(page)}${target.hash}`
      : `${GITHUB_URL}/blob/${GITHUB_BRANCH}${target.pathname}${target.hash}`;
    return `${open}${resolved}${close}`;
  });
}
