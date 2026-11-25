import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import { Button } from "@rakazo/ui-web";
import { RotateCw } from "lucide-react";
import { useCallback, useState } from "react";
import type { CloudWorkspace } from "../workspaces/workspace-directory";
import type { WorkspaceStatus } from "../workspaces/workspace-status";
import { CloudPage } from "./CloudPage";
import { CloudWorkspaceHelp } from "./CloudWorkspaceHelp";

/** How long Try again shows it is checking, so a quick answer is still seen to have happened. */
const CHECKING_AT_LEAST_MS = 1200;

/**
 * The chosen workspace cannot be used. It recovers by itself: when the next check finds the
 * server online, the gate shows the app again.
 */
export function CloudWorkspaceUnavailable({
  workspace,
  status,
  checking,
  onRetry,
  onChoose,
}: {
  workspace: CloudWorkspace;
  /** The last answer; `checking` while a newer one is on its way. */
  status: WorkspaceStatus;
  checking: boolean;
  onRetry: () => void;
  onChoose: () => void;
}) {
  const { t } = useLingui();
  // A new object restarts the wait; null ends it.
  const [retried, setRetried] = useState<object | null>(null);
  const settle = useCallback(() => setRetried(null), []);
  useTimeout(settle, retried ? CHECKING_AT_LEAST_MS : null, retried);
  const showChecking = checking || retried !== null;
  const name = workspace.name;
  const title =
    status.state === "offline"
      ? t`${name} is offline`
      : status.state === "not-enabled"
        ? t`${name} isn't set up for Superbot Cloud`
        : status.state === "unauthorized"
          ? t`No access to ${name}`
          : t`${name} needs an update`;

  return (
    <CloudPage data-testid="cloud-workspace-unavailable">
      <div className="flex w-full max-w-[460px] flex-col" data-state={status.state}>
        <h1 className="text-balance text-heading2 font-medium tracking-tight">{title}</h1>
        <div className="mt-3">
          <CloudWorkspaceHelp status={status} />
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-2">
          <Button
            disabled={showChecking}
            aria-busy={showChecking || undefined}
            onClick={() => {
              setRetried({});
              onRetry();
            }}
          >
            <RotateCw
              data-icon="inline-start"
              className={showChecking ? "animate-spin motion-reduce:animate-none" : undefined}
            />
            <Trans>Try again</Trans>
          </Button>
          <Button variant="ghost" onClick={onChoose}>
            <Trans>Workspaces</Trans>
          </Button>
        </div>
      </div>
    </CloudPage>
  );
}
