// Read at build time (and by the edge functions); client bundles have no `process`.
const env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env;

function origin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Where this site is served: `WWW_SITE_URL`, else the Vercel production domain, else local. */
export function siteUrl(source: Record<string, string | undefined> = env): string {
  if (source.WWW_SITE_URL?.trim()) return origin(source.WWW_SITE_URL);
  const vercel = source.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return origin(vercel.startsWith("http") ? vercel : `https://${vercel}`);
  return `http://localhost:${source.WWW_PORT?.trim() || "4321"}`;
}

export const SITE_NAME = "Superbot";
export const SITE_URL = siteUrl();
export const SITE_DESCRIPTION =
  "Superbot is open source software for persistent AI teammates that do real work. Run it yourself with your own keys and models, install agents, skills and apps from the Store, or build your own app.";

/** The web app people sign in to. */
export const APP_URL = origin(
  env.WWW_APP_URL?.trim() || "https://superbot-web-git-main-z4mbon.vercel.app",
);
export const GITHUB_REPO = "z4mbo/superbot";
export const GITHUB_URL = "https://github.com/z4mbo/superbot";
export const GITHUB_BRANCH = "main";
export const GITHUB_API_REPO = "https://api.github.com/repos/z4mbo/superbot";
export const SELF_HOST_GUIDE_PATH = "/docs/self-host/";
export const CHANGELOG_URL = "https://github.com/z4mbo/superbot/releases";
export const LATEST_RELEASE_URL = `${CHANGELOG_URL}/latest`;
/** The open source project Superbot is built from, credited in the footer. */
export const UPSTREAM_PROJECT = { name: "Rakazo", url: "https://github.com/elie222/rakazo" };
