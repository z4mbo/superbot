import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../../../lib/query/query";
import { mediaIncludedWith } from "./media-choices";

/** Says what a model connection also makes, when a media provider borrows it. */
export function MediaIncluded({ provider }: { provider: string }) {
  const queries = useSpaceQueries();
  const catalog = useQuery(queries.media.catalog.queryOptions()).data;
  const included = mediaIncludedWith(catalog, provider);
  if (!included) return null;
  return (
    <span className="shrink-0 text-body-sm text-muted-foreground" data-testid="media-included">
      {included.image && included.video ? (
        <Trans>Includes images and video</Trans>
      ) : included.image ? (
        <Trans>Includes images</Trans>
      ) : (
        <Trans>Includes video</Trans>
      )}
    </span>
  );
}
