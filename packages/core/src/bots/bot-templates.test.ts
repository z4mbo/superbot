import { readFileSync } from "node:fs";
import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { BOT_TEMPLATE_CATEGORIES, BotTemplateSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { looksLikeCredential, parseAgentImport } from "../agent-import/index.js";
import { matchAppCatalog } from "../integrations/app-connect.js";
import {
  FEATURED_CONNECTOR_IDS,
  FEATURED_CONNECTOR_LABELS,
  MCP_SOURCE_PRESETS,
} from "../integrations/featured-connectors.js";
import { nextCronDateAcrossStrict, presetFromCron } from "../routines/schedule.js";
import { extractRoutineSkillMentions } from "../skills/agent-skill.js";
import { BOT_TEMPLATES, findBotTemplate, matchesBotTemplateQuery } from "./bot-templates.js";

/** Every app core can name without a provider's catalog: the featured connectors and the presets. */
const KNOWN_APPS: ConnectionCatalogItem[] = [
  ...FEATURED_CONNECTOR_IDS.map((id) => ({ slug: id, name: FEATURED_CONNECTOR_LABELS[id] })),
  ...MCP_SOURCE_PRESETS.map((preset) => ({ slug: preset.id, name: preset.name })),
].map((app) => ({ ...app, connectorId: app.slug, logo: null, connected: false, noAuth: false }));

describe("bot templates", () => {
  it("imports the shareable GitHub watcher with the same instructions and no grants", () => {
    const template = findBotTemplate("github-issue-watch")!;
    const path = "github-issue-watch.md";
    const content = readFileSync(
      new URL(`../../../../examples/agents/${path}`, import.meta.url),
      "utf8",
    );
    const plan = parseAgentImport([{ path, content }]);
    expect(plan).toMatchObject({
      source: "document",
      suggestedName: template.name,
      instructions: [{ content: `${template.instructions}\n`, role: "working" }],
      mcpServers: [],
      apiKeys: [],
      routines: [],
    });
  });

  it("each validates strictly and has a unique id", () => {
    for (const template of BOT_TEMPLATES) {
      expect(BotTemplateSchema.parse(template)).toEqual(template);
    }
    const ids = BOT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findBotTemplate("morning-briefing")?.name).toBe("Morning briefing");
    expect(findBotTemplate("missing")).toBeUndefined();
  });

  it("is a full catalog with every category filled and listed in category order", () => {
    expect(BOT_TEMPLATES.length).toBeGreaterThanOrEqual(80);
    for (const category of BOT_TEMPLATE_CATEGORIES) {
      expect(
        BOT_TEMPLATES.filter((template) => template.category === category).length,
        category,
      ).toBeGreaterThanOrEqual(3);
    }
    const order = BOT_TEMPLATES.map((template) =>
      BOT_TEMPLATE_CATEGORIES.indexOf(template.category),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("keeps the original templates", () => {
    for (const id of [
      "morning-briefing",
      "inbox-triage",
      "pr-reviewer",
      "github-issue-watch",
      "topic-watch",
    ]) {
      expect(findBotTemplate(id), id).toBeDefined();
    }
  });

  it("have unique names", () => {
    const names = BOT_TEMPLATES.map((template) => template.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("carry nothing shaped like a credential", () => {
    for (const template of BOT_TEMPLATES) {
      const texts = [
        template.sample,
        template.instructions,
        ...template.skills.flatMap((skill) => [skill.description, skill.body]),
        ...template.routines.map((routine) => routine.prompt),
      ];
      expect(texts.filter(looksLikeCredential)).toEqual([]);
    }
  });

  it("mention only their own skills in routines", () => {
    for (const template of BOT_TEMPLATES) {
      const names = template.skills.map((skill) => skill.name);
      const mentioned = template.routines.flatMap((routine) =>
        extractRoutineSkillMentions(routine.prompt),
      );
      for (const name of mentioned) expect(names, template.id).toContain(name);
    }
  });

  it("use schedules the routine editor shows without Advanced, and that the scheduler accepts", () => {
    for (const template of BOT_TEMPLATES) {
      for (const routine of template.routines) {
        for (const cron of routine.crons) {
          expect(presetFromCron(cron).freq, `${template.id}: ${cron}`).not.toBe("Advanced");
        }
        expect(nextCronDateAcrossStrict(routine.crons, new Date(), "UTC")).not.toBeNull();
      }
    }
  });

  it("name apps the connection catalog knows", () => {
    for (const template of BOT_TEMPLATES) {
      for (const app of template.apps) {
        expect(matchAppCatalog(KNOWN_APPS, app), `${template.id}: ${app}`).toBeDefined();
      }
      expect(new Set(template.apps).size).toBe(template.apps.length);
    }
  });

  it("reads Food Diary through its app actions in the nutrition coach", () => {
    const coach = findBotTemplate("nutrition-coach")!;
    const text = [coach.instructions, ...coach.skills.map((skill) => skill.body)].join("\n");
    for (const name of ["find_apps", "run_app_action", "open_app", "`day`", "`addEntry`"]) {
      expect(text).toContain(name);
    }
  });
});

describe("template search", () => {
  const coach = findBotTemplate("nutrition-coach")!;

  it("matches word starts in the name, summary, description and category", () => {
    expect(matchesBotTemplateQuery(coach, "")).toBe(true);
    expect(matchesBotTemplateQuery(coach, "nutri")).toBe(true);
    expect(matchesBotTemplateQuery(coach, "food diary")).toBe(true);
    expect(matchesBotTemplateQuery(coach, "HEALTH")).toBe(true);
    expect(matchesBotTemplateQuery(coach, "flights")).toBe(false);
  });

  it("matches the texts the app shows, such as a translated name", () => {
    expect(matchesBotTemplateQuery(coach, "ernährung")).toBe(false);
    expect(matchesBotTemplateQuery(coach, "ernährung", ["Ernährungscoach"])).toBe(true);
  });

  it("finds every job the catalog was built for", () => {
    for (const query of ["flights", "unsubscribe", "pull requests", "opt-out", "rewards"]) {
      expect(
        BOT_TEMPLATES.some((template) => matchesBotTemplateQuery(template, query)),
        query,
      ).toBe(true);
    }
  });
});
