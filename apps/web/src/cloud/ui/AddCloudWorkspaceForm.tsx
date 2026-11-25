import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Field, FieldError, FieldGroup, FieldLabel, Input, toast } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import type { Workspaces } from "../workspaces/use-workspaces";
import type { WorkspaceUrlProblem } from "../workspaces/workspace-directory";
import { WorkspaceUrlError } from "../workspaces/workspace-directory";

/** The host a typed address names, as the name a workspace gets when none is typed. */
function typedHost(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).host;
  } catch {
    return "";
  }
}

export function AddCloudWorkspaceForm({
  workspaces,
  onCancel,
  onAdded,
}: {
  workspaces: Pick<Workspaces, "add">;
  /** Shown as Cancel when the form was opened from a list and can fold away again. */
  onCancel?: () => void;
  onAdded?: () => void;
}) {
  const { t } = useLingui();
  const urlId = useId();
  const nameId = useId();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const adding = useSave({
    save: (input: { name: string; url: string }) => workspaces.add(input),
    onSaved: () => {
      setUrl("");
      setName("");
      onAdded?.();
    },
    onFailed: (error) => {
      if (!(error instanceof WorkspaceUrlError))
        toast.error(errorText(error, t`Could not add the workspace`));
    },
  });
  const problem = adding.error instanceof WorkspaceUrlError ? adding.error.problem : null;
  const problemText: Record<WorkspaceUrlProblem, string> = {
    invalid: t`Enter a server address`,
    insecure: t`Use https`,
    "not-an-origin": t`Only the server address, without a path`,
    duplicate: t`Already added`,
  };
  const host = typedHost(url);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (adding.pending) return;
    adding.run({ name: name.trim() || host, url: url.trim() });
  }

  return (
    <form onSubmit={submit} data-testid="cloud-workspace-add" noValidate>
      <FieldGroup className="gap-4">
        <Field data-invalid={problem ? true : undefined}>
          <FieldLabel htmlFor={urlId}>
            <Trans>Server URL</Trans>
          </FieldLabel>
          <Input
            id={urlId}
            name="url"
            type="url"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="bots.example.com"
            value={url}
            disabled={adding.pending}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${urlId}-error` : undefined}
            onChange={(event) => {
              setUrl(event.target.value);
              adding.reset();
            }}
          />
          {problem ? <FieldError id={`${urlId}-error`}>{problemText[problem]}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor={nameId}>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            id={nameId}
            name="name"
            maxLength={60}
            placeholder={host}
            value={name}
            disabled={adding.pending}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={adding.pending || !url.trim()}>
            {adding.pending ? <Trans>Adding…</Trans> : <Trans>Add workspace</Trans>}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" disabled={adding.pending} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </form>
  );
}
