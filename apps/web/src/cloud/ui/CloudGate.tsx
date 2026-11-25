import type { ReactNode } from "react";
import { lazy, Suspense, useRef, useState } from "react";
import { PageLoading } from "../../components/PageLoading";
import { useCloudAccounts } from "../accounts/cloud-accounts-context";
import { useWorkspaces } from "../workspaces/use-workspaces";
import type { WorkspaceStatus } from "../workspaces/workspace-status";
import { CloudWorkspacesFailed } from "./CloudPage";

const CloudSignInPage = lazy(() =>
  import("./CloudSignInPage").then((module) => ({ default: module.CloudSignInPage })),
);
const CloudWorkspacesPage = lazy(() =>
  import("./CloudWorkspacesPage").then((module) => ({ default: module.CloudWorkspacesPage })),
);
const CloudWorkspaceUnavailable = lazy(() =>
  import("./CloudWorkspaceUnavailable").then((module) => ({
    default: module.CloudWorkspaceUnavailable,
  })),
);

/**
 * Stands between the hosted build's entry and the app: sign-in when signed out, the workspace
 * list when none is chosen, an unavailable state when the chosen server cannot be used, and the
 * app itself (`children`) once it can.
 */
export function CloudGate({ children }: { children: ReactNode }) {
  const account = useCloudAccounts().useAccount();
  if (account.status === "loading") return <PageLoading />;
  if (account.status === "signed-out")
    return (
      <Page>
        <CloudSignInPage />
      </Page>
    );
  return <WorkspaceGate>{children}</WorkspaceGate>;
}

/** A lazily loaded page of the gate; the app itself is never held behind this boundary. */
function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}

function WorkspaceGate({ children }: { children: ReactNode }) {
  const workspaces = useWorkspaces();
  const [choosing, setChoosing] = useState(false);
  // The last settled answer for the chosen workspace, so a check in flight shows what it showed
  // before: the app stays through a recheck, and an unavailable page does not flash a spinner.
  const settled = useRef<{ id: string; status: WorkspaceStatus } | null>(null);

  if (workspaces.failed) return <CloudWorkspacesFailed onRetry={workspaces.reload} />;
  if (!workspaces.ready) return <PageLoading />;
  const active = workspaces.workspaces.find((workspace) => workspace.id === workspaces.activeId);
  if (!active || choosing) {
    return (
      <Page>
        <CloudWorkspacesPage
          workspaces={workspaces}
          onBack={active ? () => setChoosing(false) : undefined}
        />
      </Page>
    );
  }

  const status = workspaces.status(active.id);
  if (status.state !== "checking") settled.current = { id: active.id, status };
  const shown = settled.current?.id === active.id ? settled.current.status : null;
  if (!shown) return <PageLoading />;
  // While the server cannot be used the app is unmounted, so its queries and streams stop
  // instead of failing against it; it mounts afresh once the server is back.
  if (shown.state === "online") return children;
  return (
    <Page>
      <CloudWorkspaceUnavailable
        workspace={active}
        status={shown}
        checking={status.state === "checking"}
        onRetry={() => workspaces.recheck(active.id)}
        onChoose={() => setChoosing(true)}
      />
    </Page>
  );
}
