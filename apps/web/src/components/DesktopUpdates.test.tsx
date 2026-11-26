// @vitest-environment jsdom
import type { DesktopUpdateState } from "@rakazo/contracts";
import { Toaster } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopUpdatesProvider, useSidebarUpdate } from "./DesktopUpdates";

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
});

const NOTES = "What's new\n• Faster sync\n<b>not bold</b>";

function bridge(initial: Partial<DesktopUpdateState>) {
  let state: DesktopUpdateState = {
    phase: "available",
    currentVersion: "0.1.0",
    availableVersion: "0.2.0",
    percent: null,
    message: null,
    checkedAt: null,
    releaseNotes: NOTES,
    manualInstall: false,
    ...initial,
  };
  const update = {
    state: vi.fn(async () => state),
    check: vi.fn(async () => state),
    download: vi.fn(async () => state),
    install: vi.fn(async () => state),
  };
  window.rakazoDesktop = {
    platform: "linux",
    window: {
      close: async () => {},
      minimize: async () => {},
      toggleMaximize: async () => {},
      state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
    },
    oauth: { onCallback: () => () => {} },
    update,
  };
  return {
    update,
    set: (next: Partial<DesktopUpdateState>) => {
      state = { ...state, ...next };
    },
  };
}

function UpdateControl() {
  const update = useSidebarUpdate();
  return update.available ? (
    <button type="button" onClick={update.open}>
      Update available
    </button>
  ) : null;
}

async function render() {
  await act(async () =>
    root.render(
      <DesktopUpdatesProvider>
        <UpdateControl />
        <Toaster />
      </DesktopUpdatesProvider>,
    ),
  );
}

const dialog = () => document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
const button = (scope: ParentNode | null, label: string) =>
  [...(scope?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (item) => item.textContent === label,
  );
const toastNotice = () => document.querySelector('[aria-label="Desktop update"]');

it("shows the offered release's notes as text, then restarts once it is downloaded", async () => {
  const { update, set } = bridge({ phase: "downloading", percent: 40 });
  await render();
  // The download runs on its own; only the control offers it until it is ready.
  expect(toastNotice()).toBeNull();
  await act(async () => button(host, "Update available")!.click());
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  expect(dialog()!.textContent).toContain("Update available");
  expect(dialog()!.textContent).toContain("v0.2.0");
  const notes = dialog()!.querySelector('[data-testid="desktop-release-notes"]')!;
  expect(notes.textContent).toBe(NOTES);
  expect(notes.querySelector("b")).toBeNull();
  expect(dialog()!.querySelector('[role="status"]')?.textContent).toBe("40%");
  expect(button(dialog(), "Downloading…")?.disabled).toBe(true);

  set({ phase: "ready", percent: 100 });
  await vi.waitFor(() => expect(button(dialog(), "Restart to update")?.disabled).toBe(false), {
    timeout: 5_000,
  });
  await act(async () => button(dialog(), "Restart to update")!.click());
  expect(update.install).toHaveBeenCalledOnce();
});

it("defers a ready update with Later", async () => {
  const { update } = bridge({ phase: "ready", percent: 100 });
  await render();
  await vi.waitFor(() => expect(toastNotice()).not.toBeNull());
  await act(async () => button(host, "Update available")!.click());
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  await act(async () => button(dialog(), "Later")!.click());
  await vi.waitFor(() => expect(dialog()).toBeNull());
  await vi.waitFor(() => expect(toastNotice()).toBeNull());
  expect(update.install).not.toHaveBeenCalled();
  // The control stays, so the update is one click away later.
  expect(button(host, "Update available")).toBeDefined();
});

it("sends a system package to its release page instead of installing", async () => {
  const { update } = bridge({ phase: "available", manualInstall: true });
  await render();
  await vi.waitFor(() => expect(button(toastNotice(), "Update available")).toBeDefined());
  await act(async () => button(toastNotice(), "Update available")!.click());
  await vi.waitFor(() => expect(dialog()?.textContent).toContain("What's new"));
  await act(async () => button(dialog(), "Download")!.click());
  expect(update.download).toHaveBeenCalledOnce();
  expect(update.install).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(toastNotice()).toBeNull());
});

it("opens without notes when the release has none", async () => {
  bridge({ phase: "ready", releaseNotes: undefined });
  await render();
  await act(async () => button(host, "Update available")!.click());
  await vi.waitFor(() => expect(button(dialog(), "Restart to update")).toBeDefined());
  expect(dialog()!.querySelector('[data-testid="desktop-release-notes"]')).toBeNull();
});
