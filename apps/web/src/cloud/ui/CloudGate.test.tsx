// @vitest-environment jsdom

import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryRoot } from "../../lib/query/query-root.test-support";
import type { CloudAccountState } from "../accounts/cloud-accounts";
import { CloudAccountsContext } from "../accounts/cloud-accounts-context";
import type { Workspaces } from "../workspaces/use-workspaces";
import type { WorkspaceStatus } from "../workspaces/workspace-status";
import { fakeAccounts, fakeWorkspaces, signedIn, workspace } from "./cloud-ui.test-support";

vi.mock("@lingui/react/macro", async () => (await import("./cloud-ui.test-support")).linguiMock());
vi.mock("@rakazo/ui-web", async (original) => ({
  ...(await original<object>()),
  ...(await import("./cloud-ui.test-support")).uiWebOverlaysMock(),
}));
const client = vi.hoisted(() => ({}));
vi.mock("../../lib/query/rpc", () => ({
  rpc: client,
  rpcForSpace: () => client,
  createSpaceRpc: () => client,
  selectedSpaceId: () => null,
}));
const hook = vi.hoisted(() => ({ current: null as Workspaces | null }));
vi.mock("../workspaces/use-workspaces", () => ({
  useWorkspaces: () => {
    if (!hook.current) throw new Error("No workspaces in this test");
    return hook.current;
  },
}));

import { CloudGate } from "./CloudGate";

const home = workspace("home", "Home", "https://bots.example.test");
const online: WorkspaceStatus = { state: "online", name: "Home", version: "1.0.0" };

let container: HTMLDivElement;
let root: ReturnType<typeof createQueryRoot>;
let appMounts = 0;

function App() {
  // Counts mounts, so a test can tell the app was kept rather than mounted again.
  useEffect(() => {
    appMounts += 1;
  }, []);
  return <div data-testid="app">app</div>;
}

async function render(account: CloudAccountState, workspaces?: Workspaces) {
  hook.current = workspaces ?? null;
  await act(async () => {
    root.render(
      <CloudAccountsContext.Provider value={fakeAccounts(account)}>
        <CloudGate>
          <App />
        </CloudGate>
      </CloudAccountsContext.Provider>,
    );
  });
}

function shown() {
  if (container.querySelector("[data-testid='app']")) return "app";
  if (container.querySelector("[data-testid='cloud-sign-in']")) return "sign-in";
  if (container.querySelector("[data-testid='cloud-workspaces-page']")) return "workspaces";
  if (container.querySelector("[data-testid='cloud-workspace-unavailable']")) return "unavailable";
  if (container.querySelector("[data-testid='cloud-workspaces-failed']")) return "failed";
  return "loading";
}

function buttonNamed(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing ${label}`);
  return match;
}

function activeHome(status: WorkspaceStatus) {
  return fakeWorkspaces({ workspaces: [home], activeId: "home", statuses: { home: status } });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createQueryRoot(container);
  appMounts = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("CloudGate", () => {
  it("waits while the account is loading", async () => {
    hook.current = null;
    await act(async () => {
      root.render(
        <CloudAccountsContext.Provider value={fakeAccounts({ status: "loading" })}>
          <CloudGate>
            <App />
          </CloudGate>
        </CloudAccountsContext.Provider>,
      );
    });
    expect(shown()).toBe("loading");
  });

  it("asks a signed-out person to sign in", async () => {
    await render({ status: "signed-out" });
    await vi.waitFor(() => expect(shown()).toBe("sign-in"));
    expect(container.querySelector("[data-testid='account-sign-in']")).not.toBeNull();
  });

  it("shows the workspace list when none is chosen", async () => {
    await render(signedIn, fakeWorkspaces({ workspaces: [home], activeId: null }));
    await vi.waitFor(() => expect(shown()).toBe("workspaces"));
  });

  it("shows the workspace list when the chosen one is no longer listed", async () => {
    await render(signedIn, fakeWorkspaces({ workspaces: [home], activeId: "gone" }));
    await vi.waitFor(() => expect(shown()).toBe("workspaces"));
  });

  it("offers to try again when the list cannot be read", async () => {
    const workspaces = fakeWorkspaces({ ready: false, failed: true });
    await render(signedIn, workspaces);
    expect(shown()).toBe("failed");
    await act(async () => buttonNamed("Try again").click());
    expect(workspaces.reload).toHaveBeenCalled();
  });

  it("waits for the first check of the chosen workspace", async () => {
    await render(signedIn, activeHome({ state: "checking" }));
    expect(shown()).toBe("loading");
  });

  it("shows the app when the chosen workspace is online", async () => {
    await render(signedIn, activeHome(online));
    expect(shown()).toBe("app");
  });

  it("explains an offline workspace and checks it again on request", async () => {
    const workspaces = activeHome({ state: "offline" });
    await render(signedIn, workspaces);
    await vi.waitFor(() => expect(shown()).toBe("unavailable"));
    expect(container.textContent).toContain("Home is offline");
    await act(async () => buttonNamed("Try again").click());
    expect(workspaces.recheck).toHaveBeenCalledWith("home");
  });

  it("titles each state that cannot be used", async () => {
    const titles: [WorkspaceStatus, string][] = [
      [{ state: "not-enabled" }, "Home isn't set up for Superbot Cloud"],
      [{ state: "unauthorized", reason: "token_invalid" }, "No access to Home"],
      [{ state: "incompatible", version: "0.1.0" }, "Home needs an update"],
    ];
    for (const [status, title] of titles) {
      await render(signedIn, activeHome(status));
      await vi.waitFor(() => expect(container.querySelector("h1")?.textContent).toBe(title));
    }
  });

  it("shows the app by itself once an offline workspace comes back", async () => {
    await render(signedIn, activeHome({ state: "offline" }));
    await vi.waitFor(() => expect(shown()).toBe("unavailable"));
    await render(signedIn, activeHome(online));
    expect(shown()).toBe("app");
  });

  it("keeps the unavailable page while a new check is on its way", async () => {
    await render(signedIn, activeHome({ state: "offline" }));
    await vi.waitFor(() => expect(shown()).toBe("unavailable"));
    await render(signedIn, activeHome({ state: "checking" }));
    expect(shown()).toBe("unavailable");
    expect(buttonNamed("Try again").disabled).toBe(true);
  });

  it("keeps the app mounted through a recheck and replaces it when the server goes away", async () => {
    await render(signedIn, activeHome(online));
    expect(shown()).toBe("app");
    await render(signedIn, activeHome({ state: "checking" }));
    expect(shown()).toBe("app");
    expect(appMounts).toBe(1);
    await render(signedIn, activeHome({ state: "offline" }));
    await vi.waitFor(() => expect(shown()).toBe("unavailable"));
    await render(signedIn, activeHome(online));
    expect(shown()).toBe("app");
  });

  it("lets a person leave an unavailable workspace for the list and come back", async () => {
    await render(signedIn, activeHome({ state: "offline" }));
    await vi.waitFor(() => expect(shown()).toBe("unavailable"));
    await act(async () => buttonNamed("Workspaces").click());
    await vi.waitFor(() => expect(shown()).toBe("workspaces"));
    await act(async () => buttonNamed("Back").click());
    expect(shown()).toBe("unavailable");
  });
});
