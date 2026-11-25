import { BOT_TEMPLATES, findSkillByName, looksLikeCredential, parseSkillMd } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "../builtin-skills.prompt.js";
import { SKILL_LIBRARY } from "./skill-library.js";

describe("skill library", () => {
  it("offers a skill for each everyday job", () => {
    expect(SKILL_LIBRARY.map((skill) => skill.name)).toEqual([
      "Schedule a meeting",
      "Weekly planning",
      "Clean up the inbox",
      "Draft an email",
      "Meeting notes",
      "News briefing",
      "Research a question",
      "Write a document",
      "Shop and compare",
      "Careful purchase",
      "Grocery list",
      "Order food",
      "Book a restaurant",
      "Restaurant picks",
      "Local businesses",
      "Orders and returns",
      "Manage subscriptions",
      "Request a ride",
      "Find flights",
      "Find a stay",
      "Travel itinerary",
      "Search for jobs",
      "Find leads",
      "Enrich a lead",
      "Markets and filings",
      "Code review",
      "Data broker opt-out",
    ]);
  });

  it("saves as valid skills that a routine can mention", () => {
    for (const skill of SKILL_LIBRARY) {
      const parsed = parseSkillMd(skill.content);
      expect(parsed, skill.name).toMatchObject({
        name: skill.name,
        description: skill.description,
      });
      // The same words-only shape template skills use, so `@Name` finds it.
      expect(skill.name).toMatch(/^[A-Za-z][\w-]*(?: [A-Za-z][\w-]*){0,5}$/);
      expect(skill.description.length).toBeLessThanOrEqual(2000);
      expect(skill.content.length).toBeLessThanOrEqual(100_000);
      expect(looksLikeCredential(skill.content)).toBe(false);
      // Numbered steps, ending with what the skill hands back.
      expect("error" in parsed ? "" : parsed.body).toMatch(/^1\. /);
    }
  });

  it("has unique names that no built-in or template skill already uses", () => {
    const names = SKILL_LIBRARY.map((skill) => skill.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const taken = [
      ...BUILTIN_AGENT_SKILLS,
      ...BOT_TEMPLATES.flatMap((template) => template.skills),
    ];
    for (const skill of SKILL_LIBRARY) {
      expect(findSkillByName(taken, skill.name), skill.name).toBeUndefined();
    }
  });

  it("keeps Interrogate as the always-on built-in", () => {
    expect(BUILTIN_AGENT_SKILLS.map((skill) => skill.name)).toEqual(["Interrogate"]);
  });
});
