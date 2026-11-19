import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { Bot } from "@rakazo/contracts";
import { MAX_REGISTRY_SEARCH_LENGTH } from "@rakazo/contracts";
import { Button, Input, Spinner, Tabs, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
  PluginLogo,
  PluginRow,
  ROW_BUTTON,
  ROW_HOVER,
  ROW_SHELL,
} from "../../../components/integrations/plugin-marketplace";
import { useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { ViewTitle } from "../parts";
import { CommunityDetail } from "./community-detail";
import { CreatePlugin } from "./create-plugin";
import type { RegistryInstallation } from "./registry";
import { grantedBots, latestBySlug, REGISTRY_PAGE_SIZE, readAllPages } from "./registry";
import { ReviewQueue } from "./review-queue";

type Tab = "discover" | "installed" | "create" | "review";

/** Community plugins from the deployment's registry: approved ones to install, and authoring. */
export function CommunityStore({
  activeBotId,
  onBack,
}: {
  activeBotId?: string;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const registry = queries.pluginRegistry;
  const [tab, setTab] = useState<Tab>("discover");
  const [openPlugin, setOpenPlugin] = useState<{ slug: string; version?: number } | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const searchText = search.trim();
  const waitingForSearch = searchText !== query;
  useTimeout(() => setQuery(searchText), waitingForSearch ? 200 : null, searchText);
  const me = useQuery(queries.me.queryOptions());
  const bots = useQuery(queries.bots.list.queryOptions());
  const installations = useQuery({
    queryKey: registry.installations.queryKey({ input: { limit: REGISTRY_PAGE_SIZE } }),
    queryFn: ({ signal }) =>
      readAllPages((after) =>
        registry.installations.call({ limit: REGISTRY_PAGE_SIZE, after }, { signal }),
      ),
  });
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
      />
    );

  const latest = latestBySlug(discover.data?.pages.flatMap((page) => page.items) ?? []);
  const loadingResults = waitingForSearch || discover.isPending;
  const discoverError =
    discover.isError && !latest.length ? (
      <LoadError
        text={errorText(discover.error, t`Could not load community plugins`)}
        onRetry={() => void discover.refetch()}
      />
    ) : null;

  function discoverTab() {
    if (!search && !query) {
      if (loadingResults) return <Loading />;
      if (discoverError) return discoverError;
      if (!latest.length && !discover.hasNextPage)
        return (
          <div className="flex flex-col items-start gap-3 px-1">
            <p className="text-body text-muted-foreground">
              <Trans>No community plugins yet.</Trans>
            </p>
            <Button variant="secondary" size="sm" onClick={() => setTab("create")}>
              <Plus />
              <Trans>Create plugin</Trans>
            </Button>
          </div>
        );
    }
    return (
      <div className="space-y-4">
        <Input
          value={search}
          maxLength={MAX_REGISTRY_SEARCH_LENGTH}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t`Search community plugins`}
          placeholder={t`Search community plugins`}
        />
        {loadingResults ? (
          <Loading />
        ) : discoverError ? (
          discoverError
        ) : latest.length ? (
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
        ) : (
          <p className="px-1 text-body text-muted-foreground">
            <Trans>No community plugins match your search.</Trans>
          </p>
        )}
        {!loadingResults && discover.hasNextPage ? (
          <div className="flex justify-center">
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
      </div>
    );
  }

  function installedTab() {
    if (installations.isPending) return <Loading />;
    if (installations.isError)
      return (
        <LoadError
          text={errorText(installations.error, t`Could not load installed plugins`)}
          onRetry={() => void installations.refetch()}
        />
      );
    if (!installs.length)
      return (
        <p className="px-1 text-body text-muted-foreground">
          <Trans>No community plugins installed in this space.</Trans>
        </p>
      );
    return (
      <div data-testid="community-installed" className="space-y-1">
        {installs.map((installation) => (
          <InstalledRow
            key={installation.id}
            installation={installation}
            bots={botList}
            onOpen={() => setOpenPlugin({ slug: installation.plugin.slug })}
          />
        ))}
      </div>
    );
  }

  return (
    <div data-testid="community-store" className="space-y-6">
      <ViewTitle title={<Trans>Community plugins</Trans>} onBack={onBack} />
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList>
          <TabsTrigger value="discover" className="px-3">
            <Trans>Discover</Trans>
          </TabsTrigger>
          <TabsTrigger value="installed" className="px-3">
            <Trans>Installed</Trans>
            {installs.length ? (
              <span className="text-muted-foreground">{installs.length}</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="create" className="px-3" data-testid="community-create-tab">
            <Plus />
            <Trans>Create plugin</Trans>
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
      {tab === "create" ? <CreatePlugin /> : null}
      {tab === "review" && me.data?.isAdmin ? <ReviewQueue /> : null}
    </div>
  );
}

function InstalledRow({
  installation,
  bots,
  onOpen,
}: {
  installation: RegistryInstallation;
  bots: readonly Bot[];
  onOpen: () => void;
}) {
  const { plugin } = installation;
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
      <Button type="button" variant="secondary" size="sm" onClick={onOpen}>
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
