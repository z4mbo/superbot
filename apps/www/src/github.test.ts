import { describe, expect, it } from "vitest";
import {
  desktopDownloadHref,
  fetchDesktopDownloads,
  fetchGithubStars,
  formatStarCount,
} from "./github";

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/z4mbo/superbot/releases/download/v1.0.0/${name}`,
});

describe("fetchDesktopDownloads", () => {
  it("maps each installer, including the Debian package, to its platform", async () => {
    const downloads = await fetchDesktopDownloads(
      jsonFetch({
        assets: [
          asset("Superbot-1.0.0.dmg"),
          asset("Superbot-Setup-1.0.0.exe"),
          asset("Superbot-Setup-1.0.0.exe.blockmap"),
          asset("Superbot-1.0.0.AppImage"),
          asset("superbot_1.0.0_amd64.deb"),
          asset("latest.yml"),
        ],
      }),
    );
    expect(downloads).toEqual({
      mac: asset("Superbot-1.0.0.dmg").browser_download_url,
      windows: asset("Superbot-Setup-1.0.0.exe").browser_download_url,
      linux: asset("Superbot-1.0.0.AppImage").browser_download_url,
      "linux-deb": asset("superbot_1.0.0_amd64.deb").browser_download_url,
    });
  });

  it("finds nothing when there is no release", async () => {
    expect(await fetchDesktopDownloads(jsonFetch({ message: "Not Found" }, 404))).toEqual({});
  });

  it("ignores assets that are not served over https", async () => {
    const downloads = await fetchDesktopDownloads(
      jsonFetch({ assets: [{ name: "a.deb", browser_download_url: "http://example.test/a.deb" }] }),
    );
    expect(downloads).toEqual({});
  });
});

describe("desktopDownloadHref", () => {
  it("points at the redirect for every platform", () => {
    expect(desktopDownloadHref("linux-deb")).toBe("/api/download?platform=linux-deb");
  });
});

describe("fetchGithubStars", () => {
  it("returns a real count of zero", async () => {
    expect(await fetchGithubStars(jsonFetch({ stargazers_count: 0 }))).toBe(0);
  });

  it("returns null rather than a made-up count when GitHub is unavailable", async () => {
    expect(await fetchGithubStars(jsonFetch({}, 503))).toBeNull();
    expect(
      await fetchGithubStars(async () => {
        throw new TypeError("network down");
      }),
    ).toBeNull();
    expect(await fetchGithubStars(jsonFetch({ stargazers_count: "lots" }))).toBeNull();
  });
});

describe("formatStarCount", () => {
  it("shortens thousands", () => {
    expect(formatStarCount(0)).toBe("0");
    expect(formatStarCount(999)).toBe("999");
    expect(formatStarCount(1_250)).toBe("1.3k");
    expect(formatStarCount(12_400)).toBe("12k");
  });
});
