// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { BOT_MARK_PICKER_INKS, BOT_MARK_PICKER_SHAPES } from "@rakazo/core";
import type { BotMarkLook } from "./avatar-studio-popover";
import { AvatarStudioPopover } from "./avatar-studio-popover";

let container: HTMLDivElement;
let root: Root;
const changed = vi.fn<(value: string) => void>();
const looks = vi.fn<(look: BotMarkLook) => void>();

function Harness({ value: initial, look: initialLook }: { value: string; look: BotMarkLook }) {
  const [value, setValue] = useState(initial);
  const [look, setLook] = useState(initialLook);
  return (
    <AvatarStudioPopover
      value={value}
      identity="sample-bot"
      look={look}
      onChange={(next) => {
        changed(next);
        setValue(next);
      }}
      onLookChange={(next) => {
        looks(next);
        setLook(next);
      }}
    />
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  changed.mockClear();
  looks.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label") === name || node.textContent === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
function maybeButton(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label") === name || node.textContent === name,
  );
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function render(value: string, look: BotMarkLook = { lookShape: null, lookColor: null }) {
  await act(async () => root.render(<Harness value={value} look={look} />));
  await click("Edit Bot avatar");
}
function shown(attribute: "data-bot-look-shape" | "data-bot-look-ink") {
  return [...document.querySelectorAll(`[${attribute}]`)].map((cell) =>
    cell.getAttribute(attribute),
  );
}

describe("agent edit menu", () => {
  it("opens the Avatar editor on the Bot tab with the reference's bodies and colours", async () => {
    await render("#000000", { lookShape: "blob", lookColor: "neutral" });
    expect(document.querySelector('[aria-label="Avatar editor"]')).not.toBeNull();
    expect(button("Bot").getAttribute("aria-selected")).toBe("true");
    expect(maybeButton("Upload")).toBeDefined();
    expect(shown("data-bot-look-shape")).toEqual(BOT_MARK_PICKER_SHAPES);
    expect(shown("data-bot-look-ink")).toEqual(BOT_MARK_PICKER_INKS);
    const rows = document.querySelector('[aria-label="Character shape"]')!.children;
    expect([...rows].map((row) => row.children.length)).toEqual([5, 5, 3]);
    expect(button("blob character shape").getAttribute("aria-pressed")).toBe("true");
    expect(button("Black character color").getAttribute("aria-pressed")).toBe("true");
  });

  it("saves each pick as the bot's look as soon as it is made", async () => {
    await render("#FF781C");
    await click("cloud character shape");
    expect(looks).toHaveBeenLastCalledWith({ lookShape: "cloud", lookColor: "orange" });
    await click("Green character color");
    expect(looks).toHaveBeenLastCalledWith({ lookShape: "cloud", lookColor: "green" });
    expect(button("cloud character shape").getAttribute("aria-pressed")).toBe("true");
    expect(changed).not.toHaveBeenCalled();
  });

  it("adds the bot's own body when the picker does not offer it", async () => {
    await render("#FF781C", { lookShape: "pebble", lookColor: "blue" });
    expect(shown("data-bot-look-shape")).toEqual([...BOT_MARK_PICKER_SHAPES, "pebble"]);
    expect(button("pebble character shape").getAttribute("aria-pressed")).toBe("true");
  });

  it("hides the colours for a body that wears its own ink", async () => {
    await render("#FF781C", { lookShape: "pumpkin", lookColor: "orange" });
    expect(document.querySelector('[aria-label="Character color"]')).toBeNull();
    await click("cloud character shape");
    expect(looks).toHaveBeenLastCalledWith({ lookShape: "cloud", lookColor: "orange" });
    expect(document.querySelector('[aria-label="Character color"]')).not.toBeNull();
  });

  it("offers Reset only while the bot has a picked look, and clears it", async () => {
    await render("#FF781C");
    expect(maybeButton("Reset character to default")).toBeUndefined();
    await click("star character shape");
    await click("Reset character to default");
    expect(looks).toHaveBeenLastCalledWith({ lookShape: null, lookColor: null });
    expect(maybeButton("Reset character to default")).toBeUndefined();
  });

  it("holds picks over a photo until Set avatar replaces it", async () => {
    const photo = "data:image/png;base64,abc";
    await render(photo);
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();
    await click("heart character shape");
    expect(looks).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    await click("Set avatar");
    expect(looks).toHaveBeenLastCalledWith({ lookShape: "heart", lookColor: expect.any(String) });
    expect(changed).toHaveBeenLastCalledWith(expect.stringMatching(/^#/));
    expect(document.querySelector(`img[src="${photo}"]`)).toBeNull();
  });

  it("resets a photo back to the bot's mark", async () => {
    const photo = "data:image/png;base64,abc";
    await render(photo);
    await click("Reset to the Bot");
    expect(changed).toHaveBeenLastCalledWith(expect.stringMatching(/^#/));
    expect(document.querySelector(`img[src="${photo}"]`)).toBeNull();
  });
});
