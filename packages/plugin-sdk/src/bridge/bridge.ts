import type { AppManifest, AppPermission } from "@rakazo/contracts";
import { findAction } from "../manifest/manifest.js";

/**
 * The bridge between an app and the product. Every request names who is asking and what for,
 * and `appBridgeAllows` is the one place that says yes or no, for the viewer host and for the
 * server alike: an app reaches only what its manifest declares, and a bot reaches an app only
 * through the `agent:*` permissions.
 */
export type AppBridgeRequest =
  /** A person used one of the app's controls; the app asks to run a declared action. */
  | { by: "person"; kind: "action"; action: string }
  /** The app asks to put text in the chat composer, open a link, or copy text. */
  | { by: "person"; kind: "reply" | "links" | "clipboard" }
  /** A bot reads the app's state. */
  | { by: "agent"; kind: "read" }
  /** A bot runs a declared action. */
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

function needs(manifest: Pick<AppManifest, "permissions">, ...permissions: AppPermission[]) {
  const missing = permissions.find((permission) => !manifest.permissions.includes(permission));
  return missing ? { ok: false as const, error: REFUSED[missing]! } : { ok: true as const };
}

export function appBridgeAllows(
  manifest: Pick<AppManifest, "permissions" | "actions">,
  request: AppBridgeRequest,
): BridgeDecision {
  if (request.by === "agent" && request.kind === "read")
    return needs(manifest, "state", "agent:read");
  if (request.kind === "action") {
    const allowed =
      request.by === "agent" ? needs(manifest, "state", "agent:actions") : needs(manifest, "state");
    if (!allowed.ok) return allowed;
    return findAction(manifest, request.action)
      ? { ok: true }
      : { ok: false, error: `This app has no action named ${String(request.action)}.` };
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

export function appActionResult(id: string, outcome: { ok: true } | { ok: false; error: string }) {
  return outcome.ok
    ? { type: APP_RESULT_MESSAGE, id, ok: true }
    : { type: APP_RESULT_MESSAGE, id, ok: false, error: outcome.error.slice(0, 300) };
}

export function appStateMessage(state: Record<string, unknown>, revision: number) {
  return { type: APP_STATE_MESSAGE, state, revision };
}
