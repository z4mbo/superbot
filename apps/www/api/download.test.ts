import { describe, expect, it } from "vitest";
import { fetchDownload } from "./download";

const RELEASES = "https://github.com/z4mbo/superbot/releases";
const DEB = `${RELEASES}/download/v1.0.0/superbot_1.0.0_amd64.deb`;
const APPIMAGE = `${RELEASES}/download/v1.0.0/Superbot-1.0.0.AppImage`;

function release(urls: string[], status = 200): typeof fetch {
  const body =
    status === 200
      ? { assets: urls.map((url) => ({ name: url.split("/").pop(), browser_download_url: url })) }
      : { message: "Not Found" };
  return async () => new Response(JSON.stringify(body), { status });
}

async function locationFor(platform: string | null, fetchImpl: typeof fetch) {
  const url = new URL("https://superbot.example/api/download");
  if (platform !== null) url.searchParams.set("platform", platform);
  const response = await fetchDownload(new Request(url), fetchImpl);
  expect(response.status).toBe(302);
  return response.headers.get("Location");
}

describe("fetchDownload", () => {
  it("redirects to the matching installer", async () => {
    const fetchImpl = release([APPIMAGE, DEB]);
    expect(await locationFor("linux", fetchImpl)).toBe(APPIMAGE);
    expect(await locationFor("linux-deb", fetchImpl)).toBe(DEB);
  });

  it("falls back to the releases page without a release", async () => {
    expect(await locationFor("windows", release([], 404))).toBe(RELEASES);
  });

  it("falls back to the releases page when the asset is missing", async () => {
    expect(await locationFor("mac", release([DEB]))).toBe(RELEASES);
  });

  it("falls back to the releases page for an unknown or missing platform", async () => {
    const fetchImpl = release([APPIMAGE, DEB]);
    expect(await locationFor("toString", fetchImpl)).toBe(RELEASES);
    expect(await locationFor(null, fetchImpl)).toBe(RELEASES);
  });
});
