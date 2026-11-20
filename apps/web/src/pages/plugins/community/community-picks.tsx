import { Trans } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import { MAX_REGISTRY_SEARCH_LENGTH } from "@rakazo/contracts";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PluginRow } from "../../../components/integrations/plugin-marketplace";
import { useSpaceQueries } from "../../../lib/query/query";
import { useRegistryInstallations } from "./community-store";
import { latestBySlug } from "./registry";

const SHOWN = 4;
const READ = 12;

/** A few community plugins beside the catalog, or those matching the search. */
export function CommunityPicks({
  query,
  onOpen,
  onViewAll,
}: {
  query: string;
  onOpen: (slug: string) => void;
  onViewAll: () => void;
}) {
  const registry = useSpaceQueries().pluginRegistry;
  const text = query.trim().slice(0, MAX_REGISTRY_SEARCH_LENGTH);
  const [search, setSearch] = useState(text);
  useTimeout(() => setSearch(text), text === search ? null : 200, text);
  const discover = useQuery(
    registry.discover.queryOptions({
      input: { limit: READ, ...(search ? { query: search } : {}) },
    }),
  );
  const installed = new Set(useRegistryInstallations().data?.map((row) => row.plugin.slug));
  const picks = latestBySlug(discover.data?.items ?? []).slice(0, SHOWN);
  if (!picks.length) return null;
  return (
    <section data-testid="community-picks" className="mt-8 first:mt-0">
      <div className="mb-2 flex items-center justify-between px-2.5">
        <SectionHeading as="h2">
          <Trans>Community</Trans>
        </SectionHeading>
        <Button variant="text" size="sm" onClick={onViewAll}>
          <Trans>View all</Trans>
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {picks.map((version) => (
          <PluginRow
            key={version.slug}
            name={version.manifest.name}
            description={version.manifest.description}
            installed={installed.has(version.slug)}
            onOpen={() => onOpen(version.slug)}
          />
        ))}
      </div>
    </section>
  );
}
