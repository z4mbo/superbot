// @vitest-environment jsdom
import type { RakazoDesktop } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WindowControls } from "./WindowControls";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.rakazoDesktop;
  vi.unstubAllGlobals();
});

function bridge(platform: string, extra: Partial<RakazoDesktop> = {}) {
  const state = { minimized: false, maximized: false, fullScreen: false };
  const changed = new Set<() => void>();
  const desktop = {
    platform,
    window: {
      close: vi.fn(async () => {}),
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {
        state.maximized = !state.maximized;
      }),
      state: vi.fn(async () => ({ ...state })),
      onChange: (listener: () => void) => {
        changed.add(listener);
        return () => changed.delete(listener);
      },
    },
    update: {} as RakazoDesktop["update"],
    oauth: { onCallback: () => () => {} },
    ...extra,
  } satisfies RakazoDesktop;
  window.rakazoDesktop = desktop;
  return {
    desktop,
    state,
    signal: () => {
      for (const listener of changed) listener();
    },
  };
}

const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);
const inset = () => document.documentElement.style.getPropertyValue("--window-controls-inset");

it("draws nothing and reserves nothing in a browser or under macOS traffic lights", async () => {
  await act(async () => root.render(<WindowControls />));
  expect(document.querySelector('[data-testid="window-controls"]')).toBeNull();
  expect(inset()).toBe("");
  bridge("darwin");
  await act(async () => root.render(<WindowControls key="mac" />));
  expect(document.querySelector('[data-testid="window-controls"]')).toBeNull();
  expect(inset()).toBe("");
});

it("draws minimize, maximize and close at the top right on Linux and keeps toolbars clear", async () => {
  const { desktop, state, signal } = bridge("linux");
  await act(async () => root.render(<WindowControls />));
  const controls = document.querySelector('[data-testid="window-controls"]')!;
  expect([...controls.querySelectorAll("button")].map((item) => item.ariaLabel)).toEqual([
    "Minimize",
    "Maximize",
    "Close",
  ]);
  expect(inset()).toBe("140px");

  await act(async () => button("Minimize")!.click());
  expect(desktop.window.minimize).toHaveBeenCalledOnce();
  await act(async () => button("Maximize")!.click());
  expect(desktop.window.toggleMaximize).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(button("Restore")).not.toBeNull());

  // A double click is two clicks; only the first acts.
  await act(async () =>
    button("Restore")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 })),
  );
  expect(desktop.window.toggleMaximize).toHaveBeenCalledOnce();

  // Restored by the system (a title bar double click, say): the window says so.
  state.maximized = false;
  await act(async () => signal());
  await vi.waitFor(() => expect(button("Maximize")).not.toBeNull());

  await act(async () => button("Close")!.click());
  expect(desktop.window.close).toHaveBeenCalledOnce();

  await act(async () => root.unmount());
  root = createRoot(host);
  expect(inset()).toBe("");
});

it("keeps toolbars clear of the Windows overlay without drawing its own buttons", async () => {
  bridge("win32", { nativeWindowFrame: true });
  Object.defineProperty(navigator, "windowControlsOverlay", {
    value: { visible: true },
    configurable: true,
  });
  try {
    await act(async () => root.render(<WindowControls />));
    expect(document.querySelector('[data-testid="window-controls"]')).toBeNull();
    expect(inset()).toBe("140px");
  } finally {
    delete (navigator as { windowControlsOverlay?: unknown }).windowControlsOverlay;
  }
});

it("keeps the controls out of the drag region and paints no fill at rest", async () => {
  bridge("linux");
  await act(async () => root.render(<WindowControls />));
  const controls = document.querySelector<HTMLElement>('[data-testid="window-controls"]')!;
  // Over a drag region the pointer never tells the page it left a button, so its hover stuck.
  expect(controls.classList).toContain("app-no-drag");
  expect(controls.classList).not.toContain("app-drag");
  for (const item of controls.querySelectorAll("button")) {
    const fills = [...item.classList].filter((name) => /(^|:)bg-/.test(name));
    // Every fill waits for hover or press: none applies at rest.
    expect(fills.every((name) => /^(hover|active):/.test(name))).toBe(true);
  }
  const fills = (name: string) =>
    [...button(name)!.classList].filter((item) => item.startsWith("hover:")).join(" ");
  expect(fills("Minimize")).toContain("hover:bg-foreground/8");
  expect(fills("Maximize")).toContain("hover:bg-foreground/8");
  expect(fills("Close")).toContain("hover:bg-destructive-fill");
  expect(fills("Close")).toContain("hover:text-destructive-foreground");
});
