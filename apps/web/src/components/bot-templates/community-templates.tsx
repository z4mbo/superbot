import { Trans, useLingui } from "@lingui/react/macro";
import type { CommunityTemplateStatus, CommunityTemplateSubmission } from "@rakazo/contracts";
import { Button, SectionHeading, toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

/** Who shared a community template, in few words; the author may have no public name. */
export function useCommunityByline(): (author: string | null) => string {
  const { t } = useLingui();
  return (author) => (author ? t`Shared by ${author}` : t`Shared by a community member`);
}

/** Statuses the author still has something to see or do about. */
const SHOWN: ReadonlySet<CommunityTemplateStatus> = new Set([
  "pending",
  "approved",
  "rejected",
  "unlisted",
]);

/** The templates the user shared, with where each stands; hidden until they share one. */
export function MySharedTemplates() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const mine = useQuery({ ...queries.communityTemplates.mine.queryOptions(), staleTime: 0 });
  const change = useSave({
    save: (input: { id: string; action: "withdraw" | "unlist" }, rpc) =>
      input.action === "withdraw"
        ? rpc.communityTemplates.withdraw({ id: input.id })
        : rpc.communityTemplates.unlist({ id: input.id }),
    stale: [queries.communityTemplates.mine.key(), queries.communityTemplates.list.key()],
    onFailed: (error, input) =>
      toast.error(
        errorText(error, input.action === "withdraw" ? t`Could not withdraw` : t`Could not unlist`),
      ),
  });
  const shown = (mine.data ?? []).filter((item) => SHOWN.has(item.status));
  if (!shown.length) return null;
  const statusLabel: Record<CommunityTemplateStatus, string> = {
    pending: t`Waiting for review`,
    approved: t`Listed`,
    rejected: t`Not approved`,
    unlisted: t`Unlisted`,
    withdrawn: t`Withdrawn`,
    replaced: t`Replaced by a newer version`,
  };
  return (
    <section data-testid="my-shared-templates" className="space-y-2">
      <SectionHeading as="h2" className="px-1">
        <Trans>Shared by you</Trans>
      </SectionHeading>
      <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
        {shown.map((item: CommunityTemplateSubmission) => (
          <li
            key={item.id}
            aria-label={item.recipe.name}
            className="flex items-start gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-body-lg font-medium" dir="auto">
                {item.recipe.name}
              </p>
              <p className="text-body-sm text-muted-foreground">{statusLabel[item.status]}</p>
              {item.reason ? (
                <p className="mt-1 whitespace-pre-wrap text-body-sm text-destructive" dir="auto">
                  {item.reason}
                </p>
              ) : null}
            </div>
            {item.status === "pending" || item.status === "approved" ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={change.pending}
                onClick={() =>
                  change.run({
                    id: item.id,
                    action: item.status === "pending" ? "withdraw" : "unlist",
                  })
                }
              >
                {item.status === "pending" ? <Trans>Withdraw</Trans> : <Trans>Unlist</Trans>}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
