import { at, field, values } from "./engine.js";

export type Model = { id: string; label: string; provider?: string };

/** The models a session offers and the one it uses now. */
export type Catalog = { models: Model[]; current: string | undefined };

export function dedupCatalog(catalog: Catalog): void {
  const seen = new Set<string>();
  catalog.models = catalog.models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function modelEntry(id: string, label: unknown, provider: string | undefined): Model {
  return { id, label: field(label) ?? id, ...(provider === undefined ? {} : { provider }) };
}

function collectChoices(
  raw: unknown,
  provider: string | undefined,
  depth: number,
  models: Model[],
) {
  if (depth > 8) return;
  for (const choice of values(raw)) {
    const choiceProvider = field(at(choice, "provider")) ?? provider;
    const id = field(at(choice, "value"));
    if (id !== undefined) {
      models.push(modelEntry(id, at(choice, "name"), choiceProvider));
    } else {
      const group = choiceProvider ?? field(at(choice, "name")) ?? field(at(choice, "group"));
      collectChoices(at(choice, "options"), group, depth + 1, models);
    }
  }
}

/** The model choices of an ACP session: its model config option, else its model list. */
export function acpCatalog(result: unknown): Catalog {
  const catalog: Catalog = { models: [], current: undefined };
  const option = values(at(result, "configOptions")).find(
    (entry) =>
      at(entry, "type") === "select" &&
      (at(entry, "category") === "model" || at(entry, "id") === "model"),
  );
  if (option !== undefined) {
    catalog.current = field(at(option, "currentValue"));
    collectChoices(at(option, "options"), undefined, 0, catalog.models);
  }
  if (catalog.models.length === 0) {
    const models = at(result, "models");
    catalog.current = field(at(models, "currentModelId")) ?? catalog.current;
    catalog.models = values(at(models, "availableModels")).flatMap((model) => {
      const id = field(at(model, "modelId"));
      return id === undefined
        ? []
        : [modelEntry(id, at(model, "name"), field(at(model, "provider")))];
    });
  }
  dedupCatalog(catalog);
  return catalog;
}
