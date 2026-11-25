import type { BotTemplate, BotTemplateCategory } from "@rakazo/contracts";

/** A catalog entry before its file's category is applied. */
export type CategoryTemplate = Omit<BotTemplate, "category">;

/** Each catalog file holds one category's templates; this stamps the category on each. */
export function inCategory(
  category: BotTemplateCategory,
  templates: readonly CategoryTemplate[],
): BotTemplate[] {
  return templates.map((template) => ({ ...template, category }));
}
