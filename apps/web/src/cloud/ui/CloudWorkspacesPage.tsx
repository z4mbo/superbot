import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { ArrowLeft } from "lucide-react";
import type { Workspaces } from "../workspaces/use-workspaces";
import { CloudAccountMenu, CloudPage, SuperbotMark } from "./CloudPage";
import { CloudWorkspaceList } from "./CloudWorkspaceList";

/** Choosing a server: on first run, with none chosen, or from a workspace that cannot be used. */
export function CloudWorkspacesPage({
  workspaces,
  onBack,
}: {
  workspaces: Workspaces;
  /** Back to the chosen workspace, when the list was opened from it. */
  onBack?: () => void;
}) {
  const { t } = useLingui();
  const empty = workspaces.workspaces.length === 0;
  return (
    <CloudPage
      center={false}
      leading={
        onBack ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Back`}
            className="-ms-1.5 text-muted-foreground"
            onClick={onBack}
          >
            <ArrowLeft className="rtl:rotate-180" />
          </Button>
        ) : null
      }
      trailing={<CloudAccountMenu />}
      data-testid="cloud-workspaces-page"
    >
      <div className="flex w-full max-w-[560px] flex-col">
        <div className="flex flex-col items-center text-center">
          <SuperbotMark size={48} />
          <h1 className="mt-6 text-heading2 font-medium tracking-tight">
            <Trans>Workspaces</Trans>
          </h1>
          {empty ? (
            <p className="mt-2 text-body text-muted-foreground">
              <Trans>Add your Superbot server to get started.</Trans>
            </p>
          ) : null}
        </div>
        <div className="mt-8">
          <CloudWorkspaceList workspaces={workspaces} />
        </div>
      </div>
    </CloudPage>
  );
}
