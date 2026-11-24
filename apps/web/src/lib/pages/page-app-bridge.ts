import type { AppPermission, AppView } from "@rakazo/contracts";
import {
  APP_STATE_MESSAGE,
  appActionRequest,
  appActionResult,
  appBridgeAllows,
  appStateMessage,
} from "@rakazo/plugin-sdk/bridge";
import { useEffect, useRef } from "react";
import { useSave, useSpaceQueries } from "../query/query";
import { errorText } from "../query/user-error";

type Answer = (message: object) => void;

/** One click or key in the frame: whether it is still unused, and how to use it up. */
export type FrameGesture = { fresh: boolean; use: () => void };

/**
 * The host's side of an app's bridge for one open app page. It answers the app's requests for
 * its state, runs the actions the person asks for (one per click or key, only declared ones),
 * and sends the app each newer state. The server checks every action again; this only keeps
 * the app's requests to what its manifest declares.
 */
export type PageAppBridge = {
  permissions: readonly AppPermission[];
  /** True when `data` was one of the app's messages, handled here. */
  receive: (data: unknown, answer: Answer, gesture: FrameGesture) => boolean;
};

type ActionRequest = { id: string; name: string; input: Record<string, unknown> };

const READY_MESSAGE = "rakazo-app:ready";

function plainInput(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {};
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function usePageAppBridge(
  pageId: string | null,
  view: AppView | null,
): PageAppBridge | undefined {
  const queries = useSpaceQueries();
  // The frame's channel, learned from its first message; a new document sends ready again.
  const frame = useRef<Answer | null>(null);
  const action = useSave<ActionRequest, { state: Record<string, unknown>; revision: number }>({
    save: ({ name, input }, rpc) =>
      rpc.pages.runAction({ pageId: pageId!, action: name, input: input as never }),
    stale: [queries.pages.appState.key()],
    onSaved: (saved, request) => {
      frame.current?.(appStateMessage(saved.state, saved.revision));
      frame.current?.(appActionResult(request.id, { ok: true }));
    },
    onFailed: (error, request) =>
      frame.current?.(appActionResult(request.id, { ok: false, error: errorText(error) })),
  });
  const revision = view?.revision;
  const latest = useRef(view);
  latest.current = view;
  useEffect(() => {
    const shown = latest.current;
    if (shown && revision !== undefined) frame.current?.(appStateMessage(shown.state, revision));
  }, [revision]);
  if (!pageId || !view) return undefined;
  const surface = {
    permissions: view.permissions,
    actions: view.actions.map((name) => ({ name })),
  };
  return {
    permissions: view.permissions,
    receive(data, answer, gesture) {
      if (!data || typeof data !== "object") return false;
      const type = (data as { type?: unknown }).type;
      if (type === READY_MESSAGE) {
        frame.current = answer;
        answer(appStateMessage(view.state, view.revision));
        return true;
      }
      if (type === APP_STATE_MESSAGE) return true;
      const request = appActionRequest(data);
      if (!request) return false;
      frame.current = answer;
      const refuse = (error: string) => answer(appActionResult(request.id, { ok: false, error }));
      const allowed = appBridgeAllows(surface, {
        by: "person",
        kind: "action",
        action: request.name,
      });
      if (!allowed.ok) refuse(allowed.error);
      else if (!gesture.fresh) refuse("Actions run from the app's own buttons.");
      else if (action.pending) refuse("The last action is still running.");
      else {
        const input = plainInput(request.input);
        if (!input) refuse("The input must be an object.");
        else {
          gesture.use();
          action.run({ id: request.id, name: request.name, input });
        }
      }
      return true;
    },
  };
}

/** Whether an app page may ask for a reply, a link or a copy; plain pages always may. */
export function appAllows(
  bridge: PageAppBridge | undefined,
  kind: "reply" | "links" | "clipboard",
): boolean {
  return (
    !bridge ||
    appBridgeAllows({ permissions: bridge.permissions, actions: [] }, { by: "person", kind }).ok
  );
}
