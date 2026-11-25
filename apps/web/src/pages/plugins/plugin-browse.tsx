import { Trans, useLingui } from "@lingui/react/macro";
import type { ConnectionCatalogItem, McpSourcePreset } from "@rakazo/contracts";
import { CATALOG_SEARCH_QUERY_MAX_LENGTH, mcpServerConnection } from "@rakazo/contracts";
import { CONNECTION_CATALOG_PAGE_SIZE, catalogItemKey } from "@rakazo/core";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { Search } from "lucide-react";
import type { ReactNode } from "react";
import type { PluginSelection } from "../../components/integrations/plugin-marketplace";
import {
  PluginLogo,
  PluginRow,
  ROW_BUTTON,
  ROW_HOVER,
  ROW_SHELL,
} from "../../components/integrations/plugin-marketplace";
import type { TileContext } from "./parts";
import { CatalogTile } from "./parts";
import type { CatalogBrowse } from "./use-catalog-browse";
import type { PluginConnections } from "./use-plugin-connections";

/** The Connections page under the search: what is connected, featured and recommended, then the rest. */
export function PluginBrowse({
  browse,
  state,
  tileContext,
  connectedPlugins,
  onOpenPlugin,
  onSearchPublic,
  onConnectPreset,
  onManageConnections,
  plugins,
}: {
  browse: CatalogBrowse;
  state: PluginConnections;
  tileContext: TileContext;
  /** Installed plugins whose connections all work. */
  connectedPlugins: readonly PluginSelection[];
  onOpenPlugin: (selection: PluginSelection) => void;
  /** Opens the public MCP catalog searched for the query. */
  onSearchPublic: (query: string) => void;
  /** Opens the source form for one of the server's connector presets. */
  onConnectPreset: (preset: McpSourcePreset) => void;
  /** Shows the connections already added, where a preset's server is managed. */
  onManageConnections: () => void;
  /** Apps matching the search, which the Store opens in Apps. */
  plugins?: ReactNode;
}) {
  const { catalogLoaded, catalog } = state;
  const {
    query,
    setVisibleCount,
    featuredTiles,
    showFeatured,
    visible,
    strongMatches,
    weakMatches,
    rendered,
    catalogsReady,
    recommendedApps,
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
  const leadWithConnected = showFeatured;
  const connectedApps = leadWithConnected ? catalog.filter(state.itemConnected) : [];
  const connectedPresets = leadWithConnected ? presets.filter(presetConnected) : [];
  const connectedPluginRows = leadWithConnected ? connectedPlugins : [];
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

  const recommended = recommendedApps.length ? (
    <section data-testid="recommended-apps" className="mt-8">
      <SectionHeading as="h2" className="mb-2 px-2.5">
        <Trans>Recommended</Trans>
      </SectionHeading>
      <div className="grid grid-cols-2 gap-2">
        {recommendedApps.map((item) => catalogTile(item, item.name, item.logo))}
      </div>
    </section>
  ) : null;

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
      {connectedApps.length || connectedPresets.length || connectedPluginRows.length ? (
        <section data-testid="connected-now" className="mb-8">
          <SectionHeading as="h2" className="mb-2 px-2.5">
            <Trans>Connected</Trans>
          </SectionHeading>
          <div className="grid grid-cols-2 gap-2">
            {connectedApps.map((item) => catalogTile(item, item.name, item.logo))}
            {connectedPresets.map(presetRow)}
            {connectedPluginRows.map((selection) => (
              <PluginRow
                key={selection.installedSource}
                name={selection.name}
                description=""
                logo={selection.logo}
                site={selection.site}
                installed
                onOpen={() => onOpenPlugin(selection)}
              />
            ))}
          </div>
        </section>
      ) : null}
      {catalogLoaded && showFeatured ? (
        <div className="mb-6" data-testid="featured-connectors">
          {catalog.length === 0 ? (
            presetGrid ? (
              presetGrid
            ) : !catalogsReady ? null : (
              <p className="text-body leading-6 text-muted-foreground/80">
                <Trans>Configure a connection catalog on the server.</Trans>
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
                            <Trans>Not in the catalog</Trans>
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

      {catalogsReady && visible.length === 0 && !showFeatured && !presets.length ? (
        <p className="text-muted-foreground/80" role="status">
          <Trans>No connections match your search.</Trans>
        </p>
      ) : null}
      {showFeatured ? (
        <>
          {recommended}
          {catalogLoaded && catalog.length > 0 ? (
            <SectionHeading as="h2" className="mt-8 mb-2 px-2.5">
              <Trans>More connections</Trans>
            </SectionHeading>
          ) : null}
          {visible.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {rendered.map((item) =>
                catalogTile(item, item.name, item.logo, {
                  // Avoid duplicate connection-tile-* ids while featured is also shown.
                  tileTestId: !showFeatured,
                }),
              )}
            </div>
          ) : null}
          {rendered.length < visible.length ? (
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
          {strongMatches.length > 0 ? (
            <div className="mb-2 grid grid-cols-2 gap-2">
              {strongMatches.map((item) =>
                catalogTile(item, item.name, item.logo, { tileTestId: true }),
              )}
            </div>
          ) : null}
          {presetGrid ? <div className="mb-2">{presetGrid}</div> : null}
          {plugins}
          {rendered.length > 0 ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {rendered.map((item) =>
                catalogTile(item, item.name, item.logo, { tileTestId: true }),
              )}
            </div>
          ) : null}
          {rendered.length < weakMatches.length ? (
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
          {query.trim().length >= 2 && query.trim().length <= CATALOG_SEARCH_QUERY_MAX_LENGTH
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
        <PluginLogo
          name={preset.name}
          logo={preset.logo}
          site={site ? new URL(site).hostname : null}
        />
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
