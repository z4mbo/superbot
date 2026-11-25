import type { DesktopDownloadPlatform } from "../src/github.js";
import { fetchDesktopDownloads } from "../src/github.js";
import { CHANGELOG_URL } from "../src/site.js";

// Edge functions are bundled, which resolves the extensionless source imports.
export const config = { runtime: "edge" };

/**
 * Redirects to the newest installer so a desktop release needs no site rebuild. Without a
 * release, a matching asset or a known platform it sends people to the releases page.
 */
export async function fetchDownload(
  request: Request,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const platform = new URL(request.url).searchParams.get("platform");
  const downloads = await fetchDesktopDownloads(fetchImpl);
  const location =
    (platform && Object.hasOwn(downloads, platform)
      ? downloads[platform as DesktopDownloadPlatform]
      : undefined) ?? CHANGELOG_URL;
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
    },
  });
}

export function GET(request: Request): Promise<Response> {
  return fetchDownload(request);
}
