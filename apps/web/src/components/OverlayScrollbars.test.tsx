// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverlayScrollbars } from "./OverlayScrollbars";

let host: HTMLDivElement;
let root: Root;
let classic: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  classic = true;
  // jsdom lays nothing out; a platform with classic scrollbars gives the probe a 15px bar.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return classic && this.style.overflow === "scroll" ? 100 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.style.overflow === "scroll" ? 85 : 0;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A 200px tall list at (100, 50) holding `contentHeight` of rows. */
function scroller(contentHeight = 800) {
  const list = document.createElement("div");
  list.style.overflowY = "auto";
  const row = document.createElement("button");
  list.append(row);
  document.body.append(list);
  Object.defineProperties(list, {
    clientHeight: { value: 200 },
    scrollHeight: { value: contentHeight },
    clientWidth: { value: 300 },
    scrollWidth: { value: 300 },
    clientTop: { value: 0 },
    clientLeft: { value: 0 },
    scrollTop: { value: 0, writable: true },
  });
  list.getBoundingClientRect = () =>
    ({ left: 100, top: 50, width: 300, height: 200, right: 400, bottom: 250 }) as DOMRect;
  return { list, row };
}

const thumb = () => document.querySelector<HTMLElement>('[data-testid="overlay-scrollbar-y"]')!;

/** Renders, then waits for the thumbs, which load after the page paints. */
async function render() {
  await act(async () => root.render(<OverlayScrollbars />));
  if (!classic) return;
  await act(async () => {
    await import("./OverlayScrollbarThumbs");
  });
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="overlay-scrollbar-y"]')).not.toBeNull(),
  );
}

function point(target: Element) {
  act(() => {
    target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    vi.advanceTimersToNextFrame();
  });
}

it("leaves scrollbars that already overlay the content to the platform", async () => {
  classic = false;
  await render();
  expect(document.documentElement.hasAttribute("data-overlay-scrollbars")).toBe(false);
  expect(document.querySelector('[data-testid="overlay-scrollbar-y"]')).toBeNull();
});

it("hides classic scrollbars and shows a thumb over the area under the pointer", async () => {
  await render();
  expect(document.documentElement.hasAttribute("data-overlay-scrollbars")).toBe(true);
  const { list, row } = scroller();
  expect(thumb().hasAttribute("data-shown")).toBe(false);

  point(row);
  expect(thumb().hasAttribute("data-shown")).toBe(true);
  // 6px wide, 1px in from the right edge, 7px below the top; the track is 200 - 7 - 5 = 188px,
  // a quarter of which is in view.
  expect(thumb().style.width).toBe("6px");
  expect(thumb().style.height).toBe("47px");
  expect(thumb().style.transform).toBe("translate(393px, 57px)");

  list.scrollTop = 600;
  act(() => {
    list.dispatchEvent(new Event("scroll"));
    vi.advanceTimersToNextFrame();
  });
  expect(thumb().style.transform).toBe(`translate(393px, ${50 + 7 + 188 - 47}px)`);

  point(document.body);
  expect(thumb().hasAttribute("data-shown")).toBe(true);
  // Shown by scrolling, it stays a moment once the pointer has gone.
  act(() => vi.advanceTimersByTime(1000));
  act(() => vi.advanceTimersToNextFrame());
  expect(thumb().hasAttribute("data-shown")).toBe(false);
  list.remove();
  act(() => root.unmount());
  expect(document.documentElement.hasAttribute("data-overlay-scrollbars")).toBe(false);
  root = createRoot(host);
});

it("draws nothing over an area whose content fits", async () => {
  await render();
  const { list, row } = scroller(200);
  point(row);
  expect(thumb().hasAttribute("data-shown")).toBe(false);
  list.remove();
});

it("scrolls its area when dragged or when a wheel turns over it", async () => {
  await render();
  const { list, row } = scroller();
  point(row);
  Object.defineProperty(thumb(), "offsetHeight", { value: 47 });
  thumb().setPointerCapture = () => undefined;

  act(() => {
    thumb().dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, clientY: 100, pointerId: 1 }),
    );
  });
  expect(thumb().hasAttribute("data-dragging")).toBe(true);
  act(() => {
    thumb().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 170 }));
  });
  // 70px of the 141px the thumb can travel moves through 70/141 of the 600px that can scroll.
  expect(list.scrollTop).toBeCloseTo((70 * 600) / 141, 0);
  act(() => {
    thumb().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  });
  expect(thumb().hasAttribute("data-dragging")).toBe(false);

  list.scrollBy = vi.fn();
  act(() => {
    thumb().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 }));
  });
  expect(list.scrollBy).toHaveBeenCalledWith({ left: 0, top: 40 });
  list.remove();
});
