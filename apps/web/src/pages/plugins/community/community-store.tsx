import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { AppListing, Bot } from "@rakazo/contracts";
import { MAX_REGISTRY_SEARCH_LENGTH } from "@rakazo/contracts";
import { catalogItemKey, managedAppFor, matchesPluginQuery } from "@rakazo/core";
import {
  Button,
  Input,
  SectionHeading,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { NotebookPen, Plus } from "lucide-react";
import { useState } from "react";
import type {
  ManagedAppLink,
  PluginSelection,
} from "../../../components/integrations/plugin-marketplace";
import {
  PluginDetail,
  PluginLogo,
  PluginRow,
  pluginSelection,
  ROW_BUTTON,
  ROW_HOVER,
  ROW_SHELL,
} from "../../../components/integrations/plugin-marketplace";
import { useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { AppDetail } from "../apps/app-detail";
import { AppSection } from "../apps/app-section";
import { PackageBrowse } from "../package-browse";
import { ViewTitle } from "../parts";
import type { PluginPick } from "../plugin-picks";
import { usePluginCategoryLabel } from "../use-catalog-browse";
import { usePluginConnections } from "../use-plugin-connections";
import { AppRunner } from "./app-runner";
import { CommunityDetail } from "./community-detail";
import { CreatePlugin } from "./create-plugin";
import type { RegistryInstallation, RegistryVersion } from "./registry";
import { appParts, grantedBots, latestBySlug, REGISTRY_PAGE_SIZE, readAllPages } from "./registry";
import { ReviewQueue } from "./review-queue";

type Tab = "discover" | "installed" | "create" | "review";

const closeNothing = () => undefined;

/**
 * The Store's Apps: reviewed page apps, the source marketplace's packages and the deployment
 * registry's community entries, what is installed of the last two, and authoring and review of
 * community entries.
 */
export function CommunityStore({
  activeBotId,
  initialPick,
  onBack,
  onOpenConnections,
}: {
  activeBotId?: string;
  /** An app to show first, picked from elsewhere. */
  initialPick?: PluginPick;
  /** Shown with a title and a way back when the store is opened from another view. */
  onBack?: () => void;
  /** Where an app for a managed connection sends the person to manage that connection. */
  onOpenConnections?: () => void;
}) {
  const { t } = useLingui();
  const categoryLabel = usePluginCategoryLabel();
  const connections = usePluginConnections({
    activeBotId,
    detailKey: null,
    closeDetail: closeNothing,
  });
  const catalogEntries = connections.pluginCatalog.data?.entries ?? [];
  const [openPackage, setOpenPackage] = useState<PluginSelection | null>(
    initialPick?.kind === "package" ? initialPick.selection : null,
  );
  const queries = useSpaceQueries();
  const registry = queries.pluginRegistry;
  const [tab, setTab] = useState<Tab>("discover");
  const [openPlugin, setOpenPlugin] = useState<{ slug: string; version?: number } | null>(
    initialPick?.kind === "community" ? { slug: initialPick.slug } : null,
  );
  const [openApp, setOpenApp] = useState<{ slug: string; partId: string } | null>(null);
  const [openListing, setOpenListing] = useState<AppListing | null>(null);
  const [template, setTemplate] = useState<{ key: number; version: RegistryVersion } | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const searchText = search.trim();
  const waitingForSearch = searchText !== query;
  useTimeout(() => setQuery(searchText), waitingForSearch ? 200 : null, searchText);
  // The same read as the page apps listed above the results, to tell when nothing matches.
  const appCatalog = useQuery(queries.apps.catalog.queryOptions({ input: { query: searchText } }));
  const appMatch = Boolean(appCatalog.data?.length);
  const me = useQuery(queries.me.queryOptions());
  const bots = useQuery(queries.bots.list.queryOptions());
  const installations = useRegistryInstallations();
  const discover = useInfiniteQuery(
    registry.discover.infiniteOptions({
      input: (after: string | null) => ({
        limit: REGISTRY_PAGE_SIZE,
        ...(query ? { query } : {}),
        ...(after ? { after } : {}),
      }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextAfter,
    }),
  );
  const installs = installations.data ?? [];
  const installFor = (slug: string) => installs.find((row) => row.plugin.slug === slug);
  const botList = bots.data ?? [];

  const appInstallation = openApp ? installFor(openApp.slug) : undefined;
  const appPart = appInstallation
    ? appParts(appInstallation.plugin.manifest).find((part) => part.id === openApp?.partId)
    : undefined;
  if (openApp && appInstallation && appPart)
    return (
      <AppRunner
        key={`${appInstallation.id}:${appInstallation.plugin.id}:${appPart.id}`}
        installation={appInstallation}
        part={appPart}
        onBack={() => setOpenApp(null)}
      />
    );

  if (openListing)
    return (
      <AppDetail
        key={openListing.appId}
        listing={openListing}
        onBack={() => setOpenListing(null)}
      />
    );

  if (openPackage)
    return (
      <PluginDetail
        key={openPackage.installedSource}
        selection={openPackage}
        installs={connections.pluginInstalls}
        servers={connections.mcpServers}
        assigned={connections.assigned}
        activeBotId={activeBotId}
        managed={managedLink(openPackage)}
        onBack={() => setOpenPackage(null)}
        onChanged={connections.refresh}
      />
    );

  if (openPlugin)
    return (
      <CommunityDetail
        key={openPlugin.slug}
        slug={openPlugin.slug}
        preferredVersion={openPlugin.version}
        installation={installFor(openPlugin.slug)}
        bots={botList}
        activeBotId={activeBotId}
        onBack={() => setOpenPlugin(null)}
        onOpenApp={(partId) => setOpenApp({ slug: openPlugin.slug, partId })}
        onUseTemplate={(version) => {
          setTemplate({ key: Date.now(), version });
          setOpenPlugin(null);
          setTab("create");
        }}
      />
    );

  function managedLink(selection: PluginSelection): ManagedAppLink | undefined {
    const entry = catalogEntries.find((row) => row.installedSource === selection.installedSource);
    const item = entry && onOpenConnections ? managedAppFor(entry, connections.catalog) : undefined;
    if (!item || !onOpenConnections) return undefined;
    return {
      name: item.name,
      logo: item.logo,
      connected: connections.itemConnected(item),
      connecting: connections.pending === catalogItemKey(item),
      onConnect: () => void connections.connect(item),
      onManage: onOpenConnections,
    };
  }

  function installedSelection(source: string, name: string): PluginSelection {
    const entry = catalogEntries.find((row) => row.installedSource === source);
    return entry ? pluginSelection(entry) : { source, installedSource: source, name };
  }

  const latest = latestBySlug(discover.data?.pages.flatMap((page) => page.items) ?? []);
  const packageMatch = catalogEntries.some((entry) =>
    matchesPluginQuery(entry, search, entry.category ? categoryLabel(entry.category) : ""),
  );
  const loadingResults = waitingForSearch || discover.isPending;
  const discoverError =
    discover.isError && !latest.length ? (
      <LoadError
        text={errorText(discover.error, t`Could not load community apps`)}
        onRetry={() => void discover.refetch()}
      />
    ) : null;

  function communityResults() {
    if (loadingResults) return <Loading />;
    if (discoverError) return discoverError;
    if (!latest.length)
      return search && !packageMatch && !appMatch ? (
        <p className="px-1 text-body text-muted-foreground">
          <Trans>No apps match your search.</Trans>
        </p>
      ) : null;
    return (
      <section>
        <SectionHeading as="h2" className="mb-2 px-2.5">
          <Trans>Community</Trans>
        </SectionHeading>
        <div data-testid="community-results" className="grid gap-2 sm:grid-cols-2">
          {latest.map((version) => (
            <PluginRow
              key={version.slug}
              name={version.manifest.name}
              description={version.manifest.description}
              installed={Boolean(installFor(version.slug))}
              onOpen={() =>
                setOpenPlugin({
                  slug: version.slug,
                  version: query ? version.version : undefined,
                })
              }
            />
          ))}
        </div>
        {discover.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              disabled={discover.isFetchingNextPage}
              onClick={() => void discover.fetchNextPage()}
            >
              <Trans>Show more</Trans>
            </Button>
          </div>
        ) : null}
      </section>
    );
  }

  function discoverTab() {
    if (!search && !query) {
      if (loadingResults && !catalogEntries.length) return <Loading />;
      if (
        !loadingResults &&
        !discoverError &&
        !latest.length &&
        !discover.hasNextPage &&
        connections.pluginCatalog.isSuccess &&
        !catalogEntries.length &&
        appCatalog.isSuccess &&
        !appMatch
      )
        return (
          <div className="flex flex-col items-start gap-3 px-1">
            <p className="text-body text-muted-foreground">
              <Trans>No apps yet.</Trans>
            </p>
            <Button variant="secondary" size="sm" onClick={() => setTab("create")}>
              <Plus />
              <Trans>Create app</Trans>
            </Button>
          </div>
        );
    }
    return (
      <div className="space-y-6">
        <Input
          value={search}
          maxLength={MAX_REGISTRY_SEARCH_LENGTH}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t`Search apps`}
          placeholder={t`Search apps`}
        />
        <PackageBrowse
          pluginCatalog={connections.pluginCatalog}
          installs={connections.pluginInstalls}
          query={searchText}
          community={
            <>
              {/* The section brings its own top margin; the list here spaces its sections. */}
              <div className="empty:hidden *:mt-0">
                <AppSection query={searchText} onOpen={setOpenListing} />
              </div>
              {communityResults()}
            </>
          }
          onOpen={setOpenPackage}
        />
      </div>
    );
  }

  function installedTab() {
    if (installations.isPending || !connections.catalogLoaded) return <Loading />;
    if (installations.isError)
      return (
        <LoadError
          text={errorText(installations.error, t`Could not load installed apps`)}
          onRetry={() => void installations.refetch()}
        />
      );
    if (!installs.length && !connections.pluginInstalls.length)
      return (
        <p className="px-1 text-body text-muted-foreground">
          <Trans>No apps installed in this space.</Trans>
        </p>
      );
    return (
      <div data-testid="community-installed" className="space-y-1">
        {connections.pluginInstalls.map((install) => {
          const selection = installedSelection(install.source, install.name);
          return (
            <div key={install.id} data-testid="package-installed-row">
              <PluginRow
                name={selection.name}
                description={selection.description ?? ""}
                logo={selection.logo}
                site={selection.site}
                installed
                onOpen={() => setOpenPackage(selection)}
              />
            </div>
          );
        })}
        {installs.map((installation) => (
          <InstalledRow
            key={installation.id}
            installation={installation}
            bots={botList}
            onOpen={() => setOpenPlugin({ slug: installation.plugin.slug })}
            onOpenApp={(partId) => setOpenApp({ slug: installation.plugin.slug, partId })}
          />
        ))}
      </div>
    );
  }

  return (
    <div data-testid="community-store" className="space-y-6">
      {onBack ? <ViewTitle title={<Trans>Community apps</Trans>} onBack={onBack} /> : null}
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList>
          <TabsTrigger value="discover" className="px-3">
            <Trans>Discover</Trans>
          </TabsTrigger>
          <TabsTrigger value="installed" className="px-3">
            <Trans>Installed</Trans>
            {installs.length + connections.pluginInstalls.length ? (
              <span className="text-muted-foreground">
                {installs.length + connections.pluginInstalls.length}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="create" className="px-3" data-testid="community-create-tab">
            <Plus />
            <Trans>Create app</Trans>
          </TabsTrigger>
          {me.data?.isAdmin ? (
            <TabsTrigger value="review" className="px-3">
              <Trans>Review</Trans>
            </TabsTrigger>
          ) : null}
        </TabsList>
      </Tabs>
      {tab === "discover" ? discoverTab() : null}
      {tab === "installed" ? installedTab() : null}
      {tab === "create" ? (
        <CreatePlugin key={template?.key ?? 0} template={template?.version} />
      ) : null}
      {tab === "review" && me.data?.isAdmin ? <ReviewQueue /> : null}
    </div>
  );
}

/** Every community app this member installed in the Space. */
export function useRegistryInstallations() {
  const registry = useSpaceQueries().pluginRegistry;
  return useQuery({
    queryKey: registry.installations.queryKey({ input: { limit: REGISTRY_PAGE_SIZE } }),
    queryFn: ({ signal }) =>
      readAllPages((after) =>
        registry.installations.call({ limit: REGISTRY_PAGE_SIZE, after }, { signal }),
      ),
  });
}

function InstalledRow({
  installation,
  bots,
  onOpen,
  onOpenApp,
}: {
  installation: RegistryInstallation;
  bots: readonly Bot[];
  onOpen: () => void;
  onOpenApp: (partId: string) => void;
}) {
  const { plugin } = installation;
  const apps = appParts(plugin.manifest);
  const { t } = useLingui();
  const names = grantedBots(installation).flatMap((id) => {
    const bot = bots.find((row) => row.id === id);
    return bot ? [bot.name] : [];
  });
  return (
    <div data-testid="community-installed-row" className={`${ROW_SHELL} ${ROW_HOVER}`}>
      <button type="button" className={ROW_BUTTON} onClick={onOpen}>
        <PluginLogo name={plugin.manifest.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-lg font-medium text-foreground">
            {plugin.manifest.name}
          </span>
          <span className="flex min-w-0 gap-3 text-body-sm text-muted-foreground">
            <span className="shrink-0">
              <Trans>Version {plugin.version}</Trans>
            </span>
            <span className="truncate">
              {names.length ? (
                <Trans>Allowed for {names.join(", ")}</Trans>
              ) : (
                <Trans>No bot can use it yet</Trans>
              )}
            </span>
          </span>
        </span>
      </button>
      {apps.length === 1 ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-label={t`Open ${plugin.manifest.name}`}
          onClick={() => onOpenApp(apps[0]!.id)}
        >
          <NotebookPen />
          <Trans>Open</Trans>
        </Button>
      ) : null}
      <Button
        type="button"
        variant={apps.length === 1 ? "ghost" : "secondary"}
        size="sm"
        onClick={onOpen}
      >
        <Trans>Manage</Trans>
      </Button>
    </div>
  );
}

function Loading() {
  const { t } = useLingui();
  return (
    <div className="grid place-items-center py-10">
      <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
    </div>
  );
}

function LoadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 text-body text-destructive">
      {text}
      <Button variant="outline" size="sm" onClick={onRetry}>
        <Trans>Retry</Trans>
      </Button>
    </div>
  );
}
