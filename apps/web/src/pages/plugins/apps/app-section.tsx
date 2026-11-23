import { Trans } from "@lingui/react/macro";
import type { AppListing } from "@rakazo/contracts";
import { SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { PluginRow } from "../../../components/integrations/plugin-marketplace";
import { useSpaceQueries } from "../../../lib/query/query";

/**
 * Reviewed apps in the Integrations browse, above the plugins: searched with the same box and
 * hidden while a plugin category is picked. Nothing shows until there is an app to list.
 */
export function AppSection({
  query,
  onOpen,
}: {
  query: string;
  onOpen: (listing: AppListing) => void;
}) {
  const queries = useSpaceQueries();
  const catalog = useQuery(queries.apps.catalog.queryOptions({ input: { query: query.trim() } }));
  const installed = useQuery(queries.apps.installed.queryOptions());
  const listings = catalog.data ?? [];
  if (!listings.length) return null;
  const installedIds = new Set((installed.data ?? []).map((install) => install.appId));
  return (
    <section data-testid="app-section" className="mt-8">
      <SectionHeading as="h2" className="mb-2 px-2.5">
        <Trans>Apps</Trans>
      </SectionHeading>
      <div className="grid grid-cols-2 gap-2">
        {listings.map((listing) => (
          <PluginRow
            key={listing.releaseId}
            name={listing.name}
            description={listing.description}
            logo={listing.icon}
            installed={installedIds.has(listing.appId)}
            onOpen={() => onOpen(listing)}
          />
        ))}
      </div>
    </section>
  );
}
