/**
 * A workspace is one server a person connects the hosted site to. `hosted` is reserved for
 * servers we will run for people without their own; nothing creates one yet.
 */
export type WorkspaceKind = "self-hosted" | "hosted";

export type CloudWorkspace = {
  id: string;
  name: string;
  /** The server's origin, e.g. `https://bots.example.com`; no path, query or trailing slash. */
  url: string;
  kind: WorkspaceKind;
  /** ISO time. */
  addedAt: string;
};

/**
 * A person's list of workspaces. Kept behind an interface because where it lives will change:
 * with the account today, a database of ours once hosted workspaces exist.
 */
export interface WorkspaceDirectory {
  list(): Promise<CloudWorkspace[]>;
  /** Rejects with `WorkspaceUrlError` for a URL `normalizeWorkspaceUrl` refuses. */
  add(input: { name: string; url: string }): Promise<CloudWorkspace>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * - `invalid`: not a URL.
 * - `insecure`: plain http to anything but this computer (`localhost`, `127.0.0.1`, `[::1]`).
 * - `not-an-origin`: carries a path, query, fragment, username or password.
 * - `duplicate`: already in the list.
 */
export type WorkspaceUrlProblem = "invalid" | "insecure" | "not-an-origin" | "duplicate";

export class WorkspaceUrlError extends Error {
  constructor(readonly problem: WorkspaceUrlProblem) {
    super(`Workspace URL refused: ${problem}`);
    this.name = "WorkspaceUrlError";
  }
}

/** The server origin a typed address names (a bare host means https), or why it is refused. */
export function normalizeWorkspaceUrl(
  _input: string,
): { ok: true; url: string } | { ok: false; problem: Exclude<WorkspaceUrlProblem, "duplicate"> } {
  throw new Error("not implemented");
}
