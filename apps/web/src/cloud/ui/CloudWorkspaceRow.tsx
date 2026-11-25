import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Disclosure,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "@rakazo/ui-web";
import { MoreHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SettingsRow } from "../../components/settings/SettingsRows";
import { useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import type { Workspaces } from "../workspaces/use-workspaces";
import type { CloudWorkspace } from "../workspaces/workspace-directory";
import { CloudWorkspaceHelp } from "./CloudWorkspaceHelp";
import { CloudWorkspaceStatusLabel, workspaceFixable, workspaceHost } from "./CloudWorkspaceStatus";

/** One server: its name and address, how it answers, and what can be done with it. */
export function CloudWorkspaceRow({
  workspace,
  workspaces,
}: {
  workspace: CloudWorkspace;
  workspaces: Workspaces;
}) {
  const { t } = useLingui();
  const [dialog, setDialog] = useState<"rename" | "remove" | null>(null);
  const status = workspaces.status(workspace.id);
  const current = workspace.id === workspaces.activeId;
  const host = workspaceHost(workspace.url);
  return (
    <div data-testid="cloud-workspace-row" data-workspace-id={workspace.id}>
      <SettingsRow
        label={
          <div className="min-w-0">
            <p className="truncate">{workspace.name}</p>
            {host !== workspace.name ? (
              <p className="truncate text-label text-muted-foreground">{host}</p>
            ) : null}
          </div>
        }
        control={
          <>
            <CloudWorkspaceStatusLabel status={status} />
            {current ? (
              <span className="px-2.5 text-body-sm text-foreground">
                <Trans>Current</Trans>
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full"
                aria-label={t`Open ${workspace.name}`}
                onClick={() => workspaces.setActive(workspace.id)}
              >
                <Trans>Open</Trans>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="-me-1.5 text-muted-foreground"
                    aria-label={t`${workspace.name} options`}
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuItem onClick={() => workspaces.recheck(workspace.id)}>
                  <Trans>Check again</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDialog("rename")}>
                  <Trans>Rename</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => setDialog("remove")}>
                  <Trans>Remove</Trans>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        {workspaceFixable(status.state) ? (
          <Disclosure
            className="pt-2"
            summary={
              <span className="text-body-sm text-muted-foreground">
                <Trans>How to fix</Trans>
              </span>
            }
            contentClassName="pt-2"
          >
            <CloudWorkspaceHelp status={status} />
          </Disclosure>
        ) : null}
      </SettingsRow>
      {dialog === "rename" ? (
        <RenameDialog
          workspace={workspace}
          rename={workspaces.rename}
          onDone={() => setDialog(null)}
        />
      ) : null}
      {dialog === "remove" ? (
        <RemoveDialog
          workspace={workspace}
          remove={workspaces.remove}
          onDone={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

function RenameDialog({
  workspace,
  rename,
  onDone,
}: {
  workspace: CloudWorkspace;
  rename: Workspaces["rename"];
  onDone: () => void;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState(workspace.name);
  const save = useSave({
    save: (next: string) => rename(workspace.id, next),
    onSaved: onDone,
    closesScreen: true,
  });
  const trimmed = name.trim();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (save.pending) return;
    if (!trimmed || trimmed === workspace.name) return onDone();
    save.run(trimmed);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.pending) onDone();
      }}
    >
      <DialogContent showCloseButton={false}>
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              <Trans>Rename workspace</Trans>
            </DialogTitle>
          </DialogHeader>
          <label htmlFor={nameId} className="sr-only">
            <Trans>Name</Trans>
          </label>
          <Input
            id={nameId}
            maxLength={60}
            autoFocus
            value={name}
            disabled={save.pending}
            onChange={(event) => {
              setName(event.target.value);
              save.reset();
            }}
          />
          {save.error ? (
            <p role="alert" className="text-body text-destructive">
              {errorText(save.error, t`Could not rename the workspace`)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.pending} onClick={onDone}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={save.pending || !trimmed}>
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  workspace,
  remove,
  onDone,
}: {
  workspace: CloudWorkspace;
  remove: Workspaces["remove"];
  onDone: () => void;
}) {
  const { t } = useLingui();
  const save = useSave({ save: () => remove(workspace.id), onSaved: onDone, closesScreen: true });
  return (
    <ConfirmDialog
      onCancel={onDone}
      title={t`Remove ${workspace.name}?`}
      description={<Trans>The server and its data stay as they are.</Trans>}
      error={save.error ? errorText(save.error, t`Could not remove the workspace`) : null}
      confirmLabel={<Trans>Remove</Trans>}
      busy={save.pending}
      onConfirm={() => save.run()}
    />
  );
}
