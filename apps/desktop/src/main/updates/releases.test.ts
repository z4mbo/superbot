import { expect, it } from "vitest";
import { releasePageUrl } from "./releases.js";

it("links a stable version's release page and nothing else", () => {
  expect(releasePageUrl("0.14.0")).toBe("https://github.com/z4mbo/superbot/releases/tag/v0.14.0");
  for (const version of ["", "0.14", "0.14.0-beta.1", "../0.14.0", "0.14.0/../../x"])
    expect(() => releasePageUrl(version), version).toThrow();
});
