import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ConnectionCatalogItem,
  McpSourcePreset,
  PluginMarketplaceEntry,
} from "@rakazo/contracts";
import { CATALOG_SEARCH_QUERY_MAX_LENGTH, mcpServerConnection } from "@rakazo/contracts";
import {
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemKey,
  isRecommendedPlugin,
  managedAppFor,
  OTHER_PLUGINS,
} from "@rakazo/core";
import { Button, SectionHeading, Spinner } from "@rakazo/ui-web";
import { Search } from "lucide-react";
import type { ReactNode } from "react";
import type { PluginSelection } from "../../components/integrations/plugin-marketplace";
import {
  PluginLogo,
  PluginRow,
  pluginSelection,
  ROW_BUTTON,
  ROW_HOVER,
  ROW_SHELL,
} from "../../components/integrations/plugin-marketplace";
import type { TileContext } from "./parts";
import { CatalogTile } from "./parts";
import type { CatalogBrowse } from "./use-catalog-browse";
import { PLUGIN_PAGE_SIZE } from "./use-catalog-browse";
import type { PluginConnections } from "./use-plugin-connections";

const SECTION_SIZE = 6;

/** The browse page under the search: featured apps, plugin sections or matches, and more apps. */
export function PluginBrowse({
  browse,
  state,
  tileContext,
  onOpenPlugin,
  onSearchPublic,
  onConnectPreset,
  onManageConnections,
  community,
}: {
  browse: CatalogBrowse;
  state: PluginConnections;
  tileContext: TileContext;
  onOpenPlugin: (selection: PluginSelection) => void;
  /** Opens the public MCP catalog searched for the query. */
  onSearchPublic: (query: string) => void;
  /** Opens the source form for one of the server's connector presets. */
  onConnectPreset: (preset: McpSourcePreset) => void;
  /** Shows the connections already added, where a preset's server is managed. */
  onManageConnections: () => void;
  /** Community plugins for the same search, shown outside a category. */
  community?: ReactNode;
}) {
  const { t } = useLingui();
  const { catalogLoaded, catalog, pluginCatalog, pluginInstalls } = state;
  const {
    query,
    setVisibleCount,
    category,
    setCategory,
    pluginCount,
    setPluginCount,
    featuredTiles,
    showFeatured,
    visible,
    strongMatches,
    weakMatches,
    rendered,
    catalogEntries,
    catalogsReady,
    plugins,
    categoryLabel,
    categories,
    brandMatches,
    searching,
    pluginMatches,
  } = browse;
  // A preset the managed catalog also connects is offered once, as the managed app.
  const managedNames = new Set(catalog.map((item) => item.name.toLowerCase()));
  const needle = query.trim().toLowerCase();
  const presetServer = (preset: McpSourcePreset) =>
    preset.url ? state.mcpServers.find((server) => server.endpoint === preset.url) : undefined;
  const presetAdded = (preset: McpSourcePreset) => Boolean(presetServer(preset));
  const presetConnected = (preset: McpSourcePreset) => {
    const server = presetServer(preset);
    return Boolean(server && mcpServerConnection(server) === "connected");
  };
  const presets = state.sourcePresets.filter(
    (preset) =>
      !managedNames.has(preset.name.toLowerCase()) &&
      (!needle || preset.name.toLowerCase().includes(needle)),
  );
  // Before a search, what is already connected leads the page instead of sitting among the rest.
  const leadWithConnected = showFeatured && !category;
  const connectedApps = leadWithConnected ? catalog.filter(state.itemConnected) : [];
  const connectedPresets = leadWithConnected ? presets.filter(presetConnected) : [];
  const presetRow = (preset: McpSourcePreset) => (
    <PresetRow
      key={preset.id}
      preset={preset}
      status={presetConnected(preset) ? "connected" : presetAdded(preset) ? "added" : null}
      onOpen={() => (presetAdded(preset) ? onManageConnections() : onConnectPreset(preset))}
    />
  );
  const listedPresets = leadWithConnected ? presets.filter((p) => !presetConnected(p)) : presets;
  const presetGrid = listedPresets.length ? (
    <div data-testid="source-presets" className="grid grid-cols-2 gap-2">
      {listedPresets.map(presetRow)}
    </div>
  ) : null;
  const installedPlugin = (installedSource: string) =>
    pluginInstalls.find((row) => row.source === installedSource);

  function catalogTile(
    item: ConnectionCatalogItem,
    label: string,
    logo?: string | null,
    opts?: { tileTestId?: boolean },
  ) {
    return (
      <CatalogTile
        key={catalogItemKey(item)}
        item={item}
        label={label}
        logo={logo}
        tileTestId={opts?.tileTestId}
        context={tileContext}
      />
    );
  }

  function renderPluginRow(entry: PluginMarketplaceEntry) {
    const selection = pluginSelection(entry);
    return (
      <PluginRow
        key={entry.id}
        name={entry.displayName}
        description={entry.description}
        logo={entry.logo}
        site={selection.site}
        installed={Boolean(installedPlugin(entry.installedSource))}
        onOpen={() => onOpenPlugin(selection)}
      />
    );
  }

  function renderPluginSections() {
    if (pluginCatalog.isPending)
      return (
        <div className="grid place-items-center py-8">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading plugins…`} />
        </div>
      );
    const unavailable =
      pluginCatalog.error || pluginCatalog.data?.unavailableRegistries.length ? (
        <div role="alert" className="mt-6 flex items-center gap-3 text-body text-muted-foreground">
          <Trans>Some plugins could not be loaded.</Trans>
          <Button variant="outline" size="sm" onClick={() => void pluginCatalog.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null;
    return (
      <>
        {unavailable}
        {renderPluginResults()}
      </>
    );
  }

  function renderPluginResults() {
    if (category || searching)
      return pluginMatches.length || brandMatches.length ? (
        <section data-testid="plugin-results" className="mt-2">
          <div className="grid grid-cols-2 gap-2">
            {brandMatches.map(({ item }) => catalogTile(item, item.name, item.logo))}
            {pluginMatches.slice(0, pluginCount).map(renderPluginRow)}
          </div>
          {pluginCount < pluginMatches.length ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPluginCount((count) => count + PLUGIN_PAGE_SIZE)}
              >
                <Trans>Show more</Trans>
              </Button>
            </div>
          ) : null}
        </section>
      ) : null;
    // A recommended brand this deployment already offers as a managed app is listed as that app.
    const recommended = catalogEntries
      .filter(isRecommendedPlugin)
      .map((entry) => ({ entry, item: managedAppFor(entry, catalog) }))
      .filter(({ entry, item }) => item || entry.hasConnector)
      .slice(0, SECTION_SIZE);
    const uncategorized = plugins.filter((entry) => !entry.category);
    const sections: Array<[string, string, PluginMarketplaceEntry[]]> = [
      ...categories.map((name): [string, string, PluginMarketplaceEntry[]] => [
        name,
        categoryLabel(name),
        plugins.filter((entry) => entry.category === name),
      ]),
      ...(uncategorized.length
        ? [[OTHER_PLUGINS, t`More`, uncategorized] as [string, string, PluginMarketplaceEntry[]]]
        : []),
    ].filter(([, , entries]) => entries.length);
    return (
      <>
        {recommended.length ? (
          <section data-testid="plugin-section" className="mt-8">
            <SectionHeading as="h2" className="mb-2 px-2.5">
              <Trans>Recommended</Trans>
            </SectionHeading>
            <div className="grid grid-cols-2 gap-2">
              {recommended.map(({ entry, item }) =>
                item ? catalogTile(item, item.name, item.logo) : renderPluginRow(entry),
              )}
            </div>
          </section>
        ) : null}
        {sections.map(([name, label, entries]) => (
          <section key={name} data-testid="plugin-section" className="mt-8">
            <div className="mb-2 flex items-center justify-between px-2.5">
              <SectionHeading as="h2">{label}</SectionHeading>
              {entries.length > SECTION_SIZE ? (
                <Button variant="text" size="sm" onClick={() => setCategory(name)}>
                  <Trans>View all</Trans>
                </Button>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {entries.slice(0, SECTION_SIZE).map(renderPluginRow)}
            </div>
          </section>
        ))}
      </>
    );
  }

  /** Nothing leaves for the public catalog until the person picks this row. */
  function renderPublicCatalogRow(query: string) {
    return (
      <div className={`mt-2 ${ROW_SHELL} ${ROW_HOVER}`}>
        <button
          type="button"
          className={ROW_BUTTON}
          onClick={() => {
            onSearchPublic(query);
          }}
        >
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border/60 bg-accent text-muted-foreground">
            <Search className="size-4" />
          </div>
          <span className="min-w-0 flex-1 truncate text-body-lg font-medium text-foreground">
            <Trans>Search MCP servers for “{query}”</Trans>
          </span>
        </button>
      </div>
    );
  }

  return (
    <>
      {connectedApps.length || connectedPresets.length ? (
        <section data-testid="connected-apps" className="mb-8">
          <SectionHeading as="h2" className="mb-2 px-2.5">
            <Trans>Connected</Trans>
          </SectionHeading>
          <div className="grid grid-cols-2 gap-2">
            {connectedApps.map((item) => catalogTile(item, item.name, item.logo))}
            {connectedPresets.map(presetRow)}
          </div>
        </section>
      ) : null}
      {catalogLoaded && showFeatured && !category ? (
        <div className="mb-6" data-testid="featured-connectors">
          {catalog.length === 0 ? (
            presetGrid ? (
              presetGrid
            ) : !catalogsReady || plugins.length ? null : (
              <p className="text-body leading-6 text-muted-foreground/80">
                <Trans>Configure a plugin catalog on the server to connect apps.</Trans>
              </p>
            )
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {featuredTiles
                .filter((tile) => !(tile.item && state.itemConnected(tile.item)))
                .map((tile) => {
                  const item = tile.item;
                  const key = item ? catalogItemKey(item) : tile.id;
                  const disabled = tile.missing || !item;
                  if (item && !tile.missing) {
                    // Featured is the stable hit target for connection-tile-* in E2E.
                    return catalogTile(item, tile.label, item.logo, {
                      tileTestId: true,
                    });
                  }
                  return (
                    <div
                      key={key}
                      className={`flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 ${
                        disabled ? "opacity-70" : ""
                      }`}
                    >
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-body font-semibold text-foreground">
                        {tile.label[0]}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body-lg font-medium text-foreground">
                          {tile.label}
                        </div>
                        {disabled ? (
                          <div className="truncate text-body-sm text-muted-foreground">
                            <Trans>Not in the plugin catalog</Trans>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
          {catalog.length && presetGrid ? <div className="mt-2">{presetGrid}</div> : null}
        </div>
      ) : null}

      {catalogsReady &&
      visible.length === 0 &&
      !showFeatured &&
      !pluginMatches.length &&
      !brandMatches.length &&
      !presets.length ? (
        <p className="text-muted-foreground/80">
          <Trans>No apps match your search.</Trans>
        </p>
      ) : null}
      {showFeatured ? (
        <>
          {category ? null : community}
          {renderPluginSections()}
          {catalogLoaded && catalog.length > 0 && !category ? (
            <SectionHeading as="h2" className="mt-8 mb-2 px-2.5">
              <Trans>More apps</Trans>
            </SectionHeading>
          ) : null}
          {visible.length > 0 && !category ? (
            <div className="grid grid-cols-2 gap-2">
              {rendered.map((item) =>
                catalogTile(item, item.name, item.logo, {
                  // Avoid duplicate connection-tile-* ids while featured is also shown.
                  tileTestId: !showFeatured,
                }),
              )}
            </div>
          ) : null}
          {rendered.length < visible.length && !category ? (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)}
              >
                <Trans>Show more</Trans>
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {strongMatches.length > 0 && !category ? (
            <div className="mb-2 grid grid-cols-2 gap-2">
              {strongMatches.map((item) =>
                catalogTile(item, item.name, item.logo, { tileTestId: true }),
              )}
            </div>
          ) : null}
          {category || !presetGrid ? null : <div className="mb-2">{presetGrid}</div>}
          {category ? null : community}
          {renderPluginSections()}
          {rendered.length > 0 && !category ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {rendered.map((item) =>
                catalogTile(item, item.name, item.logo, { tileTestId: true }),
              )}
            </div>
          ) : null}
          {rendered.length < weakMatches.length && !category ? (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)}
              >
                <Trans>Show more</Trans>
              </Button>
            </div>
          ) : null}
          {query.trim().length >= 2 &&
          query.trim().length <= CATALOG_SEARCH_QUERY_MAX_LENGTH &&
          !category
            ? renderPublicCatalogRow(query.trim())
            : null}
        </>
      )}
    </>
  );
}

function PresetRow({
  preset,
  status,
  onOpen,
}: {
  preset: McpSourcePreset;
  /** Added means its server exists here but is not signed in or working yet. */
  status: "connected" | "added" | null;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const site = preset.url ?? preset.defaultUrl;
  return (
    <div data-testid="source-preset" className={`${ROW_SHELL} ${ROW_HOVER}`}>
      <button type="button" aria-label={preset.name} onClick={onOpen} className={ROW_BUTTON}>
        <PluginLogo name={preset.name} site={site ? new URL(site).hostname : null} />
        <span className="min-w-0 flex-1 truncate text-body-lg font-medium text-foreground">
          {preset.name}
        </span>
      </button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label={
          status === "connected"
            ? t`Manage ${preset.name}, connected`
            : status === "added"
              ? t`Manage ${preset.name}, not connected yet`
              : t`Connect ${preset.name}`
        }
        onClick={onOpen}
      >
        {status === "connected" ? (
          <Trans>Connected</Trans>
        ) : status === "added" ? (
          <Trans>Manage</Trans>
        ) : (
          <Trans>Connect</Trans>
        )}
      </Button>
    </div>
  );
}
