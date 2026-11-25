import { Trans, useLingui } from "@lingui/react/macro";
import {
  Badge,
  Button,
  Checkbox,
  Disclosure,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  OptionSelect,
  SectionHeading,
  Spinner,
  Textarea,
  toast,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, FileText, NotebookPen, Plug, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { Facts } from "./community-detail";
import type {
  DraftIssue,
  FieldDraft,
  PartDraft,
  PluginDraft,
  RegistryVersion,
  SubmitInput,
} from "./registry";
import {
  CALORIE_DIARY_MANIFEST,
  calorieDiaryDraft,
  changeField,
  checkDraft,
  draftFromJson,
  draftFromManifest,
  draftFromTemplate,
  emptyDraft,
  isUntouched,
  MAX_APP_FIELDS,
  MAX_PARTS,
  manifestJson,
  newField,
  newPart,
  nextVersion,
  REGISTRY_PAGE_SIZE,
  readAllPages,
  slugFromName,
} from "./registry";

/** Where an author writes a plugin version, checks it, sends it for review and follows its status. */
export function CreatePlugin({ template }: { template?: RegistryVersion }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const registry = queries.pluginRegistry;
  const mine = useQuery({
    queryKey: registry.mine.queryKey({ input: { limit: REGISTRY_PAGE_SIZE } }),
    queryFn: ({ signal }) =>
      readAllPages((after) => registry.mine.call({ limit: REGISTRY_PAGE_SIZE, after }, { signal })),
  });
  const versions = mine.data ?? [];
  const [draft, setDraftState] = useState<PluginDraft>(emptyDraft);
  const [issues, setIssues] = useState<DraftIssue[] | null>(null);
  const [checked, setChecked] = useState(false);
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const issueText = useIssueText();
  const [pendingTemplate, setPendingTemplate] = useState(template);
  if (pendingTemplate && !mine.isPending) {
    setPendingTemplate(undefined);
    setDraftState(draftFromTemplate(pendingTemplate, versions));
  }

  const submit = useSave({
    save: (input: SubmitInput, rpc) => rpc.pluginRegistry.submit(input),
    stale: [registry.mine.key()],
    onSaved: (saved) => {
      toast.success(t`Sent ${saved.manifest.name} version ${saved.version} for review`);
      setDraftState(emptyDraft());
      setIssues(null);
      setChecked(false);
    },
  });

  function setDraft(next: PluginDraft) {
    setDraftState(next);
    setChecked(false);
    if (issues) {
      const result = checkDraft(next);
      setIssues(result.ok ? [] : result.issues);
    }
    submit.reset();
  }

  function update(patch: Partial<PluginDraft>) {
    const next = { ...draft, ...patch };
    if (patch.name !== undefined && !draft.slugEdited) {
      next.slug = slugFromName(patch.name);
      next.version = String(nextVersion(versions, next.slug));
    }
    if (patch.slug !== undefined) next.version = String(nextVersion(versions, patch.slug));
    setDraft(next);
  }

  function updatePart(key: number, patch: Partial<PartDraft>) {
    update({
      parts: draft.parts.map((part) =>
        part.key === key ? ({ ...part, ...patch } as PartDraft) : part,
      ),
    });
  }

  function check() {
    const result = checkDraft(draft);
    setIssues(result.ok ? [] : result.issues);
    setChecked(result.ok);
    return result;
  }

  function startVersion(version: RegistryVersion) {
    setDraft(
      draftFromManifest(version.manifest, version.slug, nextVersion(versions, version.slug)),
    );
    setIssues(null);
  }

  function loadJson() {
    try {
      setDraft(draftFromJson(json, draft));
      setJson("");
      setJsonError(null);
    } catch {
      setJsonError(t`Paste a JSON manifest object.`);
    }
  }

  const issueAt = (...path: PropertyKey[]) =>
    issues?.find(
      (issue) =>
        issue.path.length === path.length &&
        issue.path.every((key, index) => String(key) === String(path[index])),
    );
  const fieldError = (...path: PropertyKey[]) => {
    const issue = issueAt(...path);
    return issue ? issueText(issue) : null;
  };
  const otherIssues =
    issues?.filter((issue) => {
      const [first, second, index, field] = issue.path.map(String);
      if (first === "slug" || first === "version") return false;
      if (first === "manifest" && (second === "name" || second === "description")) return false;
      return !(first === "manifest" && second === "parts" && index !== undefined && field);
    }) ?? [];
  const owned = new Set(versions.map((row) => row.slug));
  const reserved = owned.has(draft.slug.trim());

  return (
    <div data-testid="community-create" className="space-y-10">
      {isUntouched(draft) && !pendingTemplate ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-body text-muted-foreground">
            <Trans>Start from an example</Trans>
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="community-example-calorie-diary"
            onClick={() => setDraft(calorieDiaryDraft(versions))}
          >
            <NotebookPen />
            {CALORIE_DIARY_MANIFEST.name}
          </Button>
        </div>
      ) : null}
      <form
        className="space-y-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const result = check();
          if (result.ok) submit.run(result.input);
        }}
      >
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_7rem]">
          <Field data-invalid={Boolean(fieldError("manifest", "name"))}>
            <FieldLabel htmlFor="community-name">
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              id="community-name"
              value={draft.name}
              maxLength={120}
              placeholder={t`Release notes`}
              onChange={(event) => update({ name: event.target.value })}
            />
            <FieldIssue text={fieldError("manifest", "name")} />
          </Field>
          <Field data-invalid={Boolean(fieldError("slug"))}>
            <FieldLabel htmlFor="community-slug">
              <Trans>ID</Trans>
            </FieldLabel>
            <Input
              id="community-slug"
              value={draft.slug}
              maxLength={64}
              placeholder="release-notes"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => update({ slug: event.target.value, slugEdited: true })}
            />
            <FieldIssue text={fieldError("slug")} />
          </Field>
          <Field data-invalid={Boolean(fieldError("version"))}>
            <FieldLabel htmlFor="community-version-input">
              <Trans>Version</Trans>
            </FieldLabel>
            <Input
              id="community-version-input"
              inputMode="numeric"
              value={draft.version}
              onChange={(event) => setDraft({ ...draft, version: event.target.value })}
            />
            <FieldIssue text={fieldError("version")} />
          </Field>
        </div>
        <p className="-mt-2 text-body-sm text-muted-foreground">
          {reserved ? (
            <Trans>You own this ID. This sends a new version.</Trans>
          ) : (
            <Trans>Your first submission reserves the ID for you.</Trans>
          )}
        </p>
        <Field data-invalid={Boolean(fieldError("manifest", "description"))}>
          <FieldLabel htmlFor="community-description">
            <Trans>Description</Trans>
          </FieldLabel>
          <Textarea
            id="community-description"
            value={draft.description}
            maxLength={1000}
            rows={2}
            placeholder={t`What the app helps a bot do`}
            onChange={(event) => update({ description: event.target.value })}
          />
          <FieldIssue text={fieldError("manifest", "description")} />
        </Field>

        <section className="space-y-3">
          <SectionHeading as="h3">
            <Trans>Parts</Trans>
          </SectionHeading>
          {draft.parts.map((part, index) => (
            <PartEditor
              key={part.key}
              part={part}
              index={index}
              removable={draft.parts.length > 1}
              idError={fieldError("manifest", "parts", index, "id")}
              valueError={
                part.kind === "app"
                  ? (fieldError("manifest", "parts", index, "fields") ??
                    fieldError("manifest", "parts", index, "summaryField"))
                  : fieldError(
                      "manifest",
                      "parts",
                      index,
                      part.kind === "skill" ? "instructions" : "endpoint",
                    )
              }
              fieldIssue={(fieldIndex, key) =>
                fieldError("manifest", "parts", index, "fields", fieldIndex, key)
              }
              onChange={(patch) => updatePart(part.key, patch)}
              onRemove={() =>
                update({ parts: draft.parts.filter((entry) => entry.key !== part.key) })
              }
            />
          ))}
          {draft.parts.length < MAX_PARTS ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => update({ parts: [...draft.parts, newPart("skill", draft.parts)] })}
              >
                <FileText />
                <Trans>Add skill</Trans>
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => update({ parts: [...draft.parts, newPart("mcp", draft.parts)] })}
              >
                <Plug />
                <Trans>Add MCP tools</Trans>
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => update({ parts: [...draft.parts, newPart("app", draft.parts)] })}
              >
                <NotebookPen />
                <Trans>Add app</Trans>
              </Button>
            </div>
          ) : null}
        </section>

        <Disclosure
          summary={<Trans>Manifest JSON</Trans>}
          summaryClassName="text-body-sm text-muted-foreground"
        >
          <div className="mt-3 space-y-3">
            <pre
              data-testid="community-manifest-json"
              className="max-h-64 overflow-auto rounded-xl border border-border/70 px-4 py-3 font-mono text-body-sm text-foreground"
            >
              {manifestJson(draft)}
            </pre>
            <Field>
              <FieldLabel htmlFor="community-json">
                <Trans>Load a manifest</Trans>
              </FieldLabel>
              <Textarea
                id="community-json"
                value={json}
                rows={4}
                spellCheck={false}
                className="font-mono text-body-sm"
                placeholder='{ "schemaVersion": 1, "name": "…", "parts": [ … ] }'
                onChange={(event) => {
                  setJson(event.target.value);
                  setJsonError(null);
                }}
              />
              <FieldIssue text={jsonError} />
            </Field>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!json.trim()}
              onClick={loadJson}
            >
              <Trans>Load</Trans>
            </Button>
          </div>
        </Disclosure>

        {otherIssues.length ? (
          <ul role="alert" className="space-y-1 text-body-sm text-destructive">
            {otherIssues.map((issue) => (
              <li key={issue.path.map(String).join(".")}>{issueText(issue)}</li>
            ))}
          </ul>
        ) : null}
        {submit.error ? (
          <p role="alert" className="text-body text-destructive">
            {errorText(submit.error, t`Could not submit this app`)}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={submit.pending}>
            {submit.pending ? <Trans>Submitting…</Trans> : <Trans>Submit for review</Trans>}
          </Button>
          <Button type="button" variant="ghost" disabled={submit.pending} onClick={() => check()}>
            <Trans>Check</Trans>
          </Button>
          {checked ? (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-body-sm text-success"
            >
              <CircleCheck className="size-4" />
              <Trans>Ready to submit</Trans>
            </span>
          ) : null}
        </div>
      </form>

      <section data-testid="community-mine">
        <SectionHeading as="h2" className="mb-2 px-1">
          <Trans>Your submissions</Trans>
        </SectionHeading>
        {mine.isPending ? (
          <div className="grid place-items-center py-6">
            <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
          </div>
        ) : mine.isError ? (
          <div role="alert" className="flex items-center gap-3 text-body text-destructive">
            {errorText(mine.error, t`Could not load your submissions`)}
            <Button variant="outline" size="sm" onClick={() => void mine.refetch()}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : versions.length === 0 ? (
          <p className="px-1 text-body text-muted-foreground">
            <Trans>Nothing submitted yet.</Trans>
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
            {[...versions]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((version) => (
                <SubmissionRow
                  key={version.id}
                  version={version}
                  onNewVersion={() => startVersion(version)}
                />
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FieldIssue({ text }: { text: string | null | undefined }) {
  return text ? <FieldDescription className="text-destructive">{text}</FieldDescription> : null;
}

function PartEditor({
  part,
  index,
  removable,
  idError,
  valueError,
  fieldIssue,
  onChange,
  onRemove,
}: {
  part: PartDraft;
  index: number;
  removable: boolean;
  idError: string | null;
  valueError: string | null;
  fieldIssue: (fieldIndex: number, key: "id" | "label") => string | null;
  onChange: (patch: Partial<PartDraft>) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const Icon = part.kind === "skill" ? FileText : part.kind === "app" ? NotebookPen : Plug;
  const idField = `community-part-${part.key}-id`;
  const valueField = `community-part-${part.key}-value`;
  return (
    <div
      data-testid="community-part-editor"
      className="space-y-3 rounded-xl border border-border/70 px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <Icon size={16} className="shrink-0 text-muted-foreground" />
        <span className="flex-1 text-body font-medium text-foreground">
          {part.kind === "skill" ? (
            <Trans>Skill</Trans>
          ) : part.kind === "app" ? (
            <Trans>App</Trans>
          ) : (
            <Trans>MCP tools</Trans>
          )}
        </span>
        {removable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t`Remove part ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>
      <Field data-invalid={Boolean(idError)}>
        <FieldLabel htmlFor={idField}>
          <Trans>Part ID</Trans>
        </FieldLabel>
        <Input
          id={idField}
          value={part.id}
          maxLength={64}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(event) => onChange({ id: event.target.value })}
        />
        <FieldIssue text={idError} />
      </Field>
      {part.kind === "skill" ? (
        <Field data-invalid={Boolean(valueError)}>
          <FieldLabel htmlFor={valueField}>
            <Trans>Instructions</Trans>
          </FieldLabel>
          <Textarea
            id={valueField}
            value={part.instructions}
            rows={4}
            maxLength={16000}
            placeholder={t`Markdown the bot reads when it uses this skill`}
            onChange={(event) => onChange({ instructions: event.target.value })}
          />
          <FieldIssue text={valueError} />
        </Field>
      ) : part.kind === "app" ? (
        <AppFieldsEditor
          part={part}
          error={valueError}
          fieldIssue={fieldIssue}
          onChange={onChange}
        />
      ) : (
        <Field data-invalid={Boolean(valueError)}>
          <FieldLabel htmlFor={valueField}>
            <Trans>Endpoint</Trans>
          </FieldLabel>
          <Input
            id={valueField}
            value={part.endpoint}
            inputMode="url"
            spellCheck={false}
            placeholder="https://tools.example.com/mcp"
            onChange={(event) => onChange({ endpoint: event.target.value })}
          />
          {valueError ? (
            <FieldIssue text={valueError} />
          ) : (
            <FieldDescription>
              <Trans>A public HTTPS MCP server, with no credentials or query string.</Trans>
            </FieldDescription>
          )}
        </Field>
      )}
    </div>
  );
}

const FIELD_TYPES = ["text", "number", "date"] as const;

/** The form an installed app shows its members, and the number field it totals. */
function AppFieldsEditor({
  part,
  error,
  fieldIssue,
  onChange,
}: {
  part: Extract<PartDraft, { kind: "app" }>;
  error: string | null;
  fieldIssue: (fieldIndex: number, key: "id" | "label") => string | null;
  onChange: (patch: { fields: FieldDraft[]; summaryField: string }) => void;
}) {
  const { t } = useLingui();
  const typeLabel = { text: t`Text`, number: t`Number`, date: t`Date` };
  const numberFields = part.fields.filter((field) => field.type === "number" && field.id.trim());
  const summaryId = `community-part-${part.key}-summary`;

  /** Keeps the total on its field through renames, and drops it once that field is not a number. */
  function setFields(fields: FieldDraft[], summaryKey = summaryFieldKey()) {
    const summary = fields.find((field) => field.key === summaryKey && field.type === "number");
    onChange({ fields, summaryField: summary?.id ?? "" });
  }

  function summaryFieldKey() {
    return part.summaryField
      ? part.fields.find((field) => field.id === part.summaryField)?.key
      : undefined;
  }

  function changeAt(key: number, patch: Partial<Omit<FieldDraft, "key">>) {
    setFields(part.fields.map((field) => (field.key === key ? changeField(field, patch) : field)));
  }

  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-body font-medium text-foreground">
        <Trans>Fields</Trans>
      </legend>
      {part.fields.map((field, fieldIndex) => {
        const base = `community-part-${part.key}-field-${field.key}`;
        const labelIssue = fieldIssue(fieldIndex, "label");
        const idIssue = fieldIssue(fieldIndex, "id");
        return (
          <div
            key={field.key}
            data-testid="community-app-field-editor"
            className="grid items-start gap-3 sm:grid-cols-[1fr_9rem_7rem_auto_auto]"
          >
            <Field data-invalid={Boolean(labelIssue)}>
              <FieldLabel htmlFor={`${base}-label`}>
                <Trans>Label</Trans>
              </FieldLabel>
              <Input
                id={`${base}-label`}
                value={field.label}
                maxLength={120}
                placeholder={t`Calories (kcal)`}
                onChange={(event) => changeAt(field.key, { label: event.target.value })}
              />
              <FieldIssue text={labelIssue} />
            </Field>
            <Field data-invalid={Boolean(idIssue)}>
              <FieldLabel htmlFor={`${base}-id`}>
                <Trans>Field ID</Trans>
              </FieldLabel>
              <Input
                id={`${base}-id`}
                value={field.id}
                maxLength={64}
                spellCheck={false}
                autoCapitalize="off"
                className="font-mono"
                onChange={(event) => changeAt(field.key, { id: event.target.value })}
              />
              <FieldIssue text={idIssue} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${base}-type`}>
                <Trans>Type</Trans>
              </FieldLabel>
              <OptionSelect
                id={`${base}-type`}
                value={field.type}
                options={FIELD_TYPES.map((value) => ({ value, label: typeLabel[value] }))}
                onValueChange={(type) => changeAt(field.key, { type })}
              />
            </Field>
            <Field orientation="horizontal" className="w-auto sm:mt-8">
              <Checkbox
                id={`${base}-required`}
                checked={field.required}
                onCheckedChange={(required) => changeAt(field.key, { required })}
              />
              <FieldLabel htmlFor={`${base}-required`} className="font-normal">
                <Trans>Required</Trans>
              </FieldLabel>
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground sm:mt-7"
              aria-label={t`Remove field ${field.label || fieldIndex + 1}`}
              disabled={part.fields.length === 1}
              onClick={() => setFields(part.fields.filter((entry) => entry.key !== field.key))}
            >
              <Trash2 />
            </Button>
          </div>
        );
      })}
      <FieldIssue text={error} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {part.fields.length < MAX_APP_FIELDS ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setFields([...part.fields, newField()])}
          >
            <Plus />
            <Trans>Add field</Trans>
          </Button>
        ) : (
          <span />
        )}
        {numberFields.length ? (
          <div className="flex items-center gap-2">
            <label htmlFor={summaryId} className="text-body-sm text-muted-foreground">
              <Trans>Total</Trans>
            </label>
            <OptionSelect
              id={summaryId}
              size="sm"
              className="w-auto"
              value={part.summaryField || "none"}
              options={[
                { value: "none", label: t`No total` },
                ...numberFields.map((field) => ({
                  value: field.id,
                  label: field.label || field.id,
                })),
              ]}
              onValueChange={(value) =>
                setFields(
                  part.fields,
                  value === "none"
                    ? undefined
                    : part.fields.find((field) => field.id === value)?.key,
                )
              }
            />
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}

function SubmissionRow({
  version,
  onNewVersion,
}: {
  version: RegistryVersion;
  onNewVersion: () => void;
}) {
  const { i18n } = useLingui();
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.locale || "en", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  return (
    <li
      data-testid="community-submission"
      aria-label={`${version.manifest.name} ${version.version}`}
      className="space-y-1.5 px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-body-lg font-medium text-foreground">
              {version.manifest.name}
            </span>
            <StatusBadge status={version.status} />
          </div>
          <Facts>
            <span className="truncate font-mono">{version.slug}</span>
            <span>
              <Trans>Version {version.version}</Trans>
            </span>
            <span>
              {version.reviewedAt ? (
                <Trans>Reviewed {day(version.reviewedAt)}</Trans>
              ) : (
                <Trans>Sent {day(version.createdAt)}</Trans>
              )}
            </span>
          </Facts>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onNewVersion}>
          <Trans>New version</Trans>
        </Button>
      </div>
      {version.reason ? (
        <p className="text-body-sm whitespace-pre-wrap text-destructive" dir="auto">
          {version.reason}
        </p>
      ) : null}
    </li>
  );
}

export function StatusBadge({ status }: { status: RegistryVersion["status"] }): ReactNode {
  if (status === "approved")
    return (
      <Badge variant="secondary" className="text-success">
        <Trans>Approved</Trans>
      </Badge>
    );
  if (status === "rejected")
    return (
      <Badge variant="destructive">
        <Trans>Rejected</Trans>
      </Badge>
    );
  return (
    <Badge variant="outline">
      <Trans>In review</Trans>
    </Badge>
  );
}

/** What an author should fix, in the field's own words. */
function useIssueText() {
  const { t } = useLingui();
  return (issue: DraftIssue): string => {
    const path = issue.path.map(String);
    const [first, second, index, field] = path;
    if (first === "slug")
      return t`Use 1–64 lowercase letters, numbers and single hyphens, like release-notes.`;
    if (first === "version") return t`Use a whole number from 1.`;
    if (first !== "manifest") return issue.message;
    if (second === "name") return t`Add a name of up to 120 characters.`;
    if (second === "description") return t`Add a description of up to 1,000 characters.`;
    if (second !== "parts") return issue.message;
    if (index === undefined)
      return issue.code === "custom" ? t`Give every part a different ID.` : t`Add 1 to 16 parts.`;
    const part = Number(index) + 1;
    if (field === "fields") {
      const fieldIndex = path[4];
      if (fieldIndex === undefined)
        return issue.code === "custom"
          ? t`Give every field a different ID.`
          : t`Add 1 to 16 fields.`;
      if (path[5] === "label") return t`Add a label of up to 120 characters.`;
      if (path[5] === "id") return t`Use 1–64 lowercase letters, numbers and single hyphens.`;
      return t`Field ${Number(fieldIndex) + 1}: ${issue.message}`;
    }
    if (field === "summaryField") return t`Total a number field, or choose no total.`;
    if (field === "id") return t`Use 1–64 lowercase letters, numbers and single hyphens.`;
    if (field === "instructions") return t`Add instructions of up to 16,000 characters.`;
    if (field === "endpoint")
      return t`Use a public HTTPS URL with no credentials, query string or fragment.`;
    return t`Part ${part}: ${issue.message}`;
  };
}
