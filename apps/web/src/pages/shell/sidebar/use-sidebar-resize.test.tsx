// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BOTS_SIDEBAR_DEFAULT_WIDTH,
  readBotsSidebarWidth,
  writeBotsSidebarWidth,
} from "../../../lib/preferences/bots-sidebar-width-pref";
import { useSidebarResize } from "./use-sidebar-resize";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let current: ReturnType<typeof useSidebarResize>;
let renders = 0;

function Harness({ userId = "user" }: { userId?: string }) {
  renders += 1;
  current = useSidebarResize({ userId });
  return <hr {...current.handleProps} aria-label="Resize bots" />;
}

beforeEach(async () => {
  localStorage.clear();
  // The gestures below start from a saved 316px sidebar; the default has its own test.
  writeBotsSidebarWidth("user", 316);
  vi.stubGlobal("innerWidth", 1200);
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const handle = host.querySelector("hr")!;
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => true);
  handle.releasePointerCapture = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.documentElement.dir = "";
  vi.unstubAllGlobals();
});

async function pointer(type: string, x: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  await act(async () => host.querySelector("hr")!.dispatchEvent(event));
}
async function key(value: string) {
  await act(async () =>
    host
      .querySelector("hr")!
      .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value })),
  );
}

it("opens at the default width before anything is saved", async () => {
  localStorage.clear();
  await act(async () => root.render(<Harness userId="fresh" />));
  expect(current.width).toBe(BOTS_SIDEBAR_DEFAULT_WIDTH);
});

it("previews every drag position and commits the width on release", async () => {
  await pointer("pointerdown", 316);
  await pointer("pointermove", 400);
  expect(current.width).toBe(400);
  expect(current.resizing).toBe(true);
  expect(readBotsSidebarWidth("user")).toBe(316);
  await pointer("pointerup", 400);
  expect(current.resizing).toBe(false);
  expect(readBotsSidebarWidth("user")).toBe(400);
});

it("stops a narrow drag at the minimum width instead of hiding the sidebar", async () => {
  await pointer("pointerdown", 316);
  await pointer("pointermove", 100);
  expect(current.width).toBe(240);
  await pointer("pointerup", 100);
  expect(current.width).toBe(240);
  expect(readBotsSidebarWidth("user")).toBe(240);
  await key("Home");
  await key("Enter");
  expect(current.width).toBe(240);
});

it("cancels a drag without changing its saved width", async () => {
  await pointer("pointerdown", 316);
  await pointer("pointermove", 450);
  await pointer("pointercancel", 450);
  expect(current.width).toBe(316);
  expect(readBotsSidebarWidth("user")).toBe(316);
  expect(current.resizing).toBe(false);
  await pointer("pointerdown", 316);
  await pointer("pointermove", 300);
  await pointer("lostpointercapture", 300);
  expect(current.width).toBe(316);
});

it("resizes pointer and keyboard gestures in the visual direction for RTL", async () => {
  document.documentElement.dir = "rtl";
  await key("ArrowLeft");
  expect(current.width).toBe(348);
  await pointer("pointerdown", 852);
  await pointer("pointermove", 800);
  await pointer("pointerup", 800);
  expect(current.width).toBe(400);
  await key("ArrowRight");
  expect(current.width).toBe(368);
  await key("Home");
  expect(current.width).toBe(240);
  await key("ArrowRight");
  expect(current.width).toBe(240);
});

it("limits the sidebar on viewport resize without discarding the preferred width", async () => {
  await key("End");
  expect(current.width).toBe(480);
  vi.stubGlobal("innerWidth", 768);
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(current.width).toBe(448);
  expect(readBotsSidebarWidth("user")).toBe(480);
  vi.stubGlobal("innerWidth", 1200);
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(current.width).toBe(480);
  await act(async () => root.render(<Harness userId="another-user" />));
  expect(current.width).toBe(BOTS_SIDEBAR_DEFAULT_WIDTH);
});

it("re-renders on viewport resize only when the sidebar's limit changes", async () => {
  const before = renders;
  for (const width of [1100, 1000, 900]) {
    vi.stubGlobal("innerWidth", width);
    await act(async () => window.dispatchEvent(new Event("resize")));
  }
  expect(renders).toBe(before);

  vi.stubGlobal("innerWidth", 700);
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(renders).toBeGreaterThan(before);
  expect(current.handleProps["aria-valuemax"]).toBe(380);
});
