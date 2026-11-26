import { Trans, useLingui } from "@lingui/react/macro";
import type { MediaCatalog, MediaKind, MediaProviderEntry } from "@rakazo/contracts";
import {
  Button,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  OptionSelect,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { AddProvider, SettingsListRow } from "../providers-section";
import type { MediaChoiceOption } from "./media-choices";
import {
  AUTOMATIC_MEDIA,
  mediaChoiceOptions,
  mediaKindAvailable,
  parseMediaChoice,
  selectedMediaChoice,
} from "./media-choices";

/**
 * Images and video: which provider makes each, and the keys that connect them. Keys are the
 * person's own, so this shows only on the account's page.
 */
export function MediaSettings({
  modelProviderName,
}: {
  /** A model provider's display name, for a media provider that borrows its connection. */
  modelProviderName: (id: string) => string;
}) {
  const queries = useSpaceQueries();
  const catalog = useQuery(queries.media.catalog.queryOptions()).data;
  // The provider whose key form is open.
  const [open, setOpen] = useState<string | null>(null);
  if (!catalog) return null;
  const connected = catalog.providers.filter((entry) => entry.connected);
  const addable = catalog.providers.filter((entry) => !entry.connected && entry.fields.length);
  const anything = mediaKindAvailable(catalog, "image") || mediaKindAvailable(catalog, "video");
  const editing = catalog.providers.find((entry) => entry.id === open && entry.fields.length);
  return (
    <section className="mb-8" data-testid="media-settings">
      <SectionHeading className="mb-2.5">
        <Trans>Images and video</Trans>
      </SectionHeading>
      {anything ? (
        <FieldGroup className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MediaChooser catalog={catalog} kind="image" />
          <MediaChooser catalog={catalog} kind="video" />
        </FieldGroup>
      ) : (
        <p className="mb-3 text-body text-muted-foreground" data-testid="media-unavailable">
          <Trans>Images and video are unavailable. Add a provider to make them.</Trans>
        </p>
      )}
      <ul className="divide-y divide-border rounded-xl border border-border">
        {connected.map((entry) => (
          <li key={entry.id} data-testid={`media-provider-${entry.id}`}>
            <MediaProviderRow
              entry={entry}
              modelProviderName={modelProviderName}
              onOpen={() => setOpen(open === entry.id ? null : entry.id)}
            />
          </li>
        ))}
        {addable.length ? (
          <li>
            <AddProvider
              providers={addable.map((entry) => ({ id: entry.id, name: entry.name }))}
              onPick={(provider) => setOpen(provider.id)}
            />
          </li>
        ) : null}
      </ul>
      {editing ? (
        <MediaKeyForm key={editing.id} entry={editing} onClose={() => setOpen(null)} />
      ) : null}
    </section>
  );
}

function MediaProviderRow({
  entry,
  modelProviderName,
  onOpen,
}: {
  entry: MediaProviderEntry;
  modelProviderName: (id: string) => string;
  onOpen: () => void;
}) {
  const hints = Object.values(entry.hints).join(" · ");
  const borrowed = entry.source === "model_connection" ? entry.modelConnections[0] : undefined;
  const detail = borrowed ? (
    <Trans>Via {modelProviderName(borrowed)}</Trans>
  ) : hints ? (
    <span dir="auto">{hints}</span>
  ) : null;
  // A borrowed connection has nothing to paste.
  if (borrowed || !entry.fields.length) {
    return (
      <div className="flex min-h-[52px] items-center gap-2.5 px-3 py-2 first:rounded-t-xl">
        <span className="min-w-0 flex-1 truncate text-body-lg text-foreground">{entry.name}</span>
        <span className="shrink-0 truncate text-body-sm text-muted-foreground">{detail}</span>
      </div>
    );
  }
  return (
    <SettingsListRow label={entry.name} onClick={onOpen}>
      {detail ? (
        <span className="max-w-[45%] shrink-0 truncate text-body-sm text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </SettingsListRow>
  );
}

function MediaChooser({ catalog, kind }: { catalog: MediaCatalog; kind: MediaKind }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const available = mediaKindAvailable(catalog, kind);
  const choose = useSave({
    save: (value: string, rpc) => {
      const choice = parseMediaChoice(value);
      return rpc.media.setPreference({
        kind,
        provider: choice?.provider ?? null,
        model: choice?.model ?? null,
      });
    },
    stale: [queries.media.catalog.key()],
  });
  const label = (option: MediaChoiceOption) => {
    const name = option.providerName;
    if (option.value === AUTOMATIC_MEDIA) return available ? t`Automatic` : t`Unavailable`;
    if (option.unavailable === "not_connected") return t`${name} (not connected)`;
    if (option.unavailable === "cannot_make")
      return kind === "video" ? t`${name} (no video)` : t`${name} (no images)`;
    return `${name} · ${option.modelName}`;
  };
  const options = mediaChoiceOptions(catalog, kind).map((option, index, all) => ({
    value: option.value,
    label: label(option),
    disabled: Boolean(option.unavailable),
    startsGroup: Boolean(option.unavailable) && !all[index - 1]?.unavailable,
  }));
  const id = `media-choice-${kind}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        {kind === "video" ? <Trans>Video</Trans> : <Trans>Images</Trans>}
      </FieldLabel>
      <OptionSelect
        id={id}
        data-testid={id}
        value={choose.pending && choose.input ? choose.input : selectedMediaChoice(catalog, kind)}
        options={options}
        disabled={!available || choose.pending}
        onValueChange={(value) => choose.run(value)}
      />
      {choose.error ? (
        <p className="text-body-sm text-destructive" role="alert">
          {errorText(choose.error, t`Could not save`)}
        </p>
      ) : null}
    </Field>
  );
}

/** Adds, replaces or removes a provider's key. A saved secret is never shown again. */
function MediaKeyForm({ entry, onClose }: { entry: MediaProviderEntry; onClose: () => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const saved = entry.source === "key";
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      entry.fields.map((field) => [
        field.name,
        field.secret ? "" : (entry.hints[field.name] ?? ""),
      ]),
    ),
  );
  const connect = useSave({
    save: (fields: Record<string, string>, rpc) =>
      rpc.media.connect({ provider: entry.id, fields }),
    stale: [queries.media.catalog.key()],
    onSaved: onClose,
  });
  const remove = useSave({
    save: (_, rpc) => rpc.media.disconnect({ provider: entry.id }),
    stale: [queries.media.catalog.key()],
    onSaved: onClose,
  });
  const busy = connect.pending || remove.pending;
  // A blank secret keeps the saved one; anything else must be filled in.
  const ready = entry.fields.every(
    (field) => (field.secret && saved) || values[field.name]?.trim(),
  );
  const error = connect.error ?? remove.error;
  return (
    <form
      className="mt-3 rounded-xl border border-border px-4 py-4"
      data-testid="media-key-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) connect.run(values);
      }}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h4 className="min-w-0 truncate text-body-lg font-medium text-foreground">
          {saved ? entry.name : <Trans>Connect {entry.name}</Trans>}
        </h4>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-me-1.5 shrink-0 text-muted-foreground"
          aria-label={t`Close`}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <fieldset className="contents" disabled={busy}>
        <FieldGroup className="gap-4">
          {entry.fields.map((field) => {
            const id = `media-${entry.id}-${field.name}`;
            return (
              <Field key={field.name}>
                <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
                <Input
                  id={id}
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  // A saved secret stays on the server; the placeholder says one is there.
                  placeholder={field.secret && saved ? t`Saved` : undefined}
                  value={values[field.name] ?? ""}
                  onChange={(event) => {
                    connect.reset();
                    setValues({ ...values, [field.name]: event.target.value });
                  }}
                />
              </Field>
            );
          })}
        </FieldGroup>
        {error ? (
          <p className="mt-3 text-body text-destructive" role="alert">
            {errorText(
              error,
              connect.error ? t`Could not save the key` : t`Could not remove the key`,
            )}
          </p>
        ) : null}
        <div className="mt-4 flex items-center gap-2">
          <Button type="submit" variant="secondary" size="sm" disabled={!ready || busy}>
            {connect.pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
          {saved ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => remove.run()}
            >
              {remove.pending ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
            </Button>
          ) : null}
        </div>
      </fieldset>
    </form>
  );
}
