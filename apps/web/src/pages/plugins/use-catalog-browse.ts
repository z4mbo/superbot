import { useLingui } from "@lingui/react/macro";
import type { ConnectionCatalogItem, PluginMarketplaceEntry } from "@rakazo/contracts";
import type { PluginCategory } from "@rakazo/core";
import {
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemKey,
  filterConnectionCatalogItems,
  integrationCatalogsReady,
  isRecommendedPlugin,
  managedAppFor,
  matchesWordPrefixes,
} from "@rakazo/core";
import { useMemo, useState } from "react";
import type { PluginConnections } from "./use-plugin-connections";

const NO_PLUGINS: PluginMarketplaceEntry[] = [];
const RECOMMENDED_APPS = 6;

export type CatalogBrowse = ReturnType<typeof useCatalogBrowse>;

/** The Apps page's search and paging, and what they pick from the app catalog. */
export function useCatalogBrowse({
  catalog,
  catalogLoaded,
  loadError,
  pluginCatalog,
}: {
  catalog: ConnectionCatalogItem[];
  catalogLoaded: boolean;
  loadError: string | null;
  pluginCatalog: PluginConnections["pluginCatalog"];
}) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);

  const featuredTiles = useMemo(() => buildFeaturedConnectorTiles(catalog), [catalog]);
  const showFeatured = !query.trim();

  const visible = useMemo(() => filterConnectionCatalogItems(catalog, query), [catalog, query]);
  // Apps whose name starts with the query come first; mid-word matches trail them.
  const strongMatches = showFeatured
    ? []
    : visible.filter((item) => matchesWordPrefixes(item.name, query));
  const weakMatches = showFeatured
    ? visible
    : visible.filter((item) => !matchesWordPrefixes(item.name, query));
  const rendered = weakMatches.slice(0, visibleCount);

  const catalogEntries = pluginCatalog.data?.entries ?? NO_PLUGINS;
  // An empty managed catalog says nothing about plugins that are still loading or unavailable.
  const catalogsReady = integrationCatalogsReady({
    catalogLoaded,
    catalogFailed: !!loadError,
    pluginsLoaded: pluginCatalog.isSuccess,
    pluginsUnavailable: !!pluginCatalog.data?.unavailableRegistries.length,
  });
  // A plugin for a managed app lends that app its skills instead of being listed as its own app.
  const { pluginForApp, recommendedApps } = useMemo(() => {
    const forApp = new Map<string, PluginMarketplaceEntry>();
    const recommended = new Map<string, ConnectionCatalogItem>();
    for (const entry of catalogEntries) {
      const app = managedAppFor(entry, catalog);
      if (!app) continue;
      if (entry.skillCount && !forApp.has(catalogItemKey(app)))
        forApp.set(catalogItemKey(app), entry);
      if (isRecommendedPlugin(entry)) recommended.set(catalogItemKey(app), app);
    }
    return {
      pluginForApp: forApp,
      recommendedApps: [...recommended.values()].slice(0, RECOMMENDED_APPS),
    };
  }, [catalog, catalogEntries]);

  return {
    query,
    setQuery,
    visibleCount,
    setVisibleCount,
    featuredTiles,
    showFeatured,
    visible,
    strongMatches,
    weakMatches,
    rendered,
    catalogEntries,
    catalogsReady,
    pluginForApp,
    recommendedApps,
  };
}

/** A marketplace category's name in the reader's language. */
export function usePluginCategoryLabel() {
  const { t } = useLingui();
  const labels: Record<PluginCategory, string> = {
    productivity: t`Productivity`,
    communication: t`Communication`,
    sales: t`Sales & CRM`,
    marketing: t`Marketing`,
    finance: t`Finance`,
    people: t`Recruiting & HR`,
    design: t`Design`,
    code: t`Developer`,
    data: t`Data`,
    ops: t`Security & Ops`,
  };
  return (name: string) => labels[name as PluginCategory] ?? name;
}
