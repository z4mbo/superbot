// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function classesOf(slot: string) {
  return document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!.className.split(" ");
}

it("draws menus at the reference's 16px radius, 6px inset and 32px rows", async () => {
  const view = await render(
    <DropdownMenu open>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Reply</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Copy</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  try {
    expect(classesOf("dropdown-menu-content")).toEqual(
      expect.arrayContaining(["rounded-xl", "p-1.5", "shadow-popover", "ring-border"]),
    );
    // 20px text plus 6px above and below.
    expect(classesOf("dropdown-menu-item")).toEqual(
      expect.arrayContaining(["py-1.5", "rounded-md"]),
    );
    expect(classesOf("dropdown-menu-separator")).toContain("mx-1.5");
  } finally {
    await view.cleanup();
  }
});

it("lifts popovers with the popover shadow and a border hairline", async () => {
  const view = await render(
    <Popover open>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent>Body</PopoverContent>
    </Popover>,
  );
  try {
    const classes = classesOf("popover-content");
    expect(classes).toEqual(
      expect.arrayContaining(["rounded-xl", "shadow-popover", "ring-border"]),
    );
    expect(classes).not.toContain("shadow-md");
  } finally {
    await view.cleanup();
  }
});

it("shows tooltips as a light chip with a hairline and no arrow", async () => {
  const view = await render(
    <Tooltip open>
      <TooltipTrigger>Search</TooltipTrigger>
      <TooltipContent>Search</TooltipContent>
    </Tooltip>,
  );
  try {
    const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
    expect(tooltip.className.split(" ")).toEqual(
      expect.arrayContaining(["bg-elevated", "text-foreground", "ring-border", "rounded-sm"]),
    );
    expect(tooltip.className).not.toContain("bg-foreground");
    expect(tooltip.querySelector("[data-side], svg")).toBeNull();
  } finally {
    await view.cleanup();
  }
});
