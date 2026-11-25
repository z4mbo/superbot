import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Plus } from "lucide-react";
import { useState } from "react";
import { SettingsGroup } from "../../components/settings/SettingsRows";
import type { Workspaces } from "../workspaces/use-workspaces";
import { AddCloudWorkspaceForm } from "./AddCloudWorkspaceForm";
import { CloudWorkspaceRow } from "./CloudWorkspaceRow";

/**
 * A person's workspaces and the way to add one; the same list on the full page and in Settings.
 * With none yet the add form is all there is, so it starts open.
 */
export function CloudWorkspaceList({ workspaces }: { workspaces: Workspaces }) {
  const empty = workspaces.workspaces.length === 0;
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-6" data-testid="cloud-workspaces">
      {empty ? null : (
        <SettingsGroup>
          {workspaces.workspaces.map((workspace) => (
            <CloudWorkspaceRow key={workspace.id} workspace={workspace} workspaces={workspaces} />
          ))}
        </SettingsGroup>
      )}
      {empty || adding ? (
        <div className="space-y-4">
          <AddCloudWorkspaceForm
            workspaces={workspaces}
            onCancel={empty ? undefined : () => setAdding(false)}
            onAdded={() => setAdding(false)}
          />
          <HostedWorkspaceOption />
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full"
          data-testid="cloud-workspace-add-open"
          onClick={() => setAdding(true)}
        >
          <Plus />
          <Trans>Add workspace</Trans>
        </Button>
      )}
    </div>
  );
}

/** Room for servers we will run for people; nothing to choose yet. */
function HostedWorkspaceOption() {
  return (
    <button
      type="button"
      disabled
      data-testid="cloud-workspace-hosted"
      className="flex w-full items-center justify-between gap-4 rounded-[14px] border border-dashed border-hairline px-3.5 py-3 text-start text-body-sm text-muted-foreground"
    >
      <span>
        <Trans>Hosted workspace</Trans>
      </span>
      <span className="text-label">
        <Trans>Coming soon</Trans>
      </span>
    </button>
  );
}
