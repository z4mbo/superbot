import type { CommunityTemplateRecipe } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { assertShareable, communityTemplateSlug, publicAuthorName } from "./community-templates.js";

const recipe: CommunityTemplateRecipe = {
  name: "Weekly digest",
  category: "research",
  summary: "What changed this week",
  sample: "**This week**\n- Two releases",
  description: "",
  instructions: "Write a weekly digest.\nKeep it short.",
  skills: [{ name: "Weekly report", description: "Write it.", body: "1. Gather.\n2. Write." }],
  routines: [{ name: "Friday digest", prompt: "Send it.", crons: ["0 9 * * 5"] }],
  apps: [],
};

function refusal(change: Partial<CommunityTemplateRecipe>) {
  try {
    assertShareable({ ...recipe, ...change });
  } catch (error) {
    expect(error).toBeInstanceOf(ClientError);
    return (error as ClientError).message;
  }
  return null;
}

describe("assertShareable", () => {
  it("accepts a plain recipe, with line breaks where text spans lines", () => {
    expect(refusal({})).toBeNull();
  });

  it("refuses anything that looks like a key or token, wherever it is", () => {
    const token = `ghp_${"a1".repeat(20)}`;
    expect(refusal({ instructions: `Use ${token}` })).toMatch(/key or token/);
    expect(refusal({ skills: [{ ...recipe.skills[0]!, body: `Token: ${token}` }] })).toMatch(
      /key or token/,
    );
  });

  it("keeps names and the summary to one plain line", () => {
    expect(refusal({ name: "Weekly\ndigest" })).toMatch(/one plain line/);
    expect(refusal({ summary: "Bcc: someone\r\nelse" })).toMatch(/one plain line/);
    // A direction override makes a name read differently from what it is.
    expect(refusal({ name: "Weekly \u202Etsegid" })).toMatch(/one plain line/);
    expect(refusal({ routines: [{ ...recipe.routines[0]!, name: "Friday\tdigest" }] })).toMatch(
      /one plain line/,
    );
  });

  it("refuses two skills with one name and a routine that would not install", () => {
    expect(refusal({ skills: [recipe.skills[0]!, { ...recipe.skills[0]! }] })).toMatch(
      /its own name/,
    );
    expect(refusal({ routines: [{ ...recipe.routines[0]!, crons: ["not a cron"] }] })).toMatch(
      /can't be shared/,
    );
  });
});

describe("publicAuthorName", () => {
  it("shows an account name, never an email or the name taken from one", () => {
    expect(publicAuthorName({ name: "Ana Author", email: "ana@example.test" })).toBe("Ana Author");
    expect(publicAuthorName({ name: "ana@example.test", email: "ana@example.test" })).toBeNull();
    expect(publicAuthorName({ name: "ana", email: "ana@example.test" })).toBeNull();
    expect(publicAuthorName({ name: "Ana", email: "x@example.test" })).toBe("Ana");
    expect(publicAuthorName(null)).toBeNull();
  });
});

describe("communityTemplateSlug", () => {
  it("names one stable slug per name", () => {
    expect(communityTemplateSlug("Weekly Digest!")).toBe("weekly-digest");
    expect(communityTemplateSlug("Café crème")).toBe("cafe-creme");
    const hashed = communityTemplateSlug("週報");
    expect(hashed).toMatch(/^agent-[a-z0-9]+$/);
    expect(communityTemplateSlug(" 週報 ")).toBe(hashed);
  });
});
