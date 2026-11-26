import { Trans, useLingui } from "@lingui/react/macro";
import type { CommunityTemplateSubmission } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SectionHeading,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { useBotTemplateCategoryLabel } from "../../components/bot-templates/bot-template-copy";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { cronLabels } from "../../lib/routines/cron";

type Decision =
  | { id: string; decision: "approve" }
  | { id: string; decision: "reject"; reason: string }
  | { id: string; decision: "unlist"; reason: string };

/**
 * Templates people shared from their bots. Every field that would be listed or installed is
 * shown as plain text, so the review sees exactly what a bot would get.
 */
export function CommunityTemplatesReviewPanel() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [status, setStatus] = useState<"pending" | "approved">("pending");
  const [refusing, setRefusing] = useState<{
    item: CommunityTemplateSubmission;
    kind: "reject" | "unlist";
  } | null>(null);
  const [reason, setReason] = useState("");
  const queue = useQuery(queries.communityTemplates.queue.queryOptions({ input: { status } }));
  const review = useSave({
    save: (input: Decision, rpc) =>
      input.decision === "unlist"
        ? rpc.communityTemplates.unlist({ id: input.id, reason: input.reason })
        : rpc.communityTemplates.review(input),
    stale: [queries.communityTemplates.queue.key(), queries.communityTemplates.list.key()],
    onSaved: (_saved, input) => {
      if (input.decision !== "approve") setRefusing(null);
    },
    onFailed: (error, input) =>
      toast.error(
        errorText(
          error,
          input.decision === "approve"
            ? t`Could not approve`
            : input.decision === "reject"
              ? t`Could not reject`
              : t`Could not unlist`,
        ),
      ),
  });

  function refuse(event: FormEvent) {
    event.preventDefault();
    if (!refusing || !reason.trim()) return;
    review.run({ id: refusing.item.id, decision: refusing.kind, reason: reason.trim() });
  }

  const list = queue.data ?? [];
  return (
    <section data-testid="community-template-review" className="space-y-4">
      <SectionHeading as="h2" className="px-1">
        <Trans>Shared agents</Trans>
      </SectionHeading>
      <Tabs value={status} onValueChange={(value) => setStatus(value as "pending" | "approved")}>
        <TabsList>
          <TabsTrigger value="pending" className="px-3">
            <Trans>Pending</Trans>
          </TabsTrigger>
          <TabsTrigger value="approved" className="px-3">
            <Trans>Listed</Trans>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {queue.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : queue.isError ? (
        <div role="alert" className="flex items-center gap-3 text-body text-destructive">
          {errorText(queue.error, t`Couldn't load shared agents`)}
          <Button variant="outline" size="sm" onClick={() => void queue.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="text-body text-muted-foreground">
          <Trans>No shared agents</Trans>
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {list.map((item) => (
            <li
              key={item.id}
              data-testid="community-template-submission"
              aria-label={item.recipe.name}
              className="space-y-3 px-4 py-4"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-body-lg font-medium" dir="auto">
                    {item.recipe.name}
                  </h3>
                  <p className="truncate text-body-sm text-muted-foreground" dir="auto">
                    {item.author ?? t`No public name`}
                  </p>
                  <p className="text-body-sm text-muted-foreground">
                    <Trans>Version {item.version}</Trans>
                  </p>
                </div>
                {item.status === "pending" ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={review.pending}
                      onClick={() => {
                        setReason("");
                        setRefusing({ item, kind: "reject" });
                      }}
                    >
                      <Trans>Reject</Trans>
                    </Button>
                    <Button
                      size="sm"
                      disabled={review.pending}
                      onClick={() => review.run({ id: item.id, decision: "approve" })}
                    >
                      {review.pending && review.input?.id === item.id ? (
                        <Trans>Approving…</Trans>
                      ) : (
                        <Trans>Approve</Trans>
                      )}
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={review.pending}
                    onClick={() => {
                      setReason("");
                      setRefusing({ item, kind: "unlist" });
                    }}
                  >
                    <Trans>Unlist</Trans>
                  </Button>
                )}
              </div>
              <Recipe item={item} />
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={refusing !== null}
        onOpenChange={(open) => {
          if (!open && !review.pending) setRefusing(null);
        }}
      >
        <DialogContent>
          <form onSubmit={refuse} className="space-y-4">
            <DialogHeader>
              <DialogTitle>
                {refusing?.kind === "unlist" ? (
                  <Trans>Unlist {refusing.item.recipe.name}</Trans>
                ) : (
                  <Trans>Reject {refusing?.item.recipe.name}</Trans>
                )}
              </DialogTitle>
            </DialogHeader>
            <Textarea
              aria-label={t`Reason`}
              placeholder={t`Reason`}
              value={reason}
              maxLength={1000}
              required
              autoFocus
              onChange={(event) => setReason(event.target.value)}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={review.pending}
                onClick={() => setRefusing(null)}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={review.pending || !reason.trim()}
              >
                {refusing?.kind === "unlist" ? <Trans>Unlist</Trans> : <Trans>Reject</Trans>}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Every field of the recipe, as plain text: nothing is rendered or run while reviewing. */
function Recipe({ item }: { item: CommunityTemplateSubmission }) {
  const { t, i18n } = useLingui();
  const categoryLabel = useBotTemplateCategoryLabel();
  const { recipe } = item;
  return (
    <dl className="space-y-3 text-body-sm">
      <Entry label={t`Category`}>{categoryLabel(recipe.category)}</Entry>
      <Entry label={t`Summary`}>{recipe.summary}</Entry>
      {recipe.description ? <Entry label={t`Description`}>{recipe.description}</Entry> : null}
      <Entry label={t`Example message`}>{recipe.sample}</Entry>
      <Entry label={t`Instructions`}>{recipe.instructions}</Entry>
      {recipe.skills.map((skill) => (
        <Entry key={skill.name} label={t`Skill: ${skill.name}`}>
          {`${skill.description}\n\n${skill.body}`}
        </Entry>
      ))}
      {recipe.routines.map((routine, index) => (
        <Entry
          key={index}
          label={t`Routine: ${routine.name}, ${routine.crons
            .map((cron) => formatCron(cron, cronLabels(i18n.locale)))
            .join(", ")}`}
        >
          {routine.prompt}
        </Entry>
      ))}
      {recipe.apps.length ? <Entry label={t`Works with`}>{recipe.apps.join(", ")}</Entry> : null}
    </dl>
  );
}

function Entry({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground" dir="auto">
        {label}
      </dt>
      <dd className="mt-0.5 max-h-80 overflow-y-auto whitespace-pre-wrap break-words" dir="auto">
        {children}
      </dd>
    </div>
  );
}
