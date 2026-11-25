import { useLingui } from "@lingui/react/macro";
import type { WorkspaceState, WorkspaceStatus } from "../workspaces/workspace-status";

/** States where the server answers but cannot be used, so the app would only fail against it. */
export function workspaceUnusable(state: WorkspaceState): boolean {
  return state !== "checking" && state !== "online";
}

/** States a person can fix on the server, so their row offers how. */
export function workspaceFixable(state: WorkspaceState): boolean {
  return state === "not-enabled" || state === "unauthorized" || state === "incompatible";
}

/** The address as people say it: the host for https, the whole origin otherwise. */
export function workspaceHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.host : parsed.origin;
  } catch {
    return url;
  }
}

const DOT_CLASS: Record<WorkspaceState, string> = {
  checking: "bg-muted-foreground/40 animate-pulse motion-reduce:animate-none",
  online: "bg-success",
  offline: "bg-muted-foreground",
  "not-enabled": "bg-warning",
  unauthorized: "bg-warning",
  incompatible: "bg-warning",
};

export function useWorkspaceStatusWord(): (state: WorkspaceState) => string {
  const { t } = useLingui();
  return (state) => {
    switch (state) {
      case "checking":
        return t`Checking…`;
      case "online":
        return t`Online`;
      case "offline":
        return t`Offline`;
      case "not-enabled":
        return t`Not set up`;
      case "unauthorized":
        return t`No access`;
      case "incompatible":
        return t`Needs update`;
    }
  };
}

/** A dot and a word; the dot carries the name so the word is not read twice. */
export function CloudWorkspaceStatusLabel({ status }: { status: WorkspaceStatus }) {
  const word = useWorkspaceStatusWord()(status.state);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 text-body-sm text-muted-foreground"
      data-testid="cloud-workspace-status"
      data-state={status.state}
    >
      <span
        role="img"
        aria-label={word}
        className={`size-2 rounded-full ${DOT_CLASS[status.state]}`}
      />
      <span aria-hidden="true">{word}</span>
    </span>
  );
}
