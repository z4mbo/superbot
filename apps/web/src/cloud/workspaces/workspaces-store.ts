import type { CloudAccounts } from "../accounts/cloud-accounts";
import type { ActiveWorkspaceStorage } from "./active-workspace";
import {
  RECHECK_ACTIVE_WORKSPACE_EVENT,
  startupActiveWorkspace,
  writeActiveWorkspace,
} from "./active-workspace";
import type { ActiveWorkspace } from "./use-workspaces";
import type { CloudWorkspace, WorkspaceDirectory } from "./workspace-directory";
import { createWorkspaceDirectory } from "./workspace-directory";
import { probeWorkspace } from "./workspace-probe";
import type { WorkspaceStatus } from "./workspace-status";

/**
 * How often every workspace is probed while the list is on screen. This is a reachability check
 * of servers the person runs, not a data read: their data still arrives over the server's own
 * change stream once the app is connected.
 */
export const WORKSPACE_PROBE_INTERVAL_MS = 15_000;
/** The account document that holds the list. */
export const WORKSPACES_DOCUMENT = "workspaces";

export type WorkspacesState = {
  ready: boolean;
  failed: boolean;
  workspaces: CloudWorkspace[];
  activeId: string | null;
  statuses: ReadonlyMap<string, WorkspaceStatus>;
};

export type WorkspacesStoreDeps = {
  directory: WorkspaceDirectory;
  probe: (url: string) => Promise<WorkspaceStatus>;
  storage: ActiveWorkspaceStorage | null;
  /** The workspace the page was loaded for. */
  initialActive: ActiveWorkspace | null;
  /** Loads a fresh page, so nothing of the previous server survives. */
  navigate: (url: string) => void;
  isHidden: () => boolean;
  /** `focus` and `recheck` on the window, `visibilitychange` on the document. */
  listen: (type: "focus" | "visibilitychange" | "recheck", listener: () => void) => () => void;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  intervalMs?: number;
};

export type WorkspacesStore = ReturnType<typeof createWorkspacesStore>;

/**
 * One list and one poller per account service, however many screens show it. Probing runs only
 * while something is subscribed and someone is signed in, and pauses while the tab is hidden.
 */
export function createWorkspacesStore(deps: WorkspacesStoreDeps) {
  let state: WorkspacesState = {
    ready: false,
    failed: false,
    workspaces: [],
    activeId: deps.initialActive?.id ?? null,
    statuses: new Map(),
  };
  const listeners = new Set<() => void>();
  let user: string | null = null;
  /** Bumped when the signed-in account changes; answers for an older one are dropped. */
  let generation = 0;
  const inFlight = new Map<string, number>();
  let stopPolling: (() => void) | null = null;

  const update = (patch: Partial<WorkspacesState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const setStatus = (id: string, status: WorkspaceStatus) => {
    update({ statuses: new Map(state.statuses).set(id, status) });
  };

  const probe = (workspace: CloudWorkspace, showChecking: boolean) => {
    if (showChecking && state.statuses.has(workspace.id)) {
      setStatus(workspace.id, { state: "checking" });
    }
    if (inFlight.has(workspace.id)) return;
    const mine = generation;
    inFlight.set(workspace.id, mine);
    void deps
      .probe(workspace.url)
      .catch((): WorkspaceStatus => ({ state: "offline" }))
      .then((status) => {
        if (inFlight.get(workspace.id) === mine) inFlight.delete(workspace.id);
        const current = mine === generation && state.workspaces.some((w) => w.id === workspace.id);
        if (current) setStatus(workspace.id, status);
      });
  };
  const probeAll = (showChecking = false) => {
    for (const workspace of state.workspaces) probe(workspace, showChecking);
  };

  const apply = (workspaces: CloudWorkspace[]) => {
    let { activeId } = state;
    // Removed in another tab or on another device: this browser is connected to nothing now.
    if (activeId && !workspaces.some((workspace) => workspace.id === activeId)) {
      writeActiveWorkspace(null, deps.storage);
      activeId = null;
    }
    const kept = new Set(workspaces.map((workspace) => workspace.id));
    const statuses = new Map([...state.statuses].filter(([id]) => kept.has(id)));
    update({ ready: true, failed: false, workspaces, activeId, statuses });
  };

  const load = async () => {
    if (!user) return;
    const mine = generation;
    if (state.failed) update({ failed: false });
    try {
      const workspaces = await deps.directory.list();
      if (mine !== generation) return;
      apply(workspaces);
      probeAll();
    } catch {
      if (mine === generation) update({ failed: true });
    }
  };
  /** Re-reads the list after a change, so it shows what was saved. */
  const refresh = async () => {
    const mine = generation;
    const workspaces = await deps.directory.list();
    if (mine === generation) apply(workspaces);
  };

  const setActive = (id: string) => {
    const workspace = state.workspaces.find((candidate) => candidate.id === id);
    if (!workspace) return;
    writeActiveWorkspace({ id: workspace.id, url: workspace.url }, deps.storage);
    deps.navigate("/");
  };

  const syncPolling = () => {
    const wanted = listeners.size > 0 && user !== null;
    if (wanted && !stopPolling) {
      const onVisible = () => {
        if (!deps.isHidden()) probeAll();
      };
      const recheckActive = () => {
        const active = state.workspaces.find((workspace) => workspace.id === state.activeId);
        if (active) probe(active, true);
      };
      const timer = deps.setInterval(onVisible, deps.intervalMs ?? WORKSPACE_PROBE_INTERVAL_MS);
      const stops = [
        deps.listen("focus", onVisible),
        deps.listen("visibilitychange", onVisible),
        deps.listen("recheck", recheckActive),
      ];
      stopPolling = () => {
        deps.clearInterval(timer);
        for (const stop of stops) stop();
      };
    } else if (!wanted && stopPolling) {
      stopPolling();
      stopPolling = null;
    }
  };

  return {
    getState: (): WorkspacesState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      syncPolling();
      return () => {
        listeners.delete(listener);
        syncPolling();
      };
    },
    /** The signed-in account whose list this is; null when signed out or still loading. */
    setUser(id: string | null) {
      if (id === user) return;
      user = id;
      generation++;
      inFlight.clear();
      update({ ready: false, failed: false, workspaces: [], statuses: new Map() });
      syncPolling();
      void load();
    },
    reload: () => void load(),
    recheck(id?: string) {
      if (id === undefined) return probeAll(true);
      const workspace = state.workspaces.find((candidate) => candidate.id === id);
      if (workspace) probe(workspace, true);
    },
    async add(input: { name: string; url: string }): Promise<CloudWorkspace> {
      const first = state.ready && state.workspaces.length === 0;
      const added = await deps.directory.add(input);
      await refresh();
      if (first) setActive(added.id);
      else {
        const saved = state.workspaces.find((workspace) => workspace.id === added.id);
        if (saved) probe(saved, false);
      }
      return added;
    },
    async rename(id: string, name: string) {
      await deps.directory.rename(id, name);
      await refresh();
    },
    async remove(id: string) {
      await deps.directory.remove(id);
      if (state.activeId === id) {
        writeActiveWorkspace(null, deps.storage);
        update({ activeId: null });
      }
      await refresh();
    },
    setActive,
  };
}

function browserStorage(): ActiveWorkspaceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const stores = new WeakMap<CloudAccounts, WorkspacesStore>();

/** The page's one store for this account service, wired to the browser. */
export function workspacesStoreFor(accounts: CloudAccounts): WorkspacesStore {
  let store = stores.get(accounts);
  if (store) return store;
  store = createWorkspacesStore({
    directory: createWorkspaceDirectory({
      read: () => accounts.readDocument(WORKSPACES_DOCUMENT),
      write: (value) => accounts.writeDocument(WORKSPACES_DOCUMENT, value),
    }),
    probe: (url) =>
      probeWorkspace(url, {
        fetch: (input, init) => fetch(input, init),
        getToken: () => accounts.getToken(),
      }),
    storage: browserStorage(),
    initialActive: startupActiveWorkspace(),
    navigate: (url) => window.location.assign(url),
    isHidden: () => document.visibilityState === "hidden",
    listen: (type, listener) => {
      const target = type === "visibilitychange" ? document : window;
      const event = type === "recheck" ? RECHECK_ACTIVE_WORKSPACE_EVENT : type;
      target.addEventListener(event, listener);
      return () => target.removeEventListener(event, listener);
    },
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
  });
  stores.set(accounts, store);
  return store;
}
