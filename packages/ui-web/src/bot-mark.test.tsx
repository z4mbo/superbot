// @vitest-environment jsdom
import { botMarkRestDrawing } from "@rakazo/core";
import { botMarkDrawing, botMarkFrame } from "@rakazo/core/bot-mark-animation";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { BotMark } from "./bot-mark.js";

// Holds the engine's chunk back until the test lets it load.
const engineLoad = await vi.hoisted(async () => {
  const { deferred } = await import("@rakazo/core/test-async");
  return deferred();
});
vi.mock("./bot-mark-engine.js", async (importOriginal) => {
  await engineLoad.promise;
  return importOriginal();
});

let root: Root;
let container: HTMLDivElement;
beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterAll(() => {
  act(() => root.unmount());
  container.remove();
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

it("paints each mark resting before the engine loads, and the engine keeps an idle mark as it was", async () => {
  act(() =>
    root.render(
      <>
        <span data-testid="idle">
          <BotMark identity="maya" shape="cloud" ink="blue" size={32} />
        </span>
        <span data-testid="working">
          <BotMark identity="otto" shape="egg" ink="green" state="working" size={32} />
        </span>
      </>,
    ),
  );
  const cloud = botMarkRestDrawing("cloud");
  const egg = botMarkRestDrawing("egg");
  expect(shown("idle")).toEqual({ body: cloud.body, eyes: cloud.eyes });
  expect(shown("working")).toEqual({ body: egg.body, eyes: egg.eyes });

  engineLoad.resolve();
  // The working mark starts playing its clips once the engine draws it.
  await vi.waitFor(() => expect(shown("working").body).not.toBe(egg.body), { timeout: 3000 });
  expect(shown("idle")).toEqual({ body: cloud.body, eyes: cloud.eyes });
});

/** The drawing of an idle mark whose face a settled gaze holds, as the engine paints it. */
function held(shape: "cloud" | "egg", x: number, y: number) {
  const frame = botMarkFrame({
    state: "idle",
    time: 0,
    seed: 0,
    shape,
    gaze: { x, y, hold: 1 },
  });
  const drawing = botMarkDrawing(shape, frame);
  return { body: drawing.body, eyes: drawing.eyes };
}

function pointer(type: "pointermove", target: Element, x = 0, y = 0) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
  });
}

it("follows the pointer only inside the avatar's own box, and rests again when it leaves", async () => {
  engineLoad.resolve();
  act(() =>
    root.render(
      <>
        <button type="button" data-bot-mark-host="ada" data-testid="row">
          <span data-testid="ada">
            <BotMark identity="ada" shape="cloud" ink="blue" size={36} />
          </span>
        </button>
        <button type="button" data-bot-mark-host="bo" data-testid="other-row">
          <span data-testid="bo">
            <BotMark identity="bo" shape="egg" ink="green" size={36} />
          </span>
        </button>
        <button type="button" data-testid="header">
          <span data-testid="header-dee">
            <BotMark identity="dee" shape="cloud" ink="blue" size={24} />
          </span>
        </button>
      </>,
    ),
  );
  const rest = { cloud: botMarkRestDrawing("cloud"), egg: botMarkRestDrawing("egg") };
  const resting = (drawing: ReturnType<typeof botMarkRestDrawing>) => ({
    body: drawing.body,
    eyes: drawing.eyes,
  });
  await vi.waitFor(() => expect(shown("ada")).toEqual(resting(rest.cloud)));

  // A mark with no box of its own ignores the pointer over its button and over the page.
  pointer("pointermove", container.querySelector('[data-testid="header"]')!, 400, 10);
  pointer("pointermove", document.body, 400, 10);

  // Inside the row, its own mark turns toward the pointer and settles there; the other bots rest.
  // A test document lays nothing out, so the mark's box is a point at the origin, and the face
  // turns its full way along the pointer's direction: right, and a third as far up.
  const row = container.querySelector('[data-testid="row"]')!;
  pointer("pointermove", row, 30, -10);
  const [x, y] = [3 / Math.sqrt(10), 1 / Math.sqrt(10)];
  await vi.waitFor(() => expect(shown("ada")).toEqual(held("cloud", x, y)), { timeout: 3000 });
  expect(shown("bo")).toEqual(resting(rest.egg));
  expect(shown("header-dee")).toEqual(resting(rest.cloud));

  // Leaving the row for the page around it lets the face go back to rest.
  pointer("pointermove", document.body, 400, 10);
  await vi.waitFor(() => expect(shown("ada")).toEqual(resting(rest.cloud)), { timeout: 3000 });
});

it("faces the open bot straight ahead, and turns it back to rest when another bot opens", async () => {
  engineLoad.resolve();
  act(() =>
    root.render(
      <button type="button" data-bot-mark-host="cy" data-testid="row">
        <span data-testid="cy">
          <BotMark identity="cy" shape="egg" ink="orange" size={36} />
        </span>
      </button>,
    ),
  );
  const row = container.querySelector('[data-testid="row"]')!;
  const rest = botMarkRestDrawing("egg");
  await vi.waitFor(() => expect(shown("cy")).toEqual({ body: rest.body, eyes: rest.eyes }));
  act(() => row.setAttribute("aria-current", "page"));
  await vi.waitFor(() => expect(shown("cy")).toEqual(held("egg", 0, 0)), { timeout: 3000 });
  act(() => row.removeAttribute("aria-current"));
  await vi.waitFor(() => expect(shown("cy")).toEqual({ body: rest.body, eyes: rest.eyes }), {
    timeout: 3000,
  });
});

it("surprises a mark while the pointer is over the line it sits in", async () => {
  engineLoad.resolve();
  act(() =>
    root.render(
      <div data-bot-mark-emphasis="" data-testid="line">
        <span data-testid="em">
          <BotMark identity="em" shape="egg" ink="green" size={28} />
        </span>
        Working on it
      </div>,
    ),
  );
  const rest = botMarkRestDrawing("egg");
  await vi.waitFor(() => expect(shown("em")).toEqual({ body: rest.body, eyes: rest.eyes }));
  const line = container.querySelector('[data-testid="line"]')!;
  const surprised = botMarkDrawing(
    "egg",
    botMarkFrame({ state: "idle", time: 0, seed: 0, emphasis: { on: true, seconds: 1 } }),
  );
  act(() => {
    line.dispatchEvent(new MouseEvent("pointerenter"));
  });
  await vi.waitFor(() => expect(shown("em").eyes).toBe(surprised.eyes), { timeout: 3000 });
  act(() => {
    line.dispatchEvent(new MouseEvent("pointerleave"));
  });
  await vi.waitFor(() => expect(shown("em").eyes).toBe(rest.eyes), { timeout: 3000 });
});

it("keeps a bot that stops working moving for a moment, then rests it", async () => {
  engineLoad.resolve();
  const mark = (state: "working" | "idle") => (
    <span data-testid="settle">
      <BotMark identity="settle" shape="cloud" ink="blue" state={state} size={36} />
    </span>
  );
  act(() => root.render(mark("working")));
  const rest = botMarkRestDrawing("cloud");
  await vi.waitFor(() => expect(shown("settle").body).not.toBe(rest.body), { timeout: 3000 });
  const stopped = performance.now();
  act(() => root.render(mark("idle")));
  await vi.waitFor(() => expect(shown("settle")).toEqual({ body: rest.body, eyes: rest.eyes }), {
    timeout: 5000,
  });
  // It plays on for 1.4s before its 0.35s move to rest.
  expect(performance.now() - stopped).toBeGreaterThan(1700);
});
