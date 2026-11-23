// @vitest-environment jsdom
import type { DesktopUpdateState } from "@rakazo/contracts";
import { Toaster } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopUpdatesProvider } from "../../../components/DesktopUpdates";
import { SidebarFooter } from "./sidebar-footer";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.rakazoDesktop;
  vi.restoreAllMocks();
});
async function render(
  name = "Demo User",
  image?: string,
  onIntegrations = vi.fn(),
  onBoard?: () => void,
  { mini = false, onSettings = vi.fn() }: { mini?: boolean; onSettings?: () => void } = {},
) {
  const email = "account@rakazo.test";
  await act(async () =>
    root.render(
      <DesktopUpdatesProvider>
        <SidebarFooter
          mini={mini}
          name={name}
          initials={name
            .split(" ")
            .map((part) => part[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
          image={image}
          email={email}
          open
          onOpenChange={() => {}}
          onIntegrations={onIntegrations}
          onSkills={vi.fn()}
          onBoard={onBoard}
          onArtifacts={() => {}}
          onSettings={onSettings}
          onLogOut={() => {}}
          signingOut={false}
          logOutError={null}
        />
        <Toaster />
      </DesktopUpdatesProvider>,
    ),
  );
}
function bridge(phase: DesktopUpdateState["phase"]) {
  const state: DesktopUpdateState = {
    phase,
    currentVersion: "0.1.0",
    availableVersion: "0.2.0",
    percent: null,
    message: null,
    checkedAt: null,
  };
  const install = vi.fn(async () => state);
  window.rakazoDesktop = {
    platform: "darwin",
    window: {
      close: async () => {},
      minimize: async () => {},
      toggleMaximize: async () => {},
      state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
    },
    oauth: { onCallback: () => () => {} },
    update: {
      state: async () => state,
      install,
      download: async () => state,
      check: async () => state,
    },
  };
  return install;
}
it("hides update controls without a desktop bridge", async () => {
  await render();
  expect(document.querySelector('[aria-label="Install update"]')).toBeNull();
  expect(document.body.textContent).not.toContain("New update available");
});
it.each(["unsupported", "idle", "available", "downloading", "checking", "error"] as const)(
  "hides install controls in phase %s",
  async (phase) => {
    bridge(phase);
    await render();
    expect(document.querySelector('[aria-label="Install update"]')).toBeNull();
    expect(document.body.textContent).not.toContain("New update available");
  },
);
it("installs the ready update only through the footer button", async () => {
  const install = bridge("ready");
  await render("Ada Lovelace");
  const icon = document.querySelector<HTMLButtonElement>('[aria-label="Install update"]')!;
  expect(icon).not.toBeNull();
  expect(icon.nextElementSibling?.getAttribute("aria-label")).toBe("Store");
  expect(document.body.textContent).not.toContain("New update available");
  await act(async () => icon.click());
  expect(install).toHaveBeenCalledTimes(1);
  expect(
    [...document.querySelectorAll("button")].some((button) => button.textContent === "Install"),
  ).toBe(false);
});
it("shows the account image and falls back to the initial after a load error", async () => {
  await render("Ada Lovelace", "https://example.test/avatar.png");
  const trigger = host.querySelector('[data-testid="user-menu-trigger"]')!;
  const image = trigger.querySelector("img")!;
  expect(image.src).toBe("https://example.test/avatar.png");
  await act(async () => image.dispatchEvent(new Event("error")));
  expect(trigger.querySelector("img")).toBeNull();
  expect(trigger.textContent).toBe("ALAda Lovelace");
});

it("opens Store from the footer and Settings from the account menu", async () => {
  const onIntegrations = vi.fn();
  const onSettings = vi.fn();
  await render("Demo User", undefined, onIntegrations, vi.fn(), { onSettings });
  const footer = host.querySelector('[data-testid="sidebar-footer"]')!;
  const store = footer.querySelector<HTMLButtonElement>('[aria-label="Store"]')!;
  expect(footer.querySelector('[aria-label="Settings"]')).toBeNull();
  await act(async () => store.click());
  expect(onIntegrations).toHaveBeenCalledOnce();
  const menu = document.querySelector('[data-slot="popover-content"]')!;
  await act(async () => menu.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click());
  expect(onSettings).toHaveBeenCalledOnce();
  expect([...menu.querySelectorAll("button, a")].map((row) => row.textContent)).toEqual([
    "Settings",
    "Skills",
    "Artifacts",
    "Board",
    "Log out",
  ]);
  expect(host.querySelector('[data-testid="user-menu-trigger"]')?.getAttribute("aria-label")).toBe(
    "Account menu for Demo User",
  );
});

it("keeps Store and Settings in the account menu when the sidebar is collapsed", async () => {
  await render("Demo User", undefined, undefined, undefined, { mini: true });
  const footer = host.querySelector('[data-testid="sidebar-footer"]')!;
  expect([...footer.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "DU",
  ]);
  const menu = document.querySelector('[data-slot="popover-content"]')!;
  expect([...menu.querySelectorAll("button")].map((row) => row.textContent)).toEqual([
    "Store",
    "Settings",
    "Skills",
    "Artifacts",
    "Log out",
  ]);
});
it("omits Board when unavailable", async () => {
  await render();
  expect(document.querySelector('[data-slot="popover-content"]')?.textContent).not.toContain(
    "Board",
  );
});

it.each(["throw", "state"] as const)(
  "reveals a %s install failure after Later",
  async (failure) => {
    const install = bridge("ready");
    if (failure === "throw") install.mockRejectedValueOnce(new Error("offline"));
    else
      install.mockResolvedValueOnce({
        ...(await window.rakazoDesktop!.update.state()),
        phase: "error",
        message: "Update could not be installed",
      });
    await render();
    // The notice is a toast, which mounts and leaves on the toaster's own timers.
    const notice = () => document.querySelector('[aria-label="Desktop update"]');
    const later = () =>
      [...notice()!.querySelectorAll("button")].find((button) => button.textContent === "Later")!;
    await vi.waitFor(() => expect(notice()).not.toBeNull());
    await act(async () => later().click());
    await vi.waitFor(() => expect(notice()).toBeNull());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Install update"]')!.click(),
    );
    await vi.waitFor(() =>
      expect(notice()?.querySelector('[role="status"]')?.textContent).toBe(
        failure === "throw"
          ? "Could not complete the update. Try again."
          : "Update could not be installed",
      ),
    );
    await act(async () => later().click());
    await vi.waitFor(() => expect(notice()).toBeNull());
  },
);

const personal = {
  id: "org-personal",
  name: "Personal",
  defaultSpaceId: "s1",
  spaceIds: ["s1"],
  canManage: true,
  role: "owner" as const,
  memberCount: 1,
};
const work = {
  id: "org-work",
  name: "Work",
  defaultSpaceId: "s2",
  spaceIds: ["s2"],
  canManage: true,
  role: "owner" as const,
  memberCount: 1,
};

async function renderOrganizations(
  organizations: (typeof personal)[],
  onSwitchOrganization = vi.fn(),
  onCreateOrganization = vi.fn(),
) {
  await act(async () =>
    root.render(
      <DesktopUpdatesProvider>
        <SidebarFooter
          name="Demo User"
          initials="DU"
          email="account@rakazo.test"
          open
          onOpenChange={() => {}}
          onIntegrations={() => {}}
          onSkills={() => {}}
          onArtifacts={() => {}}
          onSettings={() => {}}
          onLogOut={() => {}}
          signingOut={false}
          logOutError={null}
          organizations={organizations}
          activeOrganizationId="org-personal"
          onSwitchOrganization={onSwitchOrganization}
          onCreateOrganization={onCreateOrganization}
        />
      </DesktopUpdatesProvider>,
    ),
  );
  return [...document.querySelector('[data-slot="popover-content"]')!.querySelectorAll("button")];
}

async function openOrganizations() {
  await act(async () =>
    (document.querySelector('[data-testid="organization-menu-trigger"]') as HTMLElement).click(),
  );
  const menus = document.querySelectorAll('[data-slot="popover-content"]');
  return [...menus[menus.length - 1]!.querySelectorAll("button")];
}

it("shows the active organization as one row, even when it is the only one", async () => {
  const rows = await renderOrganizations([personal]);
  expect(rows.map((row) => row.textContent).slice(0, 2)).toEqual(["Personal", "Settings"]);
});

it("lists organizations in a submenu with the active one checked, then New organization", async () => {
  const onSwitch = vi.fn();
  const onCreate = vi.fn();
  const rows = await renderOrganizations([personal, work], onSwitch, onCreate);
  expect(rows.map((row) => row.textContent).slice(0, 2)).toEqual(["Personal", "Settings"]);
  const items = await openOrganizations();
  expect(items.map((item) => item.textContent)).toEqual(["Personal", "Work", "New organization"]);
  expect(items[0]!.getAttribute("aria-current")).toBe("true");
  expect(items[0]!.querySelector("svg")).not.toBeNull();
  expect(items[1]!.hasAttribute("aria-current")).toBe(false);
  expect(items[1]!.querySelector("svg")).toBeNull();
  await act(async () => items[1]!.click());
  expect(onSwitch).toHaveBeenCalledWith(work);
  await act(async () => items[2]!.click());
  expect(onCreate).toHaveBeenCalled();
});
