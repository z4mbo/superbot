// @vitest-environment jsdom

import type { AppView } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PageAppBridge } from "./page-app-bridge";
import { appAllows, usePageAppBridge } from "./page-app-bridge";

const save = vi.hoisted(() => ({
  run: vi.fn(),
  pending: false,
  options: undefined as { onSaved: (saved: unknown, input: { id: string }) => void } | undefined,
}));

const answers = vi.hoisted(() => ({
  read: vi.fn(async (input: { action: string; input: Record<string, unknown> }) => ({
    result: { action: input.action, input: input.input },
  })),
}));

vi.mock("../query/query", () => ({
  useSpaceQueries: () => ({
    pages: {
      appState: { key: () => ["app"] },
      appQuery: {
        key: () => ["appQuery"],
        queryOptions: ({
          input,
        }: {
          input: { action: string; input: Record<string, unknown> };
        }) => ({
          queryKey: ["appQuery", input],
          queryFn: () => answers.read(input),
          retry: false,
        }),
      },
    },
  }),
  useSave: (options: typeof save.options) => {
    save.options = options;
    return { run: save.run, pending: save.pending, error: null };
  },
}));
vi.mock("../query/user-error", () => ({ errorText: (error: Error) => error.message }));

const view: AppView = {
  name: "Counter",
  permissions: ["state"],
  actions: ["bump"],
  state: { count: 1 },
  revision: 3,
};

let bridge: PageAppBridge | undefined;
function Bridge({ shown }: { shown: AppView | null }) {
  bridge = usePageAppBridge("page-1", shown);
  return null;
}
let client = new QueryClient();
function Host({ shown }: { shown: AppView | null }) {
  return (
    <QueryClientProvider client={client}>
      <Bridge shown={shown} />
    </QueryClientProvider>
  );
}

async function render(shown: AppView | null) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<Host shown={shown} />));
  return root;
}

const fresh = () => ({ fresh: true, use: vi.fn() });
const action = (name: string, input: unknown = {}) => ({
  type: "rakazo-app:action",
  id: "a1",
  name,
  input,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient();
  answers.read.mockClear();
  save.run.mockReset();
  save.pending = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("is absent for a plain page", async () => {
  await render(null);
  expect(bridge).toBeUndefined();
});

it("answers an app's ready with its current state and sends each newer state", async () => {
  const root = await render(view);
  const answer = vi.fn();
  expect(bridge!.receive({ type: "rakazo-app:ready" }, answer, fresh())).toBe(true);
  expect(answer).toHaveBeenLastCalledWith({
    type: "rakazo-app:state",
    state: { count: 1 },
    revision: 3,
  });
  await act(async () =>
    root.render(<Host shown={{ ...view, state: { count: 2 }, revision: 4 }} />),
  );
  expect(answer).toHaveBeenLastCalledWith({
    type: "rakazo-app:state",
    state: { count: 2 },
    revision: 4,
  });
});

it("runs a declared action once for the click that asked, and tells the app", async () => {
  await render(view);
  const answer = vi.fn();
  const gesture = fresh();
  bridge!.receive(action("bump", { by: 1 }), answer, gesture);
  expect(gesture.use).toHaveBeenCalled();
  expect(save.run).toHaveBeenCalledWith({ id: "a1", name: "bump", input: { by: 1 } });
  save.options!.onSaved({ state: { count: 2 }, revision: 4 }, { id: "a1" });
  expect(answer).toHaveBeenCalledWith({ type: "rakazo-app:result", id: "a1", ok: true });
});

it.each([
  ["an undeclared action", action("wipe"), fresh()],
  ["an action named like an object method", action("toString"), fresh()],
  ["an action nobody clicked for", action("bump"), { fresh: false, use: vi.fn() }],
  ["an input that is not an object", action("bump", ["x"]), fresh()],
  ["an input that is text", action("bump", "x"), fresh()],
])("refuses %s without running anything", async (_label, data, gesture) => {
  await render(view);
  const answer = vi.fn();
  expect(bridge!.receive(data, answer, gesture)).toBe(true);
  expect(save.run).not.toHaveBeenCalled();
  expect(gesture.use).not.toHaveBeenCalled();
  expect(answer).toHaveBeenCalledWith(
    expect.objectContaining({ type: "rakazo-app:result", id: "a1", ok: false }),
  );
});

it("refuses every action of an app without the state permission", async () => {
  await render({ ...view, permissions: [] });
  const answer = vi.fn();
  bridge!.receive(action("bump"), answer, fresh());
  expect(save.run).not.toHaveBeenCalled();
});

it("waits for one action to finish before running the next", async () => {
  save.pending = true;
  await render(view);
  const answer = vi.fn();
  bridge!.receive(action("bump"), answer, fresh());
  expect(save.run).not.toHaveBeenCalled();
});

it("leaves page messages to the page host", async () => {
  await render(view);
  expect(bridge!.receive({ type: "rakazo-page:copy", id: "c", text: "x" }, vi.fn(), fresh())).toBe(
    false,
  );
});

it("lets an app reply, open links and copy only when it declares them", async () => {
  await render(view);
  for (const kind of ["reply", "links", "clipboard"] as const) {
    expect(appAllows(bridge, kind)).toBe(false);
    expect(appAllows(undefined, kind)).toBe(true);
  }
  await render({ ...view, permissions: ["state", "links"] });
  expect(appAllows(bridge, "links")).toBe(true);
  expect(appAllows(bridge, "clipboard")).toBe(false);
});

const diary: AppView = {
  name: "Diary",
  permissions: ["data"],
  actions: ["day", "addEntry"],
  functions: ["day", "addEntry"],
  queries: ["day"],
  state: {},
  revision: 0,
};

it("runs a function action without the state permission and hands back its answer", async () => {
  await render(diary);
  const answer = vi.fn();
  bridge!.receive(action("addEntry", { food: "Rice" }), answer, fresh());
  expect(save.run).toHaveBeenCalledWith({ id: "a1", name: "addEntry", input: { food: "Rice" } });
  save.options!.onSaved({ state: {}, revision: 0, result: { saved: true } }, { id: "a1" });
  expect(answer).toHaveBeenLastCalledWith({
    type: "rakazo-app:result",
    id: "a1",
    ok: true,
    result: { saved: true },
  });
});

const query = (name: string, input: unknown = {}) => ({
  type: "rakazo-app:query",
  key: JSON.stringify([name, input]),
  name,
  input,
});

it("answers a read-only query without a click and keeps following it", async () => {
  await render(diary);
  const answer = vi.fn();
  const ask = query("day", { date: "2026-11-26" });
  expect(bridge!.receive({ type: "rakazo-app:ready" }, answer, fresh())).toBe(true);
  await act(async () => {
    bridge!.receive(ask, answer, { fresh: false, use: vi.fn() });
  });
  await vi.waitFor(() =>
    expect(answer).toHaveBeenLastCalledWith({
      type: "rakazo-app:answer",
      key: ask.key,
      status: "ok",
      data: { action: "day", input: { date: "2026-11-26" } },
    }),
  );
  expect(answers.read).toHaveBeenCalledTimes(1);
  // The server's signal (or an action here) marks app queries stale, and the answer is read again.
  await act(() => client.invalidateQueries({ queryKey: ["appQuery"] }));
  await vi.waitFor(() => expect(answers.read).toHaveBeenCalledTimes(2));
  bridge!.receive({ type: "rakazo-app:unquery", key: ask.key }, answer, fresh());
  await act(() => client.invalidateQueries({ queryKey: ["appQuery"] }));
  expect(answers.read).toHaveBeenCalledTimes(2);
});

it.each([
  ["an action that changes data", query("addEntry")],
  ["an undeclared action", query("wipe")],
  ["an input that is not an object", query("day", ["x"])],
])("refuses a query for %s without reading anything", async (_label, ask) => {
  await render(diary);
  const answer = vi.fn();
  expect(bridge!.receive(ask, answer, fresh())).toBe(true);
  expect(answer).toHaveBeenCalledWith(
    expect.objectContaining({ type: "rakazo-app:answer", key: ask.key, status: "error" }),
  );
  expect(answers.read).not.toHaveBeenCalled();
});
