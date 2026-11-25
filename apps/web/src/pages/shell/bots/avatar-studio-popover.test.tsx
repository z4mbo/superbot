// @vitest-environment jsdom

import type { BotAvatarSet } from "@rakazo/contracts";
import { BOT_MARK_SHAPES, botMarkShapeFor } from "@rakazo/core";
import { DEFAULT_BOT_AVATAR_COLOR } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { AvatarStudioPopover } from "./avatar-studio-popover";

let container: HTMLDivElement;
let root: Root;
const changed = vi.fn<(value: string, avatarSet?: BotAvatarSet) => void>();

function Harness({
  value: initial,
  avatarSet: initialSet,
}: {
  value: string;
  avatarSet?: BotAvatarSet;
}) {
  const [value, setValue] = useState(initial);
  const [avatarSet, setAvatarSet] = useState(initialSet);
  return (
    <AvatarStudioPopover
      value={value}
      identity="sample-bot"
      avatarSet={avatarSet}
      onChange={(next, nextSet) => {
        changed(next, nextSet);
        setValue(next);
        if (nextSet !== undefined) setAvatarSet(nextSet);
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
  })) as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  changed.mockClear();
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
async function click(name: string) {
  await act(async () => button(name).click());
}
async function render(value: string, avatarSet?: BotAvatarSet, key = "initial") {
  await act(async () => root.render(<Harness key={key} value={value} avatarSet={avatarSet} />));
}

describe("selectable bot icon sets", () => {
  it("keeps a legacy appearance on open, saves a Rakazo switch, and restores the saved set on reload", async () => {
    await render("#10B981");
    await click("Customize bot avatar");
    expect(button("Original").getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("svg[data-bot-mark]")).not.toBeNull();
    expect(changed).not.toHaveBeenCalled();
    await click("Superbot");
    expect(changed).toHaveBeenLastCalledWith("#10B981", "rakazo");
    expect(document.querySelector("svg[data-bot-mark]")).not.toBeNull();
    await render("#10B981", "rakazo", "reload");
    await click("Customize bot avatar");
    expect(button("Superbot").getAttribute("aria-selected")).toBe("true");
    await click("Original");
    expect(changed).toHaveBeenLastCalledWith("#10B981", "organic");
    expect(document.querySelector("svg[data-bot-mark]")).not.toBeNull();
    expect(button(botMarkShapeFor("", null, 1))).toBeDefined();
  });

  it("leaves a photo intact until the user explicitly selects another set", async () => {
    const photo = "data:image/png;base64,abc";
    await render(photo);
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();
    await click("Customize bot avatar");
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();
    await click("Superbot");
    expect(changed).toHaveBeenLastCalledWith(DEFAULT_BOT_AVATAR_COLOR, "rakazo");
    expect(document.querySelector(`img[src="${photo}"]`)).toBeNull();
  });

  it("keeps explicit original shapes and their chosen set while changing colour", async () => {
    await render("#8B5CF6::shape_2", "organic");
    await click("Customize bot avatar");
    expect(changed).not.toHaveBeenCalled();
    await click("Color #00C972");
    expect(changed).toHaveBeenLastCalledWith("#00C972::shape_2", undefined);
    expect(button("Original").getAttribute("aria-selected")).toBe("true");
    await click("Superbot");
    expect(changed).toHaveBeenLastCalledWith("#00C972", "rakazo");
  });
});

describe("bot mark look", () => {
  it("offers every mark shape and ink and saves the pick as the bot's look", async () => {
    const looks = vi.fn();
    function LookHarness() {
      const [look, setLook] = useState({
        lookShape: null as string | null,
        lookColor: null as string | null,
      });
      return (
        <AvatarStudioPopover
          value="#FF781C"
          identity="sample-bot"
          onChange={changed}
          look={look}
          onLookChange={(next) => {
            looks(next);
            setLook(next);
          }}
        />
      );
    }
    await act(async () => root.render(<LookHarness />));
    await click("Customize bot avatar");
    expect(document.querySelectorAll('[data-testid="avatar-studio-shapes"] button')).toHaveLength(
      BOT_MARK_SHAPES.length,
    );
    expect(document.querySelectorAll('[data-testid="avatar-studio-inks"] button')).toHaveLength(10);
    expect(button("orange").getAttribute("aria-pressed")).toBe("true");
    await click("cloud");
    expect(looks).toHaveBeenLastCalledWith({ lookShape: "cloud", lookColor: null });
    await click("green");
    expect(looks).toHaveBeenLastCalledWith({ lookShape: "cloud", lookColor: "green" });
    expect(button("cloud").getAttribute("aria-pressed")).toBe("true");
    expect(changed).not.toHaveBeenCalled();
  });
});
