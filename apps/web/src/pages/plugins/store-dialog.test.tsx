// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/bot-templates/bot-templates-dialog", () => ({
  BotTemplatesPanel: () => <p>agent templates</p>,
}));
vi.mock("../../components/integrations/skills-dialog", () => ({
  SkillsPanel: () => <p>skills</p>,
}));
vi.mock("./community/community-store", () => ({
  CommunityStore: ({ initialSlug }: { initialSlug?: string }) => (
    <p>community {initialSlug ?? "list"}</p>
  ),
}));
vi.mock("./apps-section", () => ({
  AppsSection: ({ onOpenCommunity }: { onOpenCommunity: (slug?: string) => void }) => (
    <button type="button" onClick={() => onOpenCommunity("kcal-diary")}>
      open diary
    </button>
  ),
}));

import type { StoreSection } from "../shell/shell-overlay-url";
import { StoreDialog } from "./store-dialog";

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
  vi.unstubAllGlobals();
});

function store() {
  return document.querySelector<HTMLElement>('[data-testid="store"]')!;
}

it("shows one section at a time and hands a community pick from Apps to Plugins", async () => {
  let section: StoreSection = "apps";
  const render = () =>
    act(async () =>
      root.render(
        <StoreDialog
          section={section}
          onSectionChange={(next) => {
            section = next;
            void render();
          }}
          onClose={() => undefined}
          onOpenBot={() => undefined}
        />,
      ),
    );
  await render();
  expect([...store().querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    "Agents",
    "Skills",
    "Plugins",
    "Apps",
  ]);
  expect(store().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Apps");

  await act(async () =>
    [...store().querySelectorAll("button")]
      .find((button) => button.textContent === "open diary")!
      .click(),
  );
  expect(section).toBe("plugins");
  expect(store().textContent).toContain("community kcal-diary");

  await act(async () =>
    store().querySelector<HTMLElement>('[data-testid="store-agents"]')!.click(),
  );
  expect(section).toBe("agents");
  expect(store().textContent).toContain("agent templates");
  await act(async () =>
    store().querySelector<HTMLElement>('[data-testid="store-plugins"]')!.click(),
  );
  expect(store().textContent).toContain("community list");
});
