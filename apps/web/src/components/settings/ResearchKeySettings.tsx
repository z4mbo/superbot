import { Trans, useLingui } from "@lingui/react/macro";
import type { ResearchKeyProvider } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { spaceQueries, useQueryUserId, useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/**
 * The account's own keys for the optional web research tools, one row per provider the server
 * offers. A saved key is never shown again: it can only be replaced or removed.
 */
export function ResearchKeySettings() {
  const userId = useQueryUserId();
  const providers = useQuery({
    ...spaceQueries(userId, null).researchKeys.list.queryOptions(),
    enabled: userId !== null,
  }).data;
  if (!providers?.length) return null;
  return (
    <SettingsGroup title={<Trans>Web research</Trans>} data-testid="research-key-settings">
      {providers.map((provider) => (
        <ResearchKeyRow key={provider.id} provider={provider} />
      ))}
    </SettingsGroup>
  );
}

function ResearchKeyRow({ provider }: { provider: ResearchKeyProvider }) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const stale = [spaceQueries(userId, null).researchKeys.list.queryKey()];
  const close = () => {
    setKey("");
    setEditing(false);
  };
  const save = useSave({
    save: (next: string, client) => client.researchKeys.save({ provider: provider.id, key: next }),
    stale,
    onSaved: close,
  });
  const remove = useSave({
    save: (_, client) => client.researchKeys.remove({ provider: provider.id }),
    stale,
    onSaved: close,
  });
  const pending = save.pending || remove.pending;
  const label = t`${provider.label} API key`;
  const error = save.error
    ? errorText(save.error, t`Could not save the key`)
    : remove.error
      ? errorText(remove.error, t`Could not remove the key`)
      : null;

  if (!editing) {
    return (
      <SettingsRow
        label={label}
        control={
          <>
            {provider.saved ? (
              <span className="text-body-sm text-muted-foreground">
                <Trans>Saved</Trans>
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              aria-label={provider.saved ? t`Replace ${label}` : t`Add ${label}`}
              onClick={() => {
                save.reset();
                remove.reset();
                setEditing(true);
              }}
            >
              {provider.saved ? <Trans>Replace</Trans> : <Trans>Add</Trans>}
            </Button>
          </>
        }
      />
    );
  }

  return (
    <form
      className="space-y-3 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (key.trim()) save.run(key.trim());
      }}
    >
      <Field>
        <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={key}
          disabled={pending}
          onChange={(event) => {
            save.reset();
            setKey(event.target.value);
          }}
        />
      </Field>
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || !key.trim()}>
          <Trans>Save</Trans>
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={close}>
          <Trans>Cancel</Trans>
        </Button>
        {provider.saved ? (
          <Button
            type="button"
            variant="ghost"
            className="ms-auto text-destructive"
            disabled={pending}
            aria-label={t`Remove ${label}`}
            onClick={() => remove.run()}
          >
            <Trans>Remove</Trans>
          </Button>
        ) : null}
      </div>
    </form>
  );
}
