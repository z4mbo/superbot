// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudAccounts } from "../accounts/cloud-accounts.js";
import { CloudAccountsContext } from "../accounts/cloud-accounts-context.js";
import type { Workspaces } from "./use-workspaces.js";
import { useWorkspaces } from "./use-workspaces.js";

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Every probe finds nothing at the address.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fakeAccounts(): CloudAccounts {
  const documents = new Map<string, unknown>([
    [
      "workspaces",
      [
        {
          id: "home",
          name: "Home",
          url: "https://home.example",
          kind: "self-hosted",
          addedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    ],
  ]);
  return {
    issuer: "https://accounts.example",
    Provider: ({ children }) => children,
    SignIn: () => null,
    useAccount: () => ({
      status: "signed-in",
      user: { id: "user-1", email: null, name: null, imageUrl: null },
    }),
    getToken: async () => "token",
    signOut: async () => {},
    readDocument: async (key) => documents.get(key) ?? null,
    writeDocument: async (key, value) => void documents.set(key, value),
  };
}

it("shares one list and one poller between every screen that shows it", async () => {
  const add = vi.spyOn(window, "addEventListener");
  const seen: Workspaces[][] = [[], []];
  function Screen({ index }: { index: number }) {
    seen[index]!.push(useWorkspaces());
    return null;
  }
  const accounts = fakeAccounts();
  await act(async () => {
    root.render(
      <CloudAccountsContext.Provider value={accounts}>
        <Screen index={0} />
        <Screen index={1} />
      </CloudAccountsContext.Provider>,
    );
    await flush();
  });

  const [first, second] = [seen[0]!.at(-1)!, seen[1]!.at(-1)!];
  expect(first.ready).toBe(true);
  expect(first.workspaces.map((workspace) => workspace.id)).toEqual(["home"]);
  expect(second.workspaces).toBe(first.workspaces);
  expect(first.status("home")).toEqual({ state: "offline" });
  expect(first.status("unknown")).toEqual({ state: "checking" });
  expect(add.mock.calls.filter(([type]) => type === "focus")).toHaveLength(1);
});
