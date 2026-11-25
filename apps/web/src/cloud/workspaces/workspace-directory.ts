import { z } from "zod";

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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HAS_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

/** The server origin a typed address names (a bare host means https), or why it is refused. */
export function normalizeWorkspaceUrl(
  input: string,
): { ok: true; url: string } | { ok: false; problem: Exclude<WorkspaceUrlProblem, "duplicate"> } {
  const typed = input.trim();
  if (!typed || /\s/.test(typed)) return { ok: false, problem: "invalid" };
  const url = URL.parse(HAS_SCHEME.test(typed) ? typed : `https://${typed}`);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) {
    return { ok: false, problem: "invalid" };
  }
  // `URL` drops an empty `?` or `#`, so the typed text is checked for them too.
  if (url.username || url.password || url.pathname !== "/" || /[?#]/.test(typed)) {
    return { ok: false, problem: "not-an-origin" };
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, problem: "insecure" };
  }
  return { ok: true, url: url.origin };
}

/** Where the list is kept: one JSON value, read and written whole. */
export type WorkspaceDocument = {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
};

const NAME_MAX = 100;

const StoredWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  url: z.string().refine((url) => {
    const normalized = normalizeWorkspaceUrl(url);
    return normalized.ok && normalized.url === url;
  }),
  kind: z.enum(["self-hosted", "hosted"]),
  addedAt: z.string(),
});

/** Entries that are not workspaces (hand-edited, or from a newer build) are left out, not fatal. */
export function readWorkspaces(value: unknown): CloudWorkspace[] {
  if (!Array.isArray(value)) return [];
  const workspaces: CloudWorkspace[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const parsed = StoredWorkspaceSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    workspaces.push(parsed.data);
  }
  return workspaces;
}

function workspaceName(name: string, url: string): string {
  return name.trim().slice(0, NAME_MAX) || new URL(url).host;
}

/**
 * The list kept in one JSON document. This tab's changes run one at a time, each on a fresh
 * read, so two quick edits never drop each other.
 */
export function createWorkspaceDirectory(
  document: WorkspaceDocument,
  options: { now?: () => Date; newId?: () => string } = {},
): WorkspaceDirectory {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const read = async () => readWorkspaces(await document.read());
  const change = (edit: (workspaces: CloudWorkspace[]) => CloudWorkspace[] | null) =>
    serially(async () => {
      const next = edit(await read());
      if (next) await document.write(next);
    });

  return {
    list: () => serially(read),
    async add(input) {
      const normalized = normalizeWorkspaceUrl(input.url);
      if (!normalized.ok) throw new WorkspaceUrlError(normalized.problem);
      const { url } = normalized;
      const added: CloudWorkspace = {
        id: newId(),
        name: workspaceName(input.name, url),
        url,
        kind: "self-hosted",
        addedAt: now().toISOString(),
      };
      await change((workspaces) => {
        if (workspaces.some((workspace) => workspace.url === url)) {
          throw new WorkspaceUrlError("duplicate");
        }
        return [...workspaces, added];
      });
      return added;
    },
    rename: (id, name) =>
      change((workspaces) => {
        const index = workspaces.findIndex((workspace) => workspace.id === id);
        const workspace = workspaces[index];
        if (!workspace) return null;
        return workspaces.with(index, { ...workspace, name: workspaceName(name, workspace.url) });
      }),
    remove: (id) =>
      change((workspaces) =>
        workspaces.some((workspace) => workspace.id === id)
          ? workspaces.filter((workspace) => workspace.id !== id)
          : null,
      ),
  };
}
