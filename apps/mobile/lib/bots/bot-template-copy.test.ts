import { BOT_TEMPLATES } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import { resetI18nForTests } from "../i18n/i18n";
import { botTemplateCopy } from "./bot-template-copy";

afterEach(() => resetI18nForTests());

/** Templates without copy show the server's English until a translation pass adds theirs. */
const withCopy = () => BOT_TEMPLATES.filter((template) => botTemplateCopy(template) !== template);

describe("botTemplateCopy", () => {
  it("matches the server's English for every template", () => {
    resetI18nForTests("en");
    expect(withCopy().length).toBeGreaterThanOrEqual(5);
    for (const template of withCopy()) {
      expect(botTemplateCopy(template)).toEqual({
        name: template.name,
        summary: template.summary,
        sample: template.sample,
      });
    }
  });

  it("translates every template it has copy for", () => {
    resetI18nForTests("de");
    for (const template of withCopy()) {
      const copy = botTemplateCopy(template);
      expect(copy.summary).not.toBe(template.summary);
      expect(copy.sample).not.toBe(template.sample);
    }
  });

  it("shows the server's English for a template it does not know", () => {
    resetI18nForTests("de");
    const template = { ...BOT_TEMPLATES[0]!, id: "new-template", name: "New", summary: "S" };
    expect(botTemplateCopy(template)).toMatchObject({ name: "New", summary: "S" });
  });
});
