import type { AppPermission } from "@rakazo/contracts";
import { findAction, isQueryAction } from "../manifest/manifest.js";

/**
 * The bridge between an app and the product. Every request names who is asking and what for,
 * and `appBridgeAllows` is the one place that says yes or no, for the viewer host and for the
 * server alike: an app reaches only what its manifest declares, and a bot reaches an app only
 * through the `agent:*` permissions.
 */
export type AppBridgeRequest =
  /** A person used one of the app's controls; the app asks to run a declared action. */
  | { by: "person"; kind: "action"; action: string }
  /** The app's view asks for a read-only action's answer; it needs no click. */
  | { by: "person"; kind: "query"; action: string }
  /** The app asks to put text in the chat composer, open a link, or copy text. */
  | { by: "person"; kind: "reply" | "links" | "clipboard" }
  /** A bot reads the app's state. */
  | { by: "agent"; kind: "read" }
  /** A bot runs a declared action; a read-only one needs only `agent:read`. */
  | { by: "agent"; kind: "action"; action: string };

export type BridgeDecision = { ok: true } | { ok: false; error: string };

const REFUSED: Record<string, string> = {
  state: "This app keeps no state.",
  "agent:read": "This app does not let bots read its state.",
  "agent:actions": "This app does not let bots run its actions.",
  reply: "This app cannot write in the chat.",
  links: "This app cannot open links.",
  clipboard: "This app cannot copy text.",
};

/**
 * What the bridge decides on: the declared permissions and actions. An action that names a
 * server function (`run`, or `server` as the viewer is told) needs no state; one with effects does.
 */
export type AppBridgeSurface = {
  permissions: readonly AppPermission[];
  actions: readonly { name: string; run?: unknown; server?: unknown; readOnly?: unknown }[];
};

function needs(manifest: Pick<AppBridgeSurface, "permissions">, ...permissions: AppPermission[]) {
  const missing = permissions.find((permission) => !manifest.permissions.includes(permission));
  return missing ? { ok: false as const, error: REFUSED[missing]! } : { ok: true as const };
}

const runsFunction = (action: { run?: unknown; server?: unknown }) =>
  action.run !== undefined || action.server === true;

export function appBridgeAllows(
  manifest: AppBridgeSurface,
  request: AppBridgeRequest,
): BridgeDecision {
  if (request.by === "agent" && request.kind === "read") return needs(manifest, "agent:read");
  if (request.kind === "action" || request.kind === "query") {
    const action = findAction(manifest, request.action);
    if (!action)
      return { ok: false, error: `This app has no action named ${String(request.action)}.` };
    if (request.kind === "query")
      return isQueryAction(action)
        ? { ok: true }
        : { ok: false, error: `${action.name} is not a read-only action.` };
    if (request.by === "agent") {
      const allowed = needs(manifest, isQueryAction(action) ? "agent:read" : "agent:actions");
      if (!allowed.ok) return allowed;
    }
    return runsFunction(action) ? { ok: true } : needs(manifest, "state");
  }
  return needs(manifest, request.kind);
}

/** Messages an app's viewer sends up to the host, and the host's answers back down. */
export const APP_ACTION_MESSAGE = "rakazo-app:action";
export const APP_RESULT_MESSAGE = "rakazo-app:result";
export const APP_STATE_MESSAGE = "rakazo-app:state";
export const APP_REQUEST_ID_MAX_LENGTH = 64;
export const APP_ACTION_NAME_MAX_LENGTH = 64;

export type AppActionMessage = { id: string; name: string; input: unknown };

/** An action request the viewer sent, or null when it is not one; the input is checked later. */
export function appActionRequest(data: unknown): AppActionMessage | null {
  if (!data || typeof data !== "object") return null;
  const { type, id, name, input } = data as Record<string, unknown>;
  if (type !== APP_ACTION_MESSAGE || typeof id !== "string" || typeof name !== "string")
    return null;
  if (id.length === 0 || id.length > APP_REQUEST_ID_MAX_LENGTH) return null;
  if (name.length === 0 || name.length > APP_ACTION_NAME_MAX_LENGTH) return null;
  return { id, name, input };
}

/** What a function-backed action answered, passed back to the view that ran it. */
export function appActionResult(
  id: string,
  outcome: { ok: true; result?: unknown } | { ok: false; error: string },
) {
  if (!outcome.ok)
    return { type: APP_RESULT_MESSAGE, id, ok: false, error: outcome.error.slice(0, 300) };
  return outcome.result === undefined
    ? { type: APP_RESULT_MESSAGE, id, ok: true }
    : { type: APP_RESULT_MESSAGE, id, ok: true, result: outcome.result };
}

export function appStateMessage(state: Record<string, unknown>, revision: number) {
  return { type: APP_STATE_MESSAGE, state, revision };
}

/**
 * A view's read-only queries: it asks for an answer by key, the host keeps it current (after
 * every action that ran and whenever the server signals the app's data changed) and answers on
 * the same key, until the view lets the key go.
 */
export const APP_QUERY_MESSAGE = "rakazo-app:query";
export const APP_UNQUERY_MESSAGE = "rakazo-app:unquery";
export const APP_REFETCH_MESSAGE = "rakazo-app:refetch";
export const APP_ANSWER_MESSAGE = "rakazo-app:answer";
export const APP_QUERY_KEY_MAX_LENGTH = 2048;
/** Queries one open view may keep at once. */
export const APP_QUERIES_MAX = 16;

export type AppQueryMessage =
  | { kind: "query"; key: string; name: string; input: unknown }
  | { kind: "unquery" | "refetch"; key: string };

/** A query message the view sent, or null when it is not one; the input is checked later. */
export function appQueryRequest(data: unknown): AppQueryMessage | null {
  if (!data || typeof data !== "object") return null;
  const { type, key, name, input } = data as Record<string, unknown>;
  if (typeof key !== "string" || key.length === 0 || key.length > APP_QUERY_KEY_MAX_LENGTH)
    return null;
  if (type === APP_UNQUERY_MESSAGE) return { kind: "unquery", key };
  if (type === APP_REFETCH_MESSAGE) return { kind: "refetch", key };
  if (type !== APP_QUERY_MESSAGE || typeof name !== "string") return null;
  if (name.length === 0 || name.length > APP_ACTION_NAME_MAX_LENGTH) return null;
  return { kind: "query", key, name, input };
}

export function appQueryAnswer(
  key: string,
  answer:
    | { status: "loading" }
    | { status: "ok"; data: unknown }
    | { status: "error"; error: string },
) {
  return answer.status === "error"
    ? { type: APP_ANSWER_MESSAGE, key, status: "error", error: answer.error.slice(0, 300) }
    : { type: APP_ANSWER_MESSAGE, key, ...answer };
}
