import type { AppSurface } from "../manifest/manifest.js";

/**
 * The app's side of the bridge, inside the sandboxed viewer. State arrives from the host and is
 * read-only here: the only way to change it is to ask the host to run a declared action, which
 * it checks, runs, stores and sends back. Nothing here is trusted by the host.
 */
const ACTION_MESSAGE = "rakazo-app:action";
const RESULT_MESSAGE = "rakazo-app:result";
const STATE_MESSAGE = "rakazo-app:state";
const ANSWER_TIMEOUT_MS = 20_000;

export type ActionResult = { ok: true } | { ok: false; error: string };
type Snapshot = { state: Record<string, unknown>; revision: number };

/** What the viewer prelude (`__rakazoApp`) and the host (`__rakazoAppState`) set. */
const given = globalThis as { __rakazoApp?: AppSurface; __rakazoAppState?: Snapshot };

let snapshot: Snapshot | undefined;
const listeners = new Set<() => void>();
const pending = new Map<string, (result: ActionResult) => void>();
let requests = 0;
let listening = false;

export function surface(): AppSurface {
  return given.__rakazoApp ?? { permissions: [], actions: [], initialState: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function current(): Snapshot {
  if (snapshot) return snapshot;
  const stored = given.__rakazoAppState;
  snapshot =
    stored && isObject(stored.state) && typeof stored.revision === "number"
      ? { state: stored.state, revision: stored.revision }
      : { state: surface().initialState, revision: -1 };
  return snapshot;
}

const READY_MESSAGE = "rakazo-app:ready";

/** Starts listening and asks the host for the current state, which may be newer than the boot's. */
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  queueMicrotask(() => window.parent?.postMessage({ type: READY_MESSAGE }, "*"));
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;
    if (data.type === STATE_MESSAGE && isObject(data.state) && typeof data.revision === "number") {
      // A late answer never rolls the state back.
      if (data.revision <= current().revision) return;
      snapshot = { state: data.state, revision: data.revision };
      for (const listener of listeners) listener();
    } else if (data.type === RESULT_MESSAGE && typeof data.id === "string") {
      const settle = pending.get(data.id);
      pending.delete(data.id);
      settle?.(
        data.ok === true
          ? { ok: true }
          : {
              ok: false,
              error: typeof data.error === "string" ? data.error : "The action did not run.",
            },
      );
    }
  });
}

export function subscribe(listener: () => void) {
  listen();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState(): Record<string, unknown> {
  return current().state;
}

/** Only hosts that can run actions mark the document; elsewhere the app shows its state only. */
export function actionsAvailable(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-app-actions") &&
    surface().permissions.includes("state")
  );
}

export function declared(name: string): boolean {
  return surface().actions.some((action) => action.name === name);
}

/**
 * Asks the host to run an action. Call it straight from a click or key: the host runs one action
 * per thing the person did, and refuses requests the page makes on its own.
 */
export function runAction(name: string, input?: Record<string, unknown>): Promise<ActionResult> {
  if (!declared(name))
    return Promise.resolve({ ok: false, error: `This app has no action named ${name}.` });
  if (!actionsAvailable()) return Promise.resolve({ ok: false, error: "Actions can't run here." });
  listen();
  requests += 1;
  const id = `a${requests}`;
  return new Promise<ActionResult>((resolve) => {
    pending.set(id, resolve);
    window.parent?.postMessage({ type: ACTION_MESSAGE, id, name, input: input ?? {} }, "*");
    setTimeout(() => {
      if (!pending.delete(id)) return;
      resolve({ ok: false, error: "The app did not answer." });
    }, ANSWER_TIMEOUT_MS);
  });
}
