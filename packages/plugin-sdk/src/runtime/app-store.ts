import type { AppSurface } from "../manifest/manifest.js";

/**
 * The app's side of the bridge, inside the sandboxed viewer. State arrives from the host and is
 * read-only here: the only way to change it is to ask the host to run a declared action, which
 * it checks, runs, stores and sends back. A read-only action's answer is asked for by key and
 * kept current by the host. Nothing here is trusted by the host.
 */
const ACTION_MESSAGE = "rakazo-app:action";
const RESULT_MESSAGE = "rakazo-app:result";
const STATE_MESSAGE = "rakazo-app:state";
const QUERY_MESSAGE = "rakazo-app:query";
const UNQUERY_MESSAGE = "rakazo-app:unquery";
const REFETCH_MESSAGE = "rakazo-app:refetch";
const ANSWER_MESSAGE = "rakazo-app:answer";
const ANSWER_TIMEOUT_MS = 20_000;

export type ActionResult = { ok: true; result?: unknown } | { ok: false; error: string };
type Snapshot = { state: Record<string, unknown>; revision: number };
/** The card a view was opened to show, and its input; null name for the app's own view. */
export type AppCardView = { name: string | null; input: Record<string, unknown> };
export type QueryState = { data: unknown; error: string | null; loading: boolean };

/** What the viewer prelude (`__rakazoApp`) and the host (`__rakazoAppState`, `__rakazoAppCard`) set. */
const given = globalThis as {
  __rakazoApp?: AppSurface;
  __rakazoAppState?: Snapshot;
  __rakazoAppCard?: unknown;
};

let snapshot: Snapshot | undefined;
const listeners = new Set<() => void>();
const pending = new Map<string, (result: ActionResult) => void>();
let requests = 0;
let listening = false;

type Query = { state: QueryState; listeners: Set<() => void>; name: string; input: unknown };
const queries = new Map<string, Query>();

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

let card: AppCardView | undefined;
/** The card the host opened this view with; read once, it does not change while open. */
export function cardView(): AppCardView {
  if (card) return card;
  const value = given.__rakazoAppCard;
  const name = isObject(value) && typeof value.name === "string" ? value.name : null;
  const declared = name !== null && (surface().cards ?? []).some((entry) => entry.name === name);
  card = {
    name: declared ? name : null,
    input: declared && isObject(value) && isObject(value.input) ? value.input : {},
  };
  return card;
}

const READY_MESSAGE = "rakazo-app:ready";

function post(message: object) {
  window.parent?.postMessage(message, "*");
}

function setQuery(key: string, state: QueryState) {
  const query = queries.get(key);
  if (!query) return;
  query.state = state;
  for (const listener of query.listeners) listener();
}

/**
 * Starts listening and asks the host for the current state, which may be newer than the boot's.
 * Ready goes out before anything else the view sends: the host treats it as a new document and
 * forgets the queries it was following, so a query sent ahead of it would never be answered.
 */
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
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
          ? data.result === undefined
            ? { ok: true }
            : { ok: true, result: data.result }
          : {
              ok: false,
              error: typeof data.error === "string" ? data.error : "The action did not run.",
            },
      );
    } else if (data.type === ANSWER_MESSAGE && typeof data.key === "string") {
      const previous = queries.get(data.key)?.state;
      if (!previous) return;
      if (data.status === "loading") setQuery(data.key, { ...previous, loading: true });
      else if (data.status === "ok")
        setQuery(data.key, { data: data.data, error: null, loading: false });
      else if (data.status === "error")
        setQuery(data.key, {
          data: previous.data,
          error: typeof data.error === "string" ? data.error : "The app could not read its data.",
          loading: false,
        });
    }
  });
  post({ type: READY_MESSAGE });
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
  const { permissions, actions } = surface();
  return (
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-app-actions") &&
    (permissions.includes("state") || actions.some((action) => action.server === true))
  );
}

/** Hosts that answer read-only actions mark the document; a shared link or a phone does not. */
function queriesAvailable(): boolean {
  return (
    typeof document !== "undefined" && document.documentElement.hasAttribute("data-app-queries")
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
    post({ type: ACTION_MESSAGE, id, name, input: input ?? {} });
    setTimeout(() => {
      if (!pending.delete(id)) return;
      resolve({ ok: false, error: "The app did not answer." });
    }, ANSWER_TIMEOUT_MS);
  });
}

/** The key one read-only action and input share, so two views of the same answer share it. */
export function queryKey(name: string, input: unknown): string {
  return JSON.stringify([name, input ?? {}]);
}

/**
 * Where no host answers queries: a shared link, and the phone app, whose viewer shows an app's
 * stored state but runs nothing yet. The app says where its data can be seen instead.
 */
const UNAVAILABLE: QueryState = {
  data: undefined,
  error: "Open this app in Superbot on the web or desktop to see its data.",
  loading: false,
};

function queryProblem(name: string): string | null {
  const action = surface().actions.find((entry) => entry.name === name);
  if (!action) return `This app has no action named ${name}.`;
  if (!action.readOnly) return `${name} is not a read-only action.`;
  return null;
}

/** Follows one query: the host is asked once, by the first view that needs the answer. */
export function subscribeQuery(name: string, input: unknown, listener: () => void) {
  const key = queryKey(name, input);
  if (queryProblem(name) || !queriesAvailable()) return () => undefined;
  listen();
  let query = queries.get(key);
  if (!query) {
    query = {
      state: { data: undefined, error: null, loading: true },
      listeners: new Set(),
      name,
      input,
    };
    queries.set(key, query);
    post({ type: QUERY_MESSAGE, key, name, input: input ?? {} });
  }
  query.listeners.add(listener);
  return () => {
    const held = queries.get(key);
    if (!held) return;
    held.listeners.delete(listener);
    if (held.listeners.size === 0) {
      queries.delete(key);
      post({ type: UNQUERY_MESSAGE, key });
    }
  };
}

const LOADING: QueryState = { data: undefined, error: null, loading: true };
const problems = new Map<string, QueryState>();

export function queryState(name: string, input: unknown): QueryState {
  const problem = queryProblem(name);
  if (problem) {
    // One object per message, so React sees the same answer on every read.
    const known = problems.get(problem) ?? { data: undefined, error: problem, loading: false };
    problems.set(problem, known);
    return known;
  }
  if (!queriesAvailable()) return UNAVAILABLE;
  return queries.get(queryKey(name, input))?.state ?? LOADING;
}

/** Asks the host to read the answer again now. */
export function refetchQuery(name: string, input: unknown) {
  const key = queryKey(name, input);
  if (!queries.has(key)) return;
  post({ type: REFETCH_MESSAGE, key });
}
