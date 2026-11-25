import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { CapabilityInstall, PluginMarketplaceEntry } from "@rakazo/contracts";
import { MAX_REGISTRY_SEARCH_LENGTH } from "@rakazo/contracts";
import { matchesPluginQuery } from "@rakazo/core";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { PluginSelection } from "../../components/integrations/plugin-marketplace";
import { PluginRow, pluginSelection } from "../../components/integrations/plugin-marketplace";
import { useSpaceQueries } from "../../lib/query/query";
import { useRegistryInstallations } from "./community/community-store";
import { latestBySlug } from "./community/registry";
import { usePluginCategoryLabel } from "./use-catalog-browse";

const SHOWN = 4;
const READ = 12;

/** What the Store's Apps opens: a community entry by its ID, or a marketplace package. */
export type PluginPick =
  | { kind: "community"; slug: string }
  | { kind: "package"; selection: PluginSelection };

/** Apps matching a Connections search, from the marketplace and the community, opened in Apps. */
export function PluginPicks({
  query,
  packages,
  installs,
  onOpen,
  onViewAll,
}: {
  query: string;
  /** Marketplace packages that connect a service the connection catalog does not offer itself. */
  packages: readonly PluginMarketplaceEntry[];
  installs: readonly CapabilityInstall[];
  onOpen: (pick: PluginPick) => void;
  onViewAll: () => void;
}) {
  const { t } = useLingui();
  const categoryLabel = usePluginCategoryLabel();
  const registry = useSpaceQueries().pluginRegistry;
  const text = query.trim().slice(0, MAX_REGISTRY_SEARCH_LENGTH);
  const [search, setSearch] = useState(text);
  useTimeout(() => setSearch(text), text === search ? null : 200, text);
  const discover = useQuery(
    registry.discover.queryOptions({
      input: { limit: READ, ...(search ? { query: search } : {}) },
    }),
  );
  const communityInstalled = new Set(
    useRegistryInstallations().data?.map((row) => row.plugin.slug),
  );
  const packageMatches = packages
    .filter((entry) =>
      matchesPluginQuery(entry, query, entry.category ? categoryLabel(entry.category) : ""),
    )
    .slice(0, SHOWN);
  const communityMatches = latestBySlug(discover.data?.items ?? []).slice(0, SHOWN);
  if (!packageMatches.length && !communityMatches.length) return null;
  return (
    <section data-testid="plugin-picks" className="mt-8 first:mt-0">
      <div className="mb-2 flex items-center justify-between px-2.5">
        <SectionHeading as="h2">
          <Trans>Apps</Trans>
        </SectionHeading>
        <Button variant="text" size="sm" aria-label={t`View all apps`} onClick={onViewAll}>
          <Trans>View all</Trans>
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {packageMatches.map((entry) => {
          const selection = pluginSelection(entry);
          return (
            <PluginRow
              key={entry.id}
              name={entry.displayName}
              description={entry.description}
              logo={entry.logo}
              site={selection.site}
              installed={installs.some((install) => install.source === entry.installedSource)}
              onOpen={() => onOpen({ kind: "package", selection })}
            />
          );
        })}
        {communityMatches.map((version) => (
          <PluginRow
            key={`community:${version.slug}`}
            name={version.manifest.name}
            description={version.manifest.description}
            installed={communityInstalled.has(version.slug)}
            onOpen={() => onOpen({ kind: "community", slug: version.slug })}
          />
        ))}
      </div>
    </section>
  );
}
