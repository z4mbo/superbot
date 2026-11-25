// @vitest-environment jsdom
import { botMarkRestDrawing } from "@rakazo/core";
import { botMarkDrawing, botMarkFrame } from "@rakazo/core/bot-mark-animation";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { BotMark } from "./bot-mark.js";

// The reduced-motion query, flipped by the tests that need it.
const motion = {
  matches: false,
  listeners: [] as (() => void)[],
  addEventListener(_type: string, listener: () => void) {
    this.listeners.push(listener);
  },
  removeEventListener() {},
};
function setReducedMotion(on: boolean) {
  motion.matches = on;
  act(() => {
    for (const listener of motion.listeners) listener();
  });
}

let root: Root;
let container: HTMLDivElement;
const added = vi.spyOn(window, "addEventListener");
const removed = vi.spyOn(window, "removeEventListener");
beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => Object.assign(motion, { media: query }));
  // A test document lays nothing out: every mark sits at the origin at its own size.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const size = Number.parseFloat((this as HTMLElement).style?.width ?? "") || 0;
    return { left: 0, top: 0, width: size, height: size, right: size, bottom: size } as DOMRect;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => setReducedMotion(false));
afterAll(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The body and eye holes an avatar shows, read from the drawing its `<use>` points at. */
function shown(label: string) {
  const use = container.querySelector(`[data-testid="${label}"] use`);
  const group = document.getElementById(use?.getAttribute("href")?.slice(1) ?? "");
  return {
    body: group?.querySelector("path[mask]")?.getAttribute("d"),
    eyes: group?.querySelector("mask path")?.getAttribute("d"),
  };
}

/** The drawing of an idle mark whose face a settled gaze holds. */
function held(shape: "blob" | "egg", x: number, y: number) {
  const drawing = botMarkDrawing(
    shape,
    botMarkFrame({ state: "idle", time: 0, seed: 0, shape, gaze: { x, y, hold: 1 } }),
  );
  return { body: drawing.body, eyes: drawing.eyes };
}

function resting(shape: "blob" | "egg") {
  const drawing = botMarkRestDrawing(shape);
  return { body: drawing.body, eyes: drawing.eyes };
}

function move(target: Element, x: number, y: number, type = "pointermove") {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
  });
}

/** A pinned tile with a 60px mark and two 36px roster rows, each its own bot's box. */
function roster() {
  return (
    <>
      <button type="button" data-bot-mark-host="chief" data-testid="tile">
        <span data-testid="chief">
          <BotMark identity="chief" shape="blob" ink="neutral" size={60} />
        </span>
        Chief
      </button>
      <button type="button" data-bot-mark-host="ada" data-testid="row">
        <span data-testid="ada">
          <BotMark identity="ada" shape="egg" ink="green" size={36} />
        </span>
        Ada
      </button>
      <button type="button" data-bot-mark-host="bo" data-testid="other-row">
        <span data-testid="bo">
          <BotMark identity="bo" shape="egg" ink="orange" size={36} />
        </span>
        Bo
      </button>
    </>
  );
}

const D = Math.SQRT1_2;

it("tracks with one window listener for every box, and stops listening with the last mark", async () => {
  act(() => root.render(roster()));
  // The engine loads after the first mark mounts, then attaches every mark at once.
  await vi.waitFor(() =>
    expect(added.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(1),
  );
  expect(container.querySelectorAll("[data-bot-mark-host]")).toHaveLength(3);
  act(() => root.render(null));
  expect(removed.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(1);
  act(() => root.render(roster()));
  expect(added.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(2);
});

it.each([
  ["up", 18, -100, 0, 1],
  ["down", 18, 200, 0, -1],
  ["left", -100, 18, -1, 0],
  ["right", 300, 18, 1, 0],
  ["up and left", -100, -100, -D, D],
  ["up and right", 136, -100, D, D],
  ["down and left", -100, 136, -D, -D],
  ["down and right", 136, 136, D, -D],
] as const)("a hovered row's mark looks %s, and only that bot's", async (_name, px, py, x, y) => {
  act(() => root.render(roster()));
  await vi.waitFor(() => expect(shown("ada")).toEqual(resting("egg")));
  // The row's mark is 36px at the origin, so its middle is (18, 18).
  move(container.querySelector('[data-testid="row"] span')!, px, py);
  await vi.waitFor(() => {
    const now = shown("ada");
    const want = held("egg", x, y);
    expect(now.eyes).toBe(want.eyes);
  });
  expect(shown("bo")).toEqual(resting("egg"));
  expect(shown("chief")).toEqual(resting("blob"));
  move(document.body, 900, 900);
  await vi.waitFor(() => expect(shown("ada")).toEqual(resting("egg")));
});

it("turns the pinned tile's mark toward the pointer as it moves, and lets go when it leaves", async () => {
  act(() => root.render(roster()));
  const tile = container.querySelector('[data-testid="tile"]')!;
  await vi.waitFor(() => expect(shown("chief")).toEqual(resting("blob")));
  // The tile's mark is 60px, its middle at (30, 30): first above it, then below and right.
  move(tile, 30, -40);
  await vi.waitFor(() => expect(shown("chief")).toEqual(held("blob", 0, 1)));
  expect(shown("ada")).toEqual(resting("egg"));
  move(tile, 130, 130);
  await vi.waitFor(() => expect(shown("chief")).toEqual(held("blob", D, -D)));
  // Leaving the window altogether lets go too.
  act(() => {
    tile.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: null }));
  });
  await vi.waitFor(() => expect(shown("chief")).toEqual(resting("blob")));
});

it("ignores a touch, which has no hover", async () => {
  act(() => root.render(roster()));
  await vi.waitFor(() => expect(shown("ada")).toEqual(resting("egg")));
  const touch = new MouseEvent("pointermove", { clientX: 300, clientY: 18, bubbles: true });
  Object.defineProperty(touch, "pointerType", { value: "touch" });
  act(() => {
    container.querySelector('[data-testid="row"]')!.dispatchEvent(touch);
  });
  // A mouse over the next row turns that mark, so frames have run; the touched one still rests.
  move(container.querySelector('[data-testid="other-row"]')!, 300, 18);
  await vi.waitFor(() => expect(shown("bo")).toEqual(held("egg", 1, 0)));
  expect(shown("ada")).toEqual(resting("egg"));
  move(document.body, 900, 900);
});

it("with reduced motion faces a hovered mark straight ahead wherever the pointer is", async () => {
  act(() => root.render(roster()));
  await vi.waitFor(() => expect(shown("ada")).toEqual(resting("egg")));
  setReducedMotion(true);
  const row = container.querySelector('[data-testid="row"]')!;
  move(row, 300, -100);
  await vi.waitFor(() => expect(shown("ada")).toEqual(held("egg", 0, 0)));
  move(row, -100, 136);
  await vi.waitFor(() => expect(shown("ada")).toEqual(held("egg", 0, 0)));
  move(document.body, 900, 900);
  await vi.waitFor(() => expect(shown("ada")).toEqual(resting("egg")));
});

it("keeps a sleeping mark from following the pointer", async () => {
  // The same bot asleep and awake in one box: the awake mark shows the pointer was followed.
  act(() =>
    root.render(
      <button type="button" data-bot-mark-host="zed" data-testid="row">
        <span data-testid="zed-asleep">
          <BotMark identity="zed" shape="egg" ink="gray" state="asleep" size={36} />
        </span>
        <span data-testid="zed">
          <BotMark identity="zed" shape="egg" ink="green" size={36} />
        </span>
      </button>,
    ),
  );
  setReducedMotion(true);
  const sleeping = botMarkDrawing(
    "egg",
    botMarkFrame({ state: "asleep", time: 0, seed: 0, shape: "egg" }),
  );
  await vi.waitFor(() => expect(shown("zed-asleep").eyes).toBe(sleeping.eyes));
  move(container.querySelector('[data-testid="row"]')!, 300, -100);
  await vi.waitFor(() => expect(shown("zed")).toEqual(held("egg", 0, 0)));
  expect(shown("zed-asleep").eyes).toBe(sleeping.eyes);
});
