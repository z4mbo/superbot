// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { Routine } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotPanelActivity } from "./bot-panel-activity";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

function routine(index: number): Routine {
  return {
    id: `routine-${index}`,
    botId: "bot-1",
    name: `Routine ${index}`,
    prompt: "",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
    inChat: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    emailSenders: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    watch: null,
    watchState: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  routines: Routine[],
  props: Partial<ComponentProps<typeof BotPanelActivity>> = {},
) {
  const handlers = {
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onStop: vi.fn(),
    onToggle: vi.fn(),
    onOpenRoutines: vi.fn(),
  };
  const { onOpenRoutines, ...routineHandlers } = handlers;
  await act(async () => {
    root.render(
      <BotPanelActivity
        routines={{ routines, loaded: true, ...routineHandlers }}
        onOpenRoutines={onOpenRoutines}
        computer={<div data-testid="computer-card">Ada’s computer</div>}
        {...props}
      />,
    );
  });
  return handlers;
}

function sections() {
  return [...container.querySelectorAll("section")].map((section) => ({
    heading: section.querySelector("h3")?.textContent,
    testId: section.dataset.testid,
  }));
}

it("shows Upcoming, then Computer, as headed card sections", async () => {
  await render([routine(1)]);
  expect(sections()).toEqual([
    { heading: "Upcoming", testId: "bot-panel-upcoming" },
    { heading: "Computer", testId: "bot-panel-computer" },
  ]);
  const computer = container.querySelector('[data-testid="bot-panel-computer"]');
  expect(computer?.querySelector('[data-testid="computer-card"]')).not.toBeNull();
  // Each section's content sits in one hairline card.
  expect(computer?.querySelector("h3 + div")?.className).toContain("border");
});

it("lists each routine with its schedule and a switch that turns it off", async () => {
  const first = routine(1);
  const { onToggle } = await render([first]);
  const upcoming = container.querySelector('[data-testid="bot-panel-upcoming"]')!;
  expect(upcoming.textContent).toContain("Routine 1");
  expect(upcoming.textContent).toContain("9:00");
  const toggle = upcoming.querySelector<HTMLElement>('[role="switch"]');
  expect(toggle?.getAttribute("aria-label")).toBe("Turn Routine 1 on or off");
  await act(async () => toggle?.click());
  expect(onToggle).toHaveBeenCalledExactlyOnceWith(first, false);
});

it("offers a new routine in the card while the bot has none", async () => {
  const { onCreate } = await render([]);
  const create = container.querySelector<HTMLButtonElement>(
    '[data-testid="bot-panel-upcoming"] [data-testid="routine-create-button"]',
  );
  expect(create?.textContent).toBe("New routine");
  await act(async () => create?.click());
  expect(onCreate).toHaveBeenCalledOnce();
});

it("links the heading to the whole list once there are more routines than it shows", async () => {
  const { onOpenRoutines } = await render([1, 2, 3, 4].map(routine));
  const upcoming = container.querySelector('[data-testid="bot-panel-upcoming"]')!;
  expect(upcoming.querySelectorAll('[role="switch"]')).toHaveLength(3);
  await act(async () => upcoming.querySelector<HTMLButtonElement>("h3 button")?.click());
  expect(onOpenRoutines).toHaveBeenCalledOnce();
});

it("leaves out a section it has nothing for and keeps what follows", async () => {
  await act(async () => {
    root.render(
      <BotPanelActivity onOpenRoutines={() => undefined}>
        <p>After</p>
      </BotPanelActivity>,
    );
  });
  expect(sections()).toEqual([]);
  expect(container.textContent).toBe("After");
});
