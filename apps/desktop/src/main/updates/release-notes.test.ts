import { describe, expect, it } from "vitest";
import { MAX_RELEASE_NOTES_LENGTH, releaseNotesFrom, releaseNotesText } from "./release-notes.js";

describe("releaseNotesText", () => {
  it("turns release feed HTML into readable lines", () => {
    const html = [
      "<h2>What&#39;s Changed</h2>",
      '<ul>\n<li>Show release notes by <a class="user-mention" href="https://x.test/a">@a</a></li>',
      "<li>Ship a deb&nbsp;package</li>\n</ul>",
      '<p><strong>Full Changelog</strong>: <a href="https://x.test/c">v0.1.0...v0.2.0</a></p>',
    ].join("");
    expect(releaseNotesText(html)).toBe(
      "What's Changed\n\n• Show release notes by @a\n• Ship a deb package\n\nFull Changelog: v0.1.0...v0.2.0",
    );
  });

  it("keeps escaped markup as visible text and drops real tags", () => {
    expect(releaseNotesText("<script>alert(1)</script>&lt;img src=x onerror=alert(1)&gt;")).toBe(
      "alert(1)<img src=x onerror=alert(1)>",
    );
    expect(releaseNotesText("&#0;&#xD800;&#x1F680;&bogus;\u0007")).toBe("🚀&bogus;");
  });

  it("passes plain notes through and treats empty notes as none", () => {
    expect(releaseNotesText("- Faster sync\r\n- Fewer prompts")).toBe(
      "- Faster sync\n- Fewer prompts",
    );
    expect(releaseNotesText("  <p> </p> ")).toBeNull();
  });

  it("bounds long notes on a word and never splits a surrogate pair", () => {
    const long = releaseNotesText("word ".repeat(5_000));
    expect(long?.length).toBeLessThanOrEqual(MAX_RELEASE_NOTES_LENGTH + 1);
    expect(long?.endsWith("word…")).toBe(true);
    const emoji = releaseNotesText("🚀".repeat(MAX_RELEASE_NOTES_LENGTH));
    expect(emoji?.endsWith("🚀…")).toBe(true);
  });
});

describe("releaseNotesFrom", () => {
  it("reads one release's notes or each version's", () => {
    expect(releaseNotesFrom({ releaseNotes: "<p>Fixes</p>" })).toBe("Fixes");
    expect(
      releaseNotesFrom({
        releaseNotes: [
          { version: "0.3.0", note: "<p>Newer</p>" },
          { version: "0.2.0", note: null },
          "junk",
        ],
      }),
    ).toBe("0.3.0\nNewer");
    expect(releaseNotesFrom({ version: "0.2.0" })).toBeNull();
    expect(releaseNotesFrom({ releaseNotes: 42 })).toBeNull();
    expect(releaseNotesFrom(null)).toBeNull();
  });
});
