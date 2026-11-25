// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryRoot } from "../../lib/query/query-root.test-support";
import { CloudAccountsContext } from "../accounts/cloud-accounts-context";
import type { Workspaces } from "../workspaces/use-workspaces";
import type { CloudWorkspace, WorkspaceUrlProblem } from "../workspaces/workspace-directory";
import { WorkspaceUrlError } from "../workspaces/workspace-directory";
import { fakeAccounts, fakeWorkspaces, ISSUER, signedIn, workspace } from "./cloud-ui.test-support";

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

import { toast } from "@rakazo/ui-web";
import { CloudWorkspaceList } from "./CloudWorkspaceList";

const home = workspace("home", "Home", "https://bots.example.test");
const lab = workspace("lab", "Lab", "http://localhost:3000");

let container: HTMLDivElement;
let root: ReturnType<typeof createQueryRoot>;

async function render(workspaces: Workspaces) {
  await act(async () => {
    root.render(
      <CloudAccountsContext.Provider value={fakeAccounts(signedIn)}>
        <CloudWorkspaceList workspaces={workspaces} />
      </CloudAccountsContext.Provider>,
    );
  });
}

function buttonNamed(label: string, scope: ParentNode = container) {
  const match = [...scope.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing ${label}`);
  return match;
}

async function press(label: string, scope?: ParentNode) {
  const target = buttonNamed(label, scope);
  await act(async () => {
    target.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function row(id: string) {
  const match = container.querySelector(`[data-workspace-id="${id}"]`);
  if (!match) throw new Error(`Missing row ${id}`);
  return match;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function field(name: string) {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`Missing field ${name}`);
  return input;
}

async function submitAdd() {
  const form = container.querySelector("form[data-testid='cloud-workspace-add']");
  if (!form) throw new Error("Missing add form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createQueryRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("CloudWorkspaceList", () => {
  it("shows each workspace with its host and a word for its status", async () => {
    const states = {
      a: { state: "checking" },
      b: { state: "online", name: "B", version: "1.0.0" },
      c: { state: "offline" },
      d: { state: "not-enabled" },
      e: { state: "unauthorized", reason: "account_not_allowed" },
      f: { state: "incompatible", version: "0.9.0" },
    } as const;
    const list = Object.keys(states).map((id) =>
      workspace(id, id.toUpperCase(), `https://${id}.example.test`),
    );
    await render(fakeWorkspaces({ workspaces: [...list, lab], statuses: states }));
    const words = [...container.querySelectorAll("[data-testid='cloud-workspace-status']")].map(
      (status) => status.textContent,
    );
    expect(words).toEqual([
      "Checking…",
      "Online",
      "Offline",
      "Not set up",
      "No access",
      "Needs update",
      "Checking…",
    ]);
    expect(row("a").textContent).toContain("a.example.test");
    expect(row("a").textContent).not.toContain("https://");
    // Plain http is shown whole, so it is not mistaken for a secure address.
    expect(row("lab").textContent).toContain("http://localhost:3000");
    // The dot has a name of its own; colour is never the only signal.
    expect(row("c").querySelector("[role='img']")?.getAttribute("aria-label")).toBe("Offline");
  });

  it("marks the current workspace and opens another", async () => {
    const workspaces = fakeWorkspaces({ workspaces: [home, lab], activeId: "home" });
    await render(workspaces);
    expect(row("home").textContent).toContain("Current");
    expect(() => buttonNamed("Open Home")).toThrow();
    await press("Open Lab");
    expect(workspaces.setActive).toHaveBeenCalledWith("lab");
  });

  it("checks a workspace again from its menu", async () => {
    const workspaces = fakeWorkspaces({ workspaces: [home] });
    await render(workspaces);
    await press("Check again", row("home"));
    expect(workspaces.recheck).toHaveBeenCalledWith("home");
  });

  it("renames a workspace", async () => {
    const workspaces = fakeWorkspaces({ workspaces: [home] });
    await render(workspaces);
    await press("Rename", row("home"));
    const input = row("home").querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Missing name field");
    expect(input.value).toBe("Home");
    await type(input, "  Attic  ");
    await act(async () => {
      input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(workspaces.rename).toHaveBeenCalledWith("home", "Attic");
    await vi.waitFor(() => expect(row("home").querySelector("input")).toBeNull());
  });

  it("removes a workspace only once confirmed", async () => {
    const workspaces = fakeWorkspaces({ workspaces: [home, lab], activeId: "home" });
    await render(workspaces);
    await press("Remove", row("home"));
    expect(row("home").textContent).toContain("Remove Home?");
    expect(workspaces.remove).not.toHaveBeenCalled();
    await press("Cancel", row("home"));
    expect(row("home").textContent).not.toContain("Remove Home?");
    expect(workspaces.remove).not.toHaveBeenCalled();
    await press("Remove", row("home"));
    // The menu item and the confirmation share a word; the confirmation comes last.
    const removes = [...row("home").querySelectorAll("button")].filter(
      (item) => item.textContent === "Remove",
    );
    await act(async () => {
      removes.at(-1)?.click();
      await Promise.resolve();
    });
    expect(workspaces.remove).toHaveBeenCalledWith("home");
  });

  it("adds a workspace, naming it after its host when no name is typed", async () => {
    const workspaces = fakeWorkspaces();
    await render(workspaces);
    expect(field("name").placeholder).toBe("");
    await type(field("url"), "bots.example.test");
    expect(field("name").placeholder).toBe("bots.example.test");
    await submitAdd();
    expect(workspaces.add).toHaveBeenCalledWith({
      name: "bots.example.test",
      url: "bots.example.test",
    });
    await vi.waitFor(() => expect(field("url").value).toBe(""));
  });

  it("does not send a second add while one is on its way", async () => {
    const pendingAdd = deferred<CloudWorkspace>();
    const add = vi.fn(() => pendingAdd.promise);
    await render(fakeWorkspaces({ add }));
    await type(field("url"), "bots.example.test");
    await submitAdd();
    await submitAdd();
    expect(add).toHaveBeenCalledTimes(1);
    expect(buttonNamed("Adding…").disabled).toBe(true);
    await act(async () => pendingAdd.resolve(home));
  });

  it.each([
    ["invalid", "Enter a server address"],
    ["insecure", "Use https"],
    ["not-an-origin", "Only the server address, without a path"],
    ["duplicate", "Already added"],
  ] as [WorkspaceUrlProblem, string][])(
    "shows a refused %s address on its field",
    async (problem, text) => {
      const add = vi.fn(async () => {
        throw new WorkspaceUrlError(problem);
      });
      await render(fakeWorkspaces({ add }));
      await type(field("url"), "something");
      await submitAdd();
      await vi.waitFor(() => expect(container.textContent).toContain(text));
      expect(field("url").getAttribute("aria-invalid")).toBe("true");
      expect(toast.error).not.toHaveBeenCalled();
      // Editing the address clears the complaint.
      await type(field("url"), "something else");
      expect(container.textContent).not.toContain(text);
    },
  );

  it("reports any other failure to add as a toast", async () => {
    const add = vi.fn(async () => {
      throw new Error("network down");
    });
    await render(fakeWorkspaces({ add }));
    await type(field("url"), "bots.example.test");
    await submitAdd();
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("opens the add form from a list and offers hosted workspaces as coming soon", async () => {
    await render(fakeWorkspaces({ workspaces: [home] }));
    expect(container.querySelector("form")).toBeNull();
    await press("Add workspace");
    expect(container.querySelector("form")).not.toBeNull();
    const hosted = container.querySelector<HTMLButtonElement>(
      "[data-testid='cloud-workspace-hosted']",
    );
    expect(hosted?.textContent).toContain("Hosted workspace");
    expect(hosted?.textContent).toContain("Coming soon");
    expect(hosted?.disabled).toBe(true);
    await press("Cancel");
    expect(container.querySelector("form")).toBeNull();
  });

  it("starts with the add form when there is no workspace yet", async () => {
    await render(fakeWorkspaces());
    expect(container.querySelector("form")).not.toBeNull();
    expect(() => buttonNamed("Cancel")).toThrow();
    expect(container.querySelector("[data-testid='cloud-workspace-hosted']")).not.toBeNull();
  });

  it("explains how to set up a server that does not allow this site, with real values", async () => {
    await render(
      fakeWorkspaces({ workspaces: [home], statuses: { home: { state: "not-enabled" } } }),
    );
    expect(row("home").textContent).toContain("How to fix");
    const env = row("home").querySelector("[data-testid='cloud-workspace-env']")?.textContent;
    expect(env).toBe(
      [
        `SUPERBOT_CLOUD_WEB_ORIGINS=${window.location.origin}`,
        `SUPERBOT_CLOUD_ISSUER=${ISSUER}`,
        "SUPERBOT_CLOUD_ALLOWED_EMAILS=ada@example.test",
      ].join("\n"),
    );
  });

  it("offers no fix for a workspace that is online or offline", async () => {
    await render(
      fakeWorkspaces({
        workspaces: [home, lab],
        statuses: {
          home: { state: "online", name: "Home", version: "1" },
          lab: { state: "offline" },
        },
      }),
    );
    expect(container.textContent).not.toContain("How to fix");
  });

  it("names the local account to map to when the server has none for this email", async () => {
    await render(
      fakeWorkspaces({
        workspaces: [home],
        statuses: { home: { state: "unauthorized", reason: "no_local_account" } },
      }),
    );
    expect(row("home").querySelector("[data-testid='cloud-workspace-env']")?.textContent).toBe(
      "SUPERBOT_CLOUD_ALLOWED_EMAILS=ada@example.test=<your email on this server>",
    );
  });
});
