import { Trans, useLingui } from "@lingui/react/macro";
import type { CapabilityInstall, PluginMarketplaceEntry } from "@rakazo/contracts";
import {
  isRecommendedPlugin,
  matchesPluginQuery,
  OTHER_PLUGINS,
  PLUGIN_CATEGORIES,
} from "@rakazo/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SectionHeading,
  Spinner,
} from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { PluginSelection } from "../../components/integrations/plugin-marketplace";
import { PluginRow, pluginSelection } from "../../components/integrations/plugin-marketplace";
import { usePluginCategoryLabel } from "./use-catalog-browse";
import type { PluginConnections } from "./use-plugin-connections";

const NO_PLUGINS: PluginMarketplaceEntry[] = [];
const SECTION_SIZE = 6;
const PAGE_SIZE = 24;
const CHIP_COUNT = 6;

/** The marketplace's packages in the Store's Apps, beside the community entries. */
export function PackageBrowse({
  pluginCatalog,
  installs,
  query,
  community,
  onOpen,
}: {
  pluginCatalog: PluginConnections["pluginCatalog"];
  installs: readonly CapabilityInstall[];
  query: string;
  /** Community entries for the same search, shown unless a category is chosen. */
  community: ReactNode;
  onOpen: (selection: PluginSelection) => void;
}) {
  const { t } = useLingui();
  const categoryLabel = usePluginCategoryLabel();
  const [category, setCategory] = useState<string | null>(null);
  const [count, setCount] = useState(PAGE_SIZE);
  const entries = pluginCatalog.data?.entries ?? NO_PLUGINS;
  const searching = query.trim().length > 0;
  const categories: string[] = PLUGIN_CATEGORIES.filter((name) =>
    entries.some((entry) => entry.category === name),
  );
  const inCategory = (entry: PluginMarketplaceEntry) =>
    !category || entry.category === (category === OTHER_PLUGINS ? null : category);
  const matches = entries.filter(
    (entry) =>
      inCategory(entry) &&
      matchesPluginQuery(entry, query, entry.category ? categoryLabel(entry.category) : ""),
  );

  function choose(name: string | null) {
    setCategory(name);
    setCount(PAGE_SIZE);
  }

  function row(entry: PluginMarketplaceEntry) {
    const selection = pluginSelection(entry);
    return (
      <PluginRow
        key={entry.id}
        name={entry.displayName}
        description={entry.description}
        logo={entry.logo}
        site={selection.site}
        installed={installs.some((install) => install.source === entry.installedSource)}
        onOpen={() => onOpen(selection)}
      />
    );
  }

  function packages() {
    if (pluginCatalog.isPending)
      return (
        <div className="grid place-items-center py-8">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading apps…`} />
        </div>
      );
    if (category || searching)
      return matches.length ? (
        <section data-testid="plugin-results">
          <div className="grid grid-cols-2 gap-2">{matches.slice(0, count).map(row)}</div>
          {count < matches.length ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCount((shown) => shown + PAGE_SIZE)}
              >
                <Trans>Show more</Trans>
              </Button>
            </div>
          ) : null}
        </section>
      ) : null;
    const recommended = entries.filter(isRecommendedPlugin).slice(0, SECTION_SIZE);
    const uncategorized = entries.filter((entry) => !entry.category);
    const sections: Array<[string, string, PluginMarketplaceEntry[]]> = [
      ...categories.map((name): [string, string, PluginMarketplaceEntry[]] => [
        name,
        categoryLabel(name),
        entries.filter((entry) => entry.category === name),
      ]),
      ...(uncategorized.length
        ? [[OTHER_PLUGINS, t`More`, uncategorized] as [string, string, PluginMarketplaceEntry[]]]
        : []),
    ];
    return (
      <>
        {recommended.length ? (
          <section data-testid="plugin-section">
            <SectionHeading as="h2" className="mb-2 px-2.5">
              <Trans>Recommended</Trans>
            </SectionHeading>
            <div className="grid grid-cols-2 gap-2">{recommended.map(row)}</div>
          </section>
        ) : null}
        {sections.map(([name, label, rows]) => (
          <section key={name} data-testid="plugin-section">
            <div className="mb-2 flex items-center justify-between px-2.5">
              <SectionHeading as="h2">{label}</SectionHeading>
              {rows.length > SECTION_SIZE ? (
                <Button variant="text" size="sm" onClick={() => choose(name)}>
                  <Trans>View all</Trans>
                </Button>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2">{rows.slice(0, SECTION_SIZE).map(row)}</div>
          </section>
        ))}
      </>
    );
  }

  const moreChosen = category && !categories.slice(0, CHIP_COUNT).includes(category);
  return (
    <div className="space-y-8">
      {categories.length >= 2 || category ? (
        <div className="flex flex-wrap gap-2" data-testid="plugin-categories">
          {[null, ...categories.slice(0, CHIP_COUNT)].map((name) => (
            <Button
              key={name ?? "all"}
              type="button"
              variant={category === name ? "default" : "secondary"}
              aria-pressed={category === name}
              className="rounded-full px-3.5 text-body-sm"
              onClick={() => choose(name)}
            >
              {name ? categoryLabel(name) : <Trans>All</Trans>}
            </Button>
          ))}
          {categories.length > CHIP_COUNT ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant={moreChosen ? "default" : "secondary"}
                    className="rounded-full px-3.5 text-body-sm"
                  />
                }
              >
                {moreChosen ? categoryLabel(category) : <Trans>More</Trans>}
                <ChevronDown />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-auto">
                {categories.slice(CHIP_COUNT).map((name) => (
                  <DropdownMenuItem key={name} onClick={() => choose(name)}>
                    {categoryLabel(name)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
      {category ? null : community}
      {pluginCatalog.error || pluginCatalog.data?.unavailableRegistries.length ? (
        <div role="alert" className="flex items-center gap-3 text-body text-muted-foreground">
          <Trans>Some apps could not be loaded.</Trans>
          <Button variant="outline" size="sm" onClick={() => void pluginCatalog.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {packages()}
    </div>
  );
}
