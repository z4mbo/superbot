import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { PageLoading } from "../../components/PageLoading";
import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";
import { useWorkspaces } from "../workspaces/use-workspaces";
import { useCloudSignOut } from "./CloudPage";
import { CloudWorkspaceList } from "./CloudWorkspaceList";

/** Settings → Workspaces in the hosted build: the servers, and the cloud account signed in. */
export function CloudWorkspacesSettings() {
  const { t } = useLingui();
  const workspaces = useWorkspaces();
  const { email, signOut, pending } = useCloudSignOut();
  return (
    <div className="space-y-8" data-testid="cloud-workspaces-settings">
      {workspaces.failed ? (
        <div className="flex items-center gap-3 text-body-sm text-muted-foreground">
          <Trans>Could not load your workspaces.</Trans>
          <Button variant="ghost" size="sm" className="rounded-full" onClick={workspaces.reload}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : workspaces.ready ? (
        <CloudWorkspaceList workspaces={workspaces} />
      ) : (
        <PageLoading className="grid h-24 place-items-center" />
      )}
      <SettingsGroup title={t`Superbot Cloud account`}>
        <SettingsRow
          label={<p className="break-all">{email ?? t`Signed in`}</p>}
          control={
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              disabled={pending}
              onClick={signOut}
            >
              <Trans>Sign out</Trans>
            </Button>
          }
        />
      </SettingsGroup>
    </div>
  );
}
