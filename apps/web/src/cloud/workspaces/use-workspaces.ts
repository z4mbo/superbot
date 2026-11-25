import type { CloudWorkspace } from "./workspace-directory";
import type { WorkspaceStatus } from "./workspace-status";

/** The workspace this tab is connected to, read once at startup. Null until one is chosen. */
export type ActiveWorkspace = { id: string; url: string };

export type Workspaces = {
  /** False until the list has been read once. */
  ready: boolean;
  /** Set when the list could not be read; `reload` tries again. */
  failed: boolean;
  reload(): void;
  workspaces: CloudWorkspace[];
  activeId: string | null;
  /** `checking` for a workspace not probed yet. */
  status(id: string): WorkspaceStatus;
  /** Probe one workspace now, or all of them. */
  recheck(id?: string): void;
  /** Rejects with `WorkspaceUrlError`. The first workspace added becomes the active one. */
  add(input: { name: string; url: string }): Promise<CloudWorkspace>;
  rename(id: string, name: string): Promise<void>;
  /** Removing the active workspace leaves none active. */
  remove(id: string): Promise<void>;
  /** Connects this tab to another server; the page reloads so nothing of the old one is left. */
  setActive(id: string): void;
};

/** Read at startup, before anything renders, so every request knows its server. */
export function activeWorkspace(): ActiveWorkspace | null {
  throw new Error("not implemented");
}

/** The signed-in person's workspaces and their live status. Only under the cloud provider. */
export function useWorkspaces(): Workspaces {
  throw new Error("not implemented");
}
