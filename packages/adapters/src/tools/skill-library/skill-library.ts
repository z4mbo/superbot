import type { AgentSkillLibraryEntry } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import { ERRAND_SKILLS } from "./errands.prompt.js";
import { EVERYDAY_SKILLS } from "./everyday.prompt.js";
import { TRAVEL_WORK_SKILLS } from "./travel-work.prompt.js";

/**
 * First-party skills people add from Browse in the Skills section. Unlike the built-in skills,
 * none is active until someone adds it: adding one saves a copy as their own skill.
 */
export const SKILL_LIBRARY: AgentSkillLibraryEntry[] = [
  ...EVERYDAY_SKILLS,
  ...ERRAND_SKILLS,
  ...TRAVEL_WORK_SKILLS,
].map(({ name, description, body }) => ({
  name,
  description,
  content: buildSkillMd({ name, description, body }),
}));
