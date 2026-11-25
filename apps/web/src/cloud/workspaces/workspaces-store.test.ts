import { deferred, flush } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_WORKSPACE_KEY } from "./active-workspace.js";
import type { CloudWorkspace, WorkspaceDirectory } from "./workspace-directory.js";
import { createWorkspaceDirectory } from "./workspace-directory.js";
import type { WorkspaceStatus } from "./workspace-status.js";
import type { WorkspacesStoreDeps } from "./workspaces-store.js";
import { createWorkspacesStore, WORKSPACE_PROBE_INTERVAL_MS } from "./workspaces-store.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

function memoryDirectory(initial: CloudWorkspace[] = []) {
  const document = { value: initial as unknown };
  let next = 0;
  const directory = createWorkspaceDirectory(
    {
      read: async () => structuredClone(document.value),
      write: async (value) => {
        document.value = structuredClone(value);
      },
    },
    { newId: () => `added-${++next}`, now: () => new Date("2026-11-25T00:00:00.000Z") },
  );
  return { document, directory };
}

const home: CloudWorkspace = {
  id: "home",
  name: "Home",
  url: "https://home.example",
  kind: "self-hosted",
  addedAt: "2026-11-01T00:00:00.000Z",
};
const work: CloudWorkspace = { ...home, id: "work", name: "Work", url: "https://work.example" };
const ONLINE: WorkspaceStatus = { state: "online", name: "Home", version: "1" };

type Harness = ReturnType<typeof harness>;

function harness(
  options: {
    workspaces?: CloudWorkspace[];
    directory?: WorkspaceDirectory;
    active?: { id: string; url: string } | null;
    probe?: WorkspacesStoreDeps["probe"];
  } = {},
) {
  const memory = memoryDirectory(options.workspaces ?? [home, work]);
  const storage = memoryStorage(
    options.active ? { [ACTIVE_WORKSPACE_KEY]: JSON.stringify(options.active) } : {},
  );
  const listeners = new Map<string, Set<() => void>>();
  let hidden = false;
  const probe = vi.fn(options.probe ?? (async () => ONLINE));
  const navigate = vi.fn();
  const store = createWorkspacesStore({
    directory: options.directory ?? memory.directory,
    probe,
    storage,
    initialActive: options.active ?? null,
    navigate,
    isHidden: () => hidden,
    listen: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
      return () => set.delete(listener);
    },
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  });
  return {
    store,
    probe,
    navigate,
    storage,
    memory,
    fire: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    hide: (value: boolean) => {
      hidden = value;
    },
  };
}

async function signedIn(h: Harness) {
  const unsubscribe = h.store.subscribe(() => {});
  h.store.setUser("user-1");
  // The list and the first probes settle on promises alone, which drain before a due timer.
  await flush();
  expect(h.store.getState().ready).toBe(true);
  return unsubscribe;
}

beforeEach(() => {
  // Only the poller's interval is faked, so `flush()` still waits on a real timer.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("workspaces store", () => {
  it("loads nothing until someone is signed in, then probes every workspace", async () => {
    const h = harness();
    h.store.subscribe(() => {});
    await flush();
    expect(h.store.getState().ready).toBe(false);
    expect(h.probe).not.toHaveBeenCalled();

    await signedIn(h);
    expect(h.store.getState().workspaces.map((w) => w.id)).toEqual(["home", "work"]);
    expect(h.probe.mock.calls.map(([url]) => url)).toEqual([home.url, work.url]);
    expect(h.store.getState().statuses.get("home")).toEqual(ONLINE);
  });

  it("probes every 15 seconds while visible, and only while subscribed", async () => {
    const h = harness();
    const unsubscribe = await signedIn(h);
    h.probe.mockClear();

    await vi.advanceTimersByTimeAsync(WORKSPACE_PROBE_INTERVAL_MS - 1);
    expect(h.probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.probe).toHaveBeenCalledTimes(2);

    h.hide(true);
    await vi.advanceTimersByTimeAsync(WORKSPACE_PROBE_INTERVAL_MS);
    expect(h.probe).toHaveBeenCalledTimes(2);
    h.hide(false);
    h.fire("visibilitychange");
    await flush();
    expect(h.probe).toHaveBeenCalledTimes(4);

    unsubscribe();
    expect(h.listenerCount("focus")).toBe(0);
    await vi.advanceTimersByTimeAsync(WORKSPACE_PROBE_INTERVAL_MS * 3);
    expect(h.probe).toHaveBeenCalledTimes(4);
  });

  it("keeps one poller however many screens subscribe", async () => {
    const h = harness();
    const first = await signedIn(h);
    const second = h.store.subscribe(() => {});
    expect(h.listenerCount("focus")).toBe(1);
    h.probe.mockClear();
    await vi.advanceTimersByTimeAsync(WORKSPACE_PROBE_INTERVAL_MS);
    expect(h.probe).toHaveBeenCalledTimes(2);
    first();
    expect(h.listenerCount("focus")).toBe(1);
    second();
    expect(h.listenerCount("focus")).toBe(0);
  });

  it("rechecks on focus", async () => {
    const h = harness();
    await signedIn(h);
    h.probe.mockClear();
    h.fire("focus");
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it("never runs two probes of one workspace at once", async () => {
    const answer = deferred<WorkspaceStatus>();
    const h = harness({ workspaces: [home], probe: () => answer.promise });
    await signedIn(h);
    expect(h.probe).toHaveBeenCalledTimes(1);

    h.fire("focus");
    h.store.recheck("home");
    await vi.advanceTimersByTimeAsync(WORKSPACE_PROBE_INTERVAL_MS);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.store.getState().statuses.get("home")).toBeUndefined();

    answer.resolve(ONLINE);
    await flush();
    expect(h.store.getState().statuses.get("home")).toEqual(ONLINE);
    h.fire("focus");
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it("shows checking again on an explicit recheck, and offline when a probe throws", async () => {
    let fail = false;
    const h = harness({
      workspaces: [home],
      probe: async () => {
        if (fail) throw new Error("boom");
        return ONLINE;
      },
    });
    await signedIn(h);
    fail = true;
    h.store.recheck();
    expect(h.store.getState().statuses.get("home")).toEqual({ state: "checking" });
    await flush();
    expect(h.store.getState().statuses.get("home")).toEqual({ state: "offline" });
  });

  it("ignores a late answer for a workspace removed meanwhile", async () => {
    const answer = deferred<WorkspaceStatus>();
    const h = harness({
      probe: (url) => (url === home.url ? answer.promise : Promise.resolve(ONLINE)),
    });
    await signedIn(h);
    await h.store.remove("home");
    answer.resolve(ONLINE);
    await flush();
    expect(h.store.getState().statuses.has("home")).toBe(false);
    expect(h.store.getState().workspaces.map((w) => w.id)).toEqual(["work"]);
  });

  it("clears the active workspace when it is no longer in the list", async () => {
    const h = harness({ workspaces: [work], active: { id: "home", url: home.url } });
    expect(h.store.getState().activeId).toBe("home");
    await signedIn(h);
    expect(h.store.getState().activeId).toBeNull();
    expect(h.storage.items.has(ACTIVE_WORKSPACE_KEY)).toBe(false);
  });

  it("keeps an active workspace that is still listed", async () => {
    const h = harness({ active: { id: "work", url: work.url } });
    await signedIn(h);
    expect(h.store.getState().activeId).toBe("work");
    expect(h.storage.items.has(ACTIVE_WORKSPACE_KEY)).toBe(true);
  });

  it("removing the active workspace leaves none active, without reloading", async () => {
    const h = harness({ active: { id: "home", url: home.url } });
    await signedIn(h);
    await h.store.remove("home");
    expect(h.store.getState().activeId).toBeNull();
    expect(h.storage.items.has(ACTIVE_WORKSPACE_KEY)).toBe(false);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("makes the first workspace added the active one and reloads onto it", async () => {
    const h = harness({ workspaces: [] });
    await signedIn(h);
    const added = await h.store.add({ name: "Home", url: "home.example" });
    expect(added.url).toBe("https://home.example");
    expect(JSON.parse(h.storage.items.get(ACTIVE_WORKSPACE_KEY)!)).toEqual({
      id: added.id,
      url: "https://home.example",
    });
    expect(h.navigate).toHaveBeenCalledWith("/");
  });

  it("probes a later workspace right after it is added, without switching to it", async () => {
    const h = harness({ workspaces: [home], active: { id: "home", url: home.url } });
    await signedIn(h);
    h.probe.mockClear();
    const added = await h.store.add({ name: "Work", url: "https://work.example" });
    expect(h.probe).toHaveBeenCalledWith("https://work.example");
    expect(h.store.getState().workspaces.map((w) => w.id)).toEqual(["home", added.id]);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.store.getState().activeId).toBe("home");
  });

  it("passes a refused address on to the caller", async () => {
    const h = harness();
    await signedIn(h);
    await expect(h.store.add({ name: "Dup", url: home.url })).rejects.toMatchObject({
      problem: "duplicate",
    });
  });

  it("renames through the directory and shows the saved name", async () => {
    const h = harness();
    await signedIn(h);
    await h.store.rename("work", "  Office ");
    expect(h.store.getState().workspaces.find((w) => w.id === "work")?.name).toBe("Office");
  });

  it("switches by saving the choice and loading a fresh page", async () => {
    const h = harness();
    await signedIn(h);
    h.store.setActive("work");
    expect(JSON.parse(h.storage.items.get(ACTIVE_WORKSPACE_KEY)!)).toEqual({
      id: "work",
      url: work.url,
    });
    expect(h.navigate).toHaveBeenCalledWith("/");
    h.navigate.mockClear();
    h.store.setActive("unknown");
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("reports a list that cannot be read, and reads it again on reload", async () => {
    const { directory } = memoryDirectory([home]);
    let fail = true;
    const flaky: WorkspaceDirectory = {
      ...directory,
      list: () => (fail ? Promise.reject(new Error("offline")) : directory.list()),
    };
    const h = harness({ directory: flaky });
    h.store.subscribe(() => {});
    h.store.setUser("user-1");
    await flush();
    expect(h.store.getState().failed).toBe(true);
    expect(h.store.getState().ready).toBe(false);

    fail = false;
    h.store.reload();
    await flush();
    expect(h.store.getState().ready).toBe(true);
    expect(h.store.getState().failed).toBe(false);
  });

  it("forgets the list on sign-out and drops answers meant for the previous account", async () => {
    const answer = deferred<WorkspaceStatus>();
    const h = harness({ workspaces: [home], probe: () => answer.promise });
    await signedIn(h);
    h.store.setUser(null);
    expect(h.store.getState()).toMatchObject({ ready: false, workspaces: [] });
    expect(h.listenerCount("focus")).toBe(0);
    answer.resolve(ONLINE);
    await flush();
    expect(h.store.getState().statuses.size).toBe(0);
  });

  it("probes the active workspace when asked to after a refused request", async () => {
    const h = harness({ active: { id: "work", url: work.url } });
    await signedIn(h);
    h.probe.mockClear();
    h.fire("recheck");
    expect(h.probe.mock.calls.map(([url]) => url)).toEqual([work.url]);
    expect(h.store.getState().statuses.get("work")).toEqual({ state: "checking" });
  });
});
