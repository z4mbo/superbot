import type { BotTemplate, ConnectionCatalogItem } from "@rakazo/contracts";
import { matchConnectedAppCatalog } from "../integrations/app-connect.js";
import { matchesWordPrefixes } from "../integrations/plugin-catalog.js";
import { ASSISTANT_TEMPLATES } from "./templates/assistant.prompt.js";
import { DESIGN_TEMPLATES } from "./templates/design.prompt.js";
import { EMAIL_TEMPLATES } from "./templates/email.prompt.js";
import { ENGINEERING_TEMPLATES } from "./templates/engineering.prompt.js";
import { FINANCE_TEMPLATES } from "./templates/finance.prompt.js";
import { MARKETING_TEMPLATES } from "./templates/marketing.prompt.js";
import { MEETINGS_TEMPLATES } from "./templates/meetings.prompt.js";
import { OPERATIONS_TEMPLATES } from "./templates/operations.prompt.js";
import { PRODUCT_TEMPLATES } from "./templates/product.prompt.js";
import { QA_TEMPLATES } from "./templates/qa.prompt.js";
import { RECRUITING_TEMPLATES } from "./templates/recruiting.prompt.js";
import { RESEARCH_TEMPLATES } from "./templates/research.prompt.js";
import { SALES_TEMPLATES } from "./templates/sales.prompt.js";

/**
 * Reviewed, ready-made bots, one file per category under `templates/`, listed in category order.
 * Bump a template's `version` whenever any of its content changes: a create from an older
 * preview is refused, so what was shown is what gets made. Names, summaries and samples are shown
 * in the apps' languages; the rest is written for the bot.
 */
export const BOT_TEMPLATES: readonly BotTemplate[] = [
  ...ASSISTANT_TEMPLATES,
  ...EMAIL_TEMPLATES,
  ...MEETINGS_TEMPLATES,
  ...RESEARCH_TEMPLATES,
  ...ENGINEERING_TEMPLATES,
  ...QA_TEMPLATES,
  ...PRODUCT_TEMPLATES,
  ...DESIGN_TEMPLATES,
  ...SALES_TEMPLATES,
  ...MARKETING_TEMPLATES,
  ...RECRUITING_TEMPLATES,
  ...OPERATIONS_TEMPLATES,
  ...FINANCE_TEMPLATES,
];

export function findBotTemplate(id: string): BotTemplate | undefined {
  return BOT_TEMPLATES.find((template) => template.id === id);
}

/** The template's apps this server offers, preferring an entry some provider has connected. */
export function botTemplateApps(
  template: Pick<BotTemplate, "apps">,
  catalog: ConnectionCatalogItem[],
): ConnectionCatalogItem[] {
  return template.apps.flatMap((app) => {
    const entry = matchConnectedAppCatalog(catalog, app);
    return entry ? [entry] : [];
  });
}

/**
 * True when every word of the query starts a word of the template's name, summary, description
 * or category. Pass the texts the app shows (translated name and summary, the category's label)
 * in `shown`, so people can search in their own language.
 */
export function matchesBotTemplateQuery(
  template: Pick<BotTemplate, "name" | "summary" | "description" | "category">,
  query: string,
  shown: readonly string[] = [],
): boolean {
  return matchesWordPrefixes(
    [template.name, template.summary, template.description, template.category, ...shown].join(" "),
    query,
  );
}
