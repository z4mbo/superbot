import { Trans, useLingui } from "@lingui/react/macro";
import type {
  BotTemplateCategory,
  CommunityTemplateDraft,
  CommunityTemplateRecipe,
} from "@rakazo/contracts";
import { BOT_TEMPLATE_CATEGORIES, CommunityTemplateRecipeSchema } from "@rakazo/contracts";
import { botTemplateApps, formatCron } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  OptionSelect,
  SectionHeading,
  Spinner,
  Textarea,
  toast,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useId, useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorDetails } from "../../lib/query/user-error";
import { cronLabels } from "../../lib/routines/cron";
import { ErrorNotice } from "../ErrorNotice";
import { useBotTemplateCategoryLabel } from "./bot-template-copy";

/**
 * Shares a bot as a template: the server reads a recipe from the bot, the owner sees and edits
 * all of it here, and only what is shown is submitted for review.
 */
export function ShareTemplateDialog({ botId, onClose }: { botId: string; onClose: () => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const draft = useQuery({
    ...queries.communityTemplates.draft.queryOptions({ input: { botId } }),
    staleTime: 0,
    gcTime: 0,
  });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent size="lg" data-testid="share-template-dialog">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>
            <Trans>Share as template</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Listed after review. Keys, memory, chats and settings aren't included.</Trans>
          </DialogDescription>
        </DialogHeader>
        {draft.data ? (
          <ShareForm botId={botId} draft={draft.data} onClose={onClose} />
        ) : draft.error ? (
          <div className="p-6">
            <ErrorNotice error={errorDetails(draft.error, t`Could not read this bot`)} />
          </div>
        ) : (
          <div className="grid flex-1 place-items-center">
            <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShareForm({
  botId,
  draft,
  onClose,
}: {
  botId: string;
  draft: CommunityTemplateDraft;
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const id = useId();
  const categoryLabel = useBotTemplateCategoryLabel();
  const [recipe, setRecipe] = useState(draft);
  const catalog = useQuery({
    ...queries.connections.catalog.queryOptions({ input: {} }),
    enabled: draft.apps.length > 0,
  });
  const submit = useSave({
    save: (shared: CommunityTemplateRecipe, rpc) =>
      rpc.communityTemplates.submit({ botId, recipe: shared }),
    stale: [queries.communityTemplates.mine.key()],
    closesScreen: true,
    onSaved: () => {
      toast.success(t`Sent for review`);
      onClose();
    },
  });
  const set = (change: Partial<CommunityTemplateDraft>) =>
    setRecipe((current) => ({ ...current, ...change }));
  // Only what passes the same checks as the server's is offered for submitting.
  const parsed = CommunityTemplateRecipeSchema.safeParse(recipe);
  const apps = botTemplateApps(recipe, catalog.data ?? []);
  const appName = (slug: string) => apps.find((app) => app.slug === slug)?.name ?? slug;

  function send(event: FormEvent) {
    event.preventDefault();
    if (parsed.success) submit.run(parsed.data);
  }

  return (
    <form onSubmit={send} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-5">
        {submit.error ? (
          <ErrorNotice error={errorDetails(submit.error, t`Could not submit`)} />
        ) : null}
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              id={`${id}-name`}
              value={recipe.name}
              maxLength={80}
              required
              onChange={(event) => set({ name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-category`}>
              <Trans>Category</Trans>
            </FieldLabel>
            <OptionSelect<BotTemplateCategory>
              id={`${id}-category`}
              value={recipe.category}
              required
              options={BOT_TEMPLATE_CATEGORIES.map((value) => ({
                value,
                label: categoryLabel(value),
              }))}
              onValueChange={(category) => set({ category })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-summary`}>
              <Trans>Summary</Trans>
            </FieldLabel>
            <Input
              id={`${id}-summary`}
              value={recipe.summary}
              maxLength={120}
              required
              placeholder={t`One line on what it does`}
              onChange={(event) => set({ summary: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-sample`}>
              <Trans>Example message</Trans>
            </FieldLabel>
            <Textarea
              id={`${id}-sample`}
              value={recipe.sample}
              maxLength={2000}
              required
              placeholder={t`What a message from it looks like`}
              onChange={(event) => set({ sample: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-description`}>
              <Trans>Description</Trans>
            </FieldLabel>
            <Input
              id={`${id}-description`}
              value={recipe.description}
              maxLength={4000}
              onChange={(event) => set({ description: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-instructions`}>
              <Trans>Instructions</Trans>
            </FieldLabel>
            <Textarea
              id={`${id}-instructions`}
              value={recipe.instructions}
              maxLength={20_000}
              required
              className="min-h-40"
              onChange={(event) => set({ instructions: event.target.value })}
            />
          </Field>
        </FieldGroup>

        {recipe.skills.length ? (
          <Part title={t`Skills`}>
            {recipe.skills.map((skill, index) => {
              const edit = (change: Partial<typeof skill>) =>
                set({
                  skills: recipe.skills.map((item, at) =>
                    at === index ? { ...item, ...change } : item,
                  ),
                });
              return (
                <Item
                  key={index}
                  removeLabel={t`Remove ${skill.name}`}
                  onRemove={() => set({ skills: recipe.skills.filter((_, at) => at !== index) })}
                >
                  <Field>
                    <FieldLabel htmlFor={`${id}-skill-${index}-name`}>
                      <Trans>Name</Trans>
                    </FieldLabel>
                    <Input
                      id={`${id}-skill-${index}-name`}
                      value={skill.name}
                      maxLength={64}
                      onChange={(event) => edit({ name: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-skill-${index}-description`}>
                      <Trans>When to use it</Trans>
                    </FieldLabel>
                    <Input
                      id={`${id}-skill-${index}-description`}
                      value={skill.description}
                      maxLength={2000}
                      onChange={(event) => edit({ description: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-skill-${index}-body`}>
                      <Trans>Steps</Trans>
                    </FieldLabel>
                    <Textarea
                      id={`${id}-skill-${index}-body`}
                      value={skill.body}
                      maxLength={20_000}
                      onChange={(event) => edit({ body: event.target.value })}
                    />
                  </Field>
                </Item>
              );
            })}
          </Part>
        ) : null}

        {recipe.routines.length ? (
          <Part title={t`Routines`}>
            {recipe.routines.map((routine, index) => {
              const edit = (change: Partial<typeof routine>) =>
                set({
                  routines: recipe.routines.map((item, at) =>
                    at === index ? { ...item, ...change } : item,
                  ),
                });
              return (
                <Item
                  key={index}
                  removeLabel={t`Remove ${routine.name}`}
                  onRemove={() =>
                    set({ routines: recipe.routines.filter((_, at) => at !== index) })
                  }
                >
                  <Field>
                    <FieldLabel htmlFor={`${id}-routine-${index}-name`}>
                      {routine.crons
                        .map((cron) => formatCron(cron, cronLabels(i18n.locale)))
                        .join(", ")}
                    </FieldLabel>
                    <Input
                      id={`${id}-routine-${index}-name`}
                      aria-label={t`Routine name`}
                      value={routine.name}
                      maxLength={80}
                      onChange={(event) => edit({ name: event.target.value })}
                    />
                  </Field>
                  <Textarea
                    aria-label={t`Prompt`}
                    value={routine.prompt}
                    maxLength={4000}
                    onChange={(event) => edit({ prompt: event.target.value })}
                  />
                </Item>
              );
            })}
          </Part>
        ) : null}

        {recipe.apps.length ? (
          <Part title={t`Works with`}>
            <ul className="flex flex-wrap gap-2">
              {recipe.apps.map((slug) => (
                <li
                  key={slug}
                  className="flex items-center gap-1 rounded-full border border-border/70 ps-3 text-body-sm"
                >
                  {appName(slug)}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="rounded-full"
                    aria-label={t`Remove ${appName(slug)}`}
                    onClick={() => set({ apps: recipe.apps.filter((app) => app !== slug) })}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          </Part>
        ) : null}
      </div>
      <DialogFooter className="border-t px-6 py-4">
        <Button type="button" variant="ghost" disabled={submit.pending} onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={submit.pending || !parsed.success}>
          {submit.pending ? <Trans>Submitting…</Trans> : <Trans>Submit for review</Trans>}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <SectionHeading as="h3" className="px-1">
        {title}
      </SectionHeading>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Item({
  removeLabel,
  onRemove,
  children,
}: {
  removeLabel: string;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <div className="relative rounded-xl border border-border/70 p-4">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute end-2 top-2 text-muted-foreground"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <X />
      </Button>
      <FieldGroup className="gap-3 pe-6">{children}</FieldGroup>
    </div>
  );
}
