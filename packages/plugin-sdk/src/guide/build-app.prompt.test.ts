import { APP_PERMISSIONS } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { APP_GLOBALS } from "../check/check-app.js";
import { BUILD_APP_PROMPT } from "./build-app.prompt.js";

describe("BUILD_APP_PROMPT", () => {
  it("names every permission and every name an app's code finds in scope", () => {
    for (const name of [...APP_PERMISSIONS, ...APP_GLOBALS])
      expect(BUILD_APP_PROMPT).toContain(name);
  });

  it("stands alone: the commands it gives and the docs it points at, nothing filled in", () => {
    for (const text of [
      "https://github.com/z4mbo/superbot",
      "docs/plugin-sdk.md",
      "examples/food-diary",
      "superbot-plugin app-init",
      "superbot-plugin app-check",
      "superbot-plugin app-publish",
      "pnpm app:check",
    ])
      expect(BUILD_APP_PROMPT).toContain(text);
    expect(BUILD_APP_PROMPT).not.toMatch(/\$\{|Rakazo/);
  });
});
