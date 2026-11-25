import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { Facts, PartRow } from "./community-detail";
import { StatusBadge } from "./create-plugin";
import type { RegistryVersion } from "./registry";
import { REGISTRY_PAGE_SIZE } from "./registry";

type Status = RegistryVersion["status"];
type Review =
  | { versionId: string; decision: "approved" }
  | { versionId: string; decision: "rejected"; reason: string };

/** The deployment admin's queue of submitted versions, read in full before a decision. */
export function ReviewQueue() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const registry = queries.pluginRegistry;
  const [status, setStatus] = useState<Status>("pending");
  const [rejecting, setRejecting] = useState<RegistryVersion | null>(null);
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const submissions = useInfiniteQuery(
    registry.submissions.infiniteOptions({
      input: (after: string | null) => ({
        status,
        limit: REGISTRY_PAGE_SIZE,
        ...(after ? { after } : {}),
      }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextAfter,
    }),
  );
  const review = useSave({
    save: (input: Review, rpc) => rpc.pluginRegistry.review(input),
    stale: [registry.submissions.key(), registry.discover.key()],
    onSaved: (_saved, input) => {
      if (input.decision === "rejected") setRejecting(null);
    },
    onFailed: (error, input) =>
      toast.error(
        errorText(
          error,
          input.decision === "rejected" ? t`Could not reject app` : t`Could not approve app`,
        ),
      ),
  });
  const list = submissions.data?.pages.flatMap((page) => page.items) ?? [];

  function reject(event: FormEvent) {
    event.preventDefault();
    if (!rejecting || !reason.trim()) return;
    review.run({ versionId: rejecting.id, decision: "rejected", reason: reason.trim() });
  }

  return (
    <div data-testid="community-review" className="space-y-6">
      <Tabs value={status} onValueChange={(value) => setStatus(value as Status)}>
        <TabsList>
          <TabsTrigger value="pending" className="px-3">
            <Trans>Pending</Trans>
          </TabsTrigger>
          <TabsTrigger value="approved" className="px-3">
            <Trans>Approved</Trans>
          </TabsTrigger>
          <TabsTrigger value="rejected" className="px-3">
            <Trans>Rejected</Trans>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {submissions.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : submissions.isError && !list.length ? (
        <div role="alert" className="flex items-center gap-3 text-body text-destructive">
          {errorText(submissions.error, t`Couldn't load submissions`)}
          <Button variant="outline" size="sm" onClick={() => void submissions.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="text-body text-muted-foreground">
          <Trans>No submissions</Trans>
        </p>
      ) : (
        <ul className="space-y-4">
          {list.map((version) => (
            <li
              key={version.id}
              data-testid="community-review-item"
              aria-label={`${version.manifest.name} ${version.version}`}
              className="space-y-3 rounded-xl border border-border/70 px-4 py-4"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <h3 className="truncate text-body-lg font-medium text-foreground">
                      {version.manifest.name}
                    </h3>
                    <StatusBadge status={version.status} />
                  </div>
                  <Facts>
                    <span className="truncate font-mono">{version.slug}</span>
                    <span>
                      <Trans>Version {version.version}</Trans>
                    </span>
                  </Facts>
                </div>
                {version.status === "pending" ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={review.pending}
                      onClick={() => {
                        setReason("");
                        setRejecting(version);
                      }}
                    >
                      <Trans>Reject</Trans>
                    </Button>
                    <Button
                      size="sm"
                      disabled={review.pending}
                      onClick={() => review.run({ versionId: version.id, decision: "approved" })}
                    >
                      {review.pending &&
                      review.input?.versionId === version.id &&
                      review.input.decision === "approved" ? (
                        <Trans>Approving…</Trans>
                      ) : (
                        <Trans>Approve</Trans>
                      )}
                    </Button>
                  </div>
                ) : null}
              </div>
              <p className="text-body leading-6 whitespace-pre-wrap text-foreground" dir="auto">
                {version.manifest.description}
              </p>
              <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
                {version.manifest.parts.map((part) => {
                  const key = `${version.id}:${part.id}`;
                  return (
                    <PartRow
                      key={part.id}
                      part={part}
                      expanded={expanded === key}
                      onExpand={() => setExpanded((open) => (open === key ? null : key))}
                    />
                  );
                })}
              </ul>
              {version.reason ? (
                <p className="text-body-sm text-destructive" dir="auto">
                  {version.reason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {submissions.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            disabled={submissions.isFetchingNextPage}
            onClick={() => void submissions.fetchNextPage()}
          >
            <Trans>Show more</Trans>
          </Button>
        </div>
      ) : null}

      <Dialog
        open={rejecting !== null}
        onOpenChange={(open) => {
          if (!open && !review.pending) setRejecting(null);
        }}
      >
        <DialogContent>
          <form onSubmit={reject} className="space-y-4">
            <DialogHeader>
              <DialogTitle>
                <Trans>
                  Reject {rejecting?.manifest.name} version {rejecting?.version}
                </Trans>
              </DialogTitle>
            </DialogHeader>
            <Textarea
              aria-label={t`Reason`}
              placeholder={t`What the author should change`}
              value={reason}
              maxLength={2000}
              required
              autoFocus
              onChange={(event) => setReason(event.target.value)}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={review.pending}
                onClick={() => setRejecting(null)}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={review.pending || !reason.trim()}
              >
                {review.pending ? <Trans>Rejecting…</Trans> : <Trans>Reject</Trans>}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
