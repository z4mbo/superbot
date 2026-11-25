// @vitest-environment jsdom
import { botMarkRestDrawing } from "@rakazo/core";
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
