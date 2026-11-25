// @vitest-environment jsdom
import type { ReactElement, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("../../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactElement }) => children,
}));
vi.mock("../bots/bot-picker", () => ({ BotCreatePicker: () => null }));

import { SidebarHeader } from "./sidebar-header";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("offers only search and create, with no Activity toggle", async () => {
  // An older version stored Activity as on; nothing reads it any more.
  localStorage.setItem("rakazo.activity-mode", "1");
  await act(async () =>
    root.render(
      <SidebarHeader
        createMenuOpen={false}
        setCreateMenuOpen={() => undefined}
        onSearch={() => undefined}
        bots={[]}
        setMobileSidebarOpen={() => undefined}
        setPanel={() => undefined}
        navigate={() => undefined}
        setNewSpaceOpen={() => undefined}
        setCreateBotOpen={() => undefined}
      />,
    ),
  );
  expect(
    [...container.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Search", "Create"]);
  expect(container.querySelector("[data-activity-mode]")).toBeNull();
});
