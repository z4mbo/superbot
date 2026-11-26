// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Command, CommandInput } from "./command";

it("focuses the command input when its search icon is clicked", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <Command>
          <CommandInput aria-label="Search" />
        </Command>,
      );
    });
    const input = container.querySelector("input")!;
    input.focus();
    input.blur();
    await act(async () => {
      container.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.activeElement).toBe(input);
    expect(input.dataset.slot).toBe("input-group-control");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("passes its size to the field and drops the field's frame inside a dialog", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <div data-slot="dialog-content">
          <Command>
            <CommandInput aria-label="Search" size="xl" />
          </Command>
        </div>,
      );
    });
    const group = container.querySelector<HTMLElement>('[data-slot="input-group"]')!;
    expect(group.dataset.size).toBe("xl");
    expect(group.className).toContain("in-data-[slot=dialog-content]:border-transparent!");
    expect(group.className).toContain("in-data-[slot=dialog-content]:bg-transparent!");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
