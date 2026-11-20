import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Field, FieldDescription, FieldLabel, Input, Spinner } from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useId, useRef, useState } from "react";
import { PluginLogo } from "../../../components/integrations/plugin-marketplace";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import type { AppValues, FieldProblem } from "./app-values";
import {
  dateField,
  isoDateAsLocal,
  localIsoDate,
  readAppForm,
  shiftIsoDate,
  summaryField,
} from "./app-values";
import { BackButton, Facts } from "./community-detail";
import type {
  RegistryAppField,
  RegistryAppPart,
  RegistryAppRecord,
  RegistryInstallation,
} from "./registry";
import { appParts } from "./registry";

const RECORDS_PAGE_SIZE = 20;

type AppForm = Readonly<Record<string, string>>;

function sameForm(a: AppForm, b: AppForm): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => (a[key] ?? "") === (b[key] ?? ""));
}

/** An installed app part: the member's own entries, a form to add one and the total it sums. */
export function AppRunner({
  installation,
  part,
  onBack,
}: {
  installation: RegistryInstallation;
  part: RegistryAppPart;
  onBack: () => void;
}) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const registry = queries.pluginRegistry;
  const formId = useId();
  const { plugin } = installation;
  const target = { installationId: installation.id, partId: part.id };
  const byDate = dateField(part);
  const summary = summaryField(part);
  const today = localIsoDate();
  const [day, setDay] = useState(byDate ? today : "");
  const blankForm = (date: string) => (byDate ? { [byDate.id]: date || today } : {});
  const [form, setForm] = useState<AppForm>(() => blankForm(day));
  const [problems, setProblems] = useState<Record<string, FieldProblem>>({});
  const addButton = useRef<HTMLButtonElement>(null);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  const records = useInfiniteQuery(
    registry.appRecords.infiniteOptions({
      input: (after: string | null) => ({
        ...target,
        limit: RECORDS_PAGE_SIZE,
        ...(day ? { date: day } : {}),
        ...(after ? { after } : {}),
      }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextAfter,
    }),
  );
  const stale = [registry.appRecords.key()];
  const add = useSave({
    save: (
      { operationId, values }: { operationId: string; values: AppValues; sent: AppForm },
      rpc,
    ) => rpc.pluginRegistry.addAppRecord({ ...target, operationId, values }),
    stale,
    onSaved: (_record, { values, sent }) => {
      const recordDay = byDate ? values[byDate.id] : undefined;
      const nextDay = typeof recordDay === "string" && day && recordDay !== day ? recordDay : day;
      setDay(nextDay);
      // What was typed while the entry was saving is the next entry, not something to clear.
      const blank = blankForm(typeof recordDay === "string" ? recordDay : nextDay);
      setForm((now) => (sameForm(now, sent) ? blank : now));
      setOperationId(crypto.randomUUID());
      // A disabled button drops focus to the page while it saves.
      const focused = document.activeElement;
      if (!focused || focused === document.body || focused === addButton.current)
        document.getElementById(fieldElementId(firstInputField(part).id))?.focus();
    },
  });
  const remove = useSave({
    save: (recordId: string, rpc) => rpc.pluginRegistry.removeAppRecord({ ...target, recordId }),
    stale,
    onSaved: () => setConfirmingRemove(null),
  });

  const numbers = new Intl.NumberFormat(i18n.locale || "en", { maximumFractionDigits: 2 });
  const longDay = (iso: string) =>
    isoDateAsLocal(iso).toLocaleDateString(i18n.locale || "en", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  const fieldElementId = (fieldId: string) => `${formId}-${fieldId}`;
  const problemText = useProblemText();

  function edit(fieldId: string, value: string) {
    setForm((now) => ({ ...now, [fieldId]: value }));
    setProblems(({ [fieldId]: _fixed, ...rest }) => rest);
    setOperationId(crypto.randomUUID());
    add.reset();
  }

  function chooseDay(next: string) {
    setDay(next);
    setConfirmingRemove(null);
    if (byDate && next) setForm((now) => ({ ...now, [byDate.id]: next }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = readAppForm(part, form);
    if (!result.ok) {
      setProblems(result.problems);
      const first = part.fields.find((field) => result.problems[field.id]);
      if (first) document.getElementById(fieldElementId(first.id))?.focus();
      return;
    }
    add.run({ operationId, values: result.values, sent: form });
  }

  const items = records.data?.pages.flatMap((page) => page.items) ?? [];
  const total = records.data?.pages[0]?.total ?? null;
  const severalApps = appParts(plugin.manifest).length > 1;

  return (
    <div data-testid="community-app" className="space-y-7">
      <div className="flex items-start gap-4">
        <BackButton onBack={onBack} className="mt-3.5" />
        <PluginLogo name={plugin.manifest.name} large />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-heading2 font-semibold text-foreground">
            {plugin.manifest.name}
          </h2>
          <Facts className="text-body">
            {severalApps ? <span className="truncate font-mono">{part.id}</span> : null}
            <span>
              <Trans>Version {plugin.version}</Trans>
            </span>
          </Facts>
        </div>
      </div>

      {byDate ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t`Previous day`}
            disabled={!day}
            onClick={() => chooseDay(shiftIsoDate(day, -1))}
          >
            <ChevronLeft />
          </Button>
          <Input
            type="date"
            className="w-auto"
            aria-label={t`Day`}
            data-testid="community-app-day"
            value={day}
            onChange={(event) => chooseDay(event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t`Next day`}
            disabled={!day}
            onClick={() => chooseDay(shiftIsoDate(day, 1))}
          >
            <ChevronRight />
          </Button>
          {day !== today ? (
            <Button type="button" variant="text" size="sm" onClick={() => chooseDay(today)}>
              <Trans>Today</Trans>
            </Button>
          ) : null}
          <Button
            type="button"
            variant={day ? "text" : "secondary"}
            size="sm"
            aria-pressed={!day}
            onClick={() => chooseDay("")}
          >
            <Trans>All dates</Trans>
          </Button>
        </div>
      ) : null}

      {summary ? (
        <div data-testid="community-app-total" aria-live="polite">
          <p className="text-body text-muted-foreground">
            {day ? (
              <Trans>
                {summary.label} on {longDay(day)}
              </Trans>
            ) : (
              <Trans>{summary.label}, all entries</Trans>
            )}
          </p>
          <p className="text-display font-semibold text-foreground tabular-nums">
            {total === null ? "–" : numbers.format(total)}
          </p>
        </div>
      ) : null}

      <form
        noValidate
        aria-label={t`New entry`}
        className="space-y-4 rounded-xl border border-border/70 px-4 py-4"
        onSubmit={submit}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {part.fields.map((field) => (
            <AppFieldInput
              key={field.id}
              id={fieldElementId(field.id)}
              field={field}
              value={form[field.id] ?? ""}
              problem={problems[field.id] ? problemText(field, problems[field.id]!) : null}
              onChange={(value) => edit(field.id, value)}
            />
          ))}
        </div>
        {add.error ? (
          <p role="alert" className="text-body text-destructive">
            {errorText(add.error, t`Could not add this entry`)}
          </p>
        ) : null}
        <Button ref={addButton} type="submit" disabled={add.pending}>
          {add.pending ? <Trans>Adding…</Trans> : <Trans>Add entry</Trans>}
        </Button>
      </form>

      <section aria-labelledby={`${formId}-entries`}>
        <h3
          id={`${formId}-entries`}
          className="mb-2 flex gap-2 px-1 text-body font-medium text-foreground"
        >
          <Trans>Entries</Trans>
          {records.data && !records.hasNextPage ? (
            <span className="text-muted-foreground">{items.length}</span>
          ) : null}
        </h3>
        {remove.error ? (
          <p role="alert" className="mb-2 px-1 text-body text-destructive">
            {errorText(remove.error, t`Could not remove this entry`)}
          </p>
        ) : null}
        {records.isPending ? (
          <div className="grid place-items-center py-6">
            <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
          </div>
        ) : records.isError && !items.length ? (
          <div role="alert" className="flex items-center gap-3 text-body text-destructive">
            {errorText(records.error, t`Could not load entries`)}
            <Button variant="outline" size="sm" onClick={() => void records.refetch()}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : !items.length ? (
          <p className="px-1 text-body text-muted-foreground">
            {day ? <Trans>No entries on this day.</Trans> : <Trans>No entries yet.</Trans>}
          </p>
        ) : (
          <ul
            data-testid="community-app-records"
            className="divide-y divide-border/60 rounded-xl border border-border/70"
          >
            {items.map((record) => (
              <RecordRow
                key={record.id}
                record={record}
                part={part}
                hideDate={Boolean(day)}
                formatNumber={(value) => numbers.format(value)}
                formatDay={longDay}
                confirming={confirmingRemove === record.id}
                busy={remove.pending}
                onRemove={() => {
                  remove.reset();
                  setConfirmingRemove(record.id);
                }}
                onCancel={() => setConfirmingRemove(null)}
                onConfirm={() => remove.run(record.id)}
              />
            ))}
          </ul>
        )}
        {records.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              disabled={records.isFetchingNextPage}
              onClick={() => void records.fetchNextPage()}
            >
              <Trans>Show more</Trans>
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function firstInputField(part: RegistryAppPart): RegistryAppField {
  return part.fields.find((field) => field.type !== "date") ?? part.fields[0]!;
}

function AppFieldInput({
  id,
  field,
  value,
  problem,
  onChange,
}: {
  id: string;
  field: RegistryAppField;
  value: string;
  problem: string | null;
  onChange: (value: string) => void;
}) {
  const problemId = `${id}-problem`;
  return (
    <Field data-invalid={Boolean(problem)}>
      <FieldLabel htmlFor={id}>
        {field.label}
        {field.required ? null : (
          <span className="font-normal text-muted-foreground">
            <Trans>(optional)</Trans>
          </span>
        )}
      </FieldLabel>
      <Input
        id={id}
        type={field.type === "text" ? "text" : field.type}
        inputMode={field.type === "number" ? "decimal" : undefined}
        step={field.type === "number" ? "any" : undefined}
        maxLength={field.type === "text" ? 2000 : undefined}
        required={field.required}
        aria-required={field.required}
        aria-invalid={Boolean(problem)}
        aria-describedby={problem ? problemId : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem ? (
        <FieldDescription id={problemId} className="text-destructive">
          {problem}
        </FieldDescription>
      ) : null}
    </Field>
  );
}

function RecordRow({
  record,
  part,
  hideDate,
  formatNumber,
  formatDay,
  confirming,
  busy,
  onRemove,
  onCancel,
  onConfirm,
}: {
  record: RegistryAppRecord;
  part: RegistryAppPart;
  hideDate: boolean;
  formatNumber: (value: number) => string;
  formatDay: (iso: string) => string;
  confirming: boolean;
  busy: boolean;
  onRemove: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLingui();
  const shown = (field: RegistryAppField) => {
    const value = record.values[field.id];
    if (value === undefined) return null;
    if (typeof value === "number") return formatNumber(value);
    return field.type === "date" ? formatDay(value) : value;
  };
  const byDate = dateField(part);
  const lead = firstInputField(part);
  const summary = summaryField(part);
  const facts = part.fields.filter(
    (field) =>
      field.id !== lead.id &&
      field.id !== summary?.id &&
      !(hideDate && field.id === byDate?.id) &&
      record.values[field.id] !== undefined,
  );
  const name = shown(lead) ?? t`Entry`;
  return (
    <li
      data-testid="community-app-record"
      aria-label={name}
      className="flex items-center gap-3 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <span className="block truncate text-body-lg font-medium text-foreground" dir="auto">
          {name}
        </span>
        {facts.length ? (
          <Facts>
            {facts.map((field) => (
              <span key={field.id} className="truncate" dir="auto">
                {field.label}: {shown(field)}
              </span>
            ))}
          </Facts>
        ) : null}
      </div>
      {summary && record.values[summary.id] !== undefined ? (
        <span className="shrink-0 text-body-lg text-foreground tabular-nums">{shown(summary)}</span>
      ) : null}
      {confirming ? (
        <span className="flex shrink-0 gap-1">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>
            {busy ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
          </Button>
        </span>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          aria-label={t`Remove ${name}`}
          disabled={busy}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      )}
    </li>
  );
}

function useProblemText() {
  const { t } = useLingui();
  return (field: RegistryAppField, problem: FieldProblem): string => {
    switch (problem) {
      case "required":
        return t`Enter ${field.label}.`;
      case "number":
        return t`Enter a number.`;
      case "range":
        return t`Enter a number between minus and plus one trillion.`;
      case "date":
        return t`Enter a date.`;
      case "length":
        return t`Use up to 2,000 characters.`;
    }
  };
}
