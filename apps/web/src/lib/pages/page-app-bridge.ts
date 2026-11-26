import type { AppActionRunResult, AppPermission, AppView } from "@rakazo/contracts";
import {
  APP_QUERIES_MAX,
  APP_STATE_MESSAGE,
  appActionRequest,
  appActionResult,
  appBridgeAllows,
  appQueryAnswer,
  appQueryRequest,
  appStateMessage,
} from "@rakazo/plugin-sdk/bridge";
import type { QueryObserverResult } from "@tanstack/react-query";
import { QueryObserver, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useSave, useSpaceQueries } from "../query/query";
import { errorText } from "../query/user-error";

type Answer = (message: object) => void;

/** One click or key in the frame: whether it is still unused, and how to use it up. */
export type FrameGesture = { fresh: boolean; use: () => void };

/**
 * The host's side of an app's bridge for one open app page. It answers the app's requests for
 * its state, runs the actions the person asks for (one per click or key, only declared ones),
 * answers its read-only queries and keeps them current, and sends the app each newer state. The
 * server checks every action and query again; this only keeps the app's requests to what its
 * manifest declares.
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

/** The surface the bridge decides on, from what the server says about the page's app. */
function bridgeSurface(view: AppView) {
  const functions = new Set(view.functions ?? []);
  const queries = new Set(view.queries ?? []);
  return {
    permissions: view.permissions,
    actions: view.actions.map((name) => ({
      name,
      ...(functions.has(name) ? { server: true } : {}),
      ...(queries.has(name) ? { readOnly: true } : {}),
    })),
  };
}

type Followed = { resend: () => void; refetch: () => void; stop: () => void };

/**
 * The read-only queries one frame follows, each a query the cache keeps: it is read when the
 * frame asks, again after an action this app ran, and whenever the server signals that the app's
 * data changed. Answers go to the frame on the key it asked with.
 */
function useFollowedQueries(pageId: string | null, frame: { current: Answer | null }) {
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const followed = useRef(new Map<string, Followed>());
  useEffect(() => {
    const open = followed.current;
    return () => {
      for (const { stop } of open.values()) stop();
      open.clear();
    };
  }, []);
  return {
    stopAll() {
      for (const { stop } of followed.current.values()) stop();
      followed.current.clear();
    },
    /** Follows one answer; false when the frame already follows as many as it may. */
    follow(key: string, name: string, input: Record<string, unknown>): boolean {
      const known = followed.current.get(key);
      if (known) {
        known.resend();
        return true;
      }
      if (!pageId || followed.current.size >= APP_QUERIES_MAX) return false;
      const observer = new QueryObserver(
        queryClient,
        queries.pages.appQuery.queryOptions({
          input: { pageId, action: name, input: input as never },
        }),
      );
      const send = (result: QueryObserverResult<{ result: unknown }>) =>
        frame.current?.(
          result.status === "success"
            ? appQueryAnswer(key, { status: "ok", data: result.data.result })
            : result.status === "error"
              ? appQueryAnswer(key, { status: "error", error: errorText(result.error) })
              : appQueryAnswer(key, { status: "loading" }),
        );
      const stop = observer.subscribe(send);
      const entry: Followed = {
        resend: () => send(observer.getCurrentResult()),
        refetch: () => void observer.refetch(),
        stop,
      };
      followed.current.set(key, entry);
      entry.resend();
      return true;
    },
    unfollow(key: string) {
      followed.current.get(key)?.stop();
      followed.current.delete(key);
    },
    refetch(key: string) {
      followed.current.get(key)?.refetch();
    },
  };
}

export function usePageAppBridge(
  pageId: string | null,
  view: AppView | null,
): PageAppBridge | undefined {
  const queries = useSpaceQueries();
  // The frame's channel, learned from its first message; a new document sends ready again.
  const frame = useRef<Answer | null>(null);
  const followed = useFollowedQueries(pageId, frame);
  const action = useSave<ActionRequest, AppActionRunResult>({
    save: ({ name, input }, rpc) =>
      rpc.pages.runAction({ pageId: pageId!, action: name, input: input as never }),
    // A function may have changed the app's records, which its queries read.
    stale: [queries.pages.appState.key(), queries.pages.appQuery.key()],
    onSaved: (saved, request) => {
      frame.current?.(appStateMessage(saved.state, saved.revision));
      frame.current?.(appActionResult(request.id, { ok: true, result: saved.result }));
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
  const surface = bridgeSurface(view);
  return {
    permissions: view.permissions,
    receive(data, answer, gesture) {
      if (!data || typeof data !== "object") return false;
      const type = (data as { type?: unknown }).type;
      if (type === READY_MESSAGE) {
        // A new document asks for what it needs again.
        followed.stopAll();
        frame.current = answer;
        answer(appStateMessage(view.state, view.revision));
        return true;
      }
      if (type === APP_STATE_MESSAGE) return true;
      const query = appQueryRequest(data);
      if (query) {
        frame.current = answer;
        if (query.kind !== "query") {
          if (query.kind === "unquery") followed.unfollow(query.key);
          else followed.refetch(query.key);
        } else {
          const refuse = (error: string) =>
            answer(appQueryAnswer(query.key, { status: "error", error }));
          const allowed = appBridgeAllows(surface, {
            by: "person",
            kind: "query",
            action: query.name,
          });
          const input = plainInput(query.input);
          if (!allowed.ok) refuse(allowed.error);
          else if (!input) refuse("The input must be an object.");
          else if (!followed.follow(query.key, query.name, input))
            refuse("This view reads too many answers at once.");
        }
        return true;
      }
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
