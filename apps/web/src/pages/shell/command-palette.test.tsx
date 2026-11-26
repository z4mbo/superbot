// @vitest-environment jsdom
import type { Bot, SearchHit } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: parts }, ...values),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/chat-ui/web", () => ({ PageIcon: () => null }));

import { CommandPalette } from "./command-palette";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // cmdk scrolls the selected row into view and measures the list.
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const scout = {
  id: "bot-scout",
  name: "Scout",
  description: "Finds sources",
  preview: "",
  color: "#000000",
  status: "idle",
} as Bot;

const groupHit: SearchHit = {
  kind: "message",
  groupId: "group-1",
  groupName: "Squad",
  title: "Squad",
  snippet: "the quarterly notes are ready",
  messageId: "msg-1",
  seq: 3,
};
const botChatHit: SearchHit = {
  kind: "conversation",
  botId: "bot-scout",
  botName: "Scout",
  title: "Scout",
  snippet: "",
};

function chats(overrides: Partial<NonNullable<ComponentProps<typeof CommandPalette>["chats"]>>) {
  return {
    hits: [],
    loading: false,
    error: null,
    onRetry: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
}

async function render(props: Partial<ComponentProps<typeof CommandPalette>>) {
  await act(async () =>
    root.render(
      <CommandPalette
        open
        onOpenChange={() => undefined}
        bots={[scout]}
        onSelectBot={() => undefined}
        actions={[]}
        {...props}
      />,
    ),
  );
}

async function type(text: string) {
  const input = document.querySelector<HTMLInputElement>('[data-testid="command-palette-search"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function headings() {
  return [...document.querySelectorAll("[cmdk-group-heading]")].map((node) => node.textContent);
}

it("lists the bots under a Bots heading beneath a search naming what it finds", async () => {
  await render({});
  expect(
    document.querySelector('[data-testid="command-palette-search"]')?.getAttribute("placeholder"),
  ).toBe("Search Bots, Chats, Settings…");
  expect(headings()).toEqual(["Bots"]);
  expect(document.body.textContent).toContain("Scout");
});

it("shows what the chat search found, leaving bots to the rows above", async () => {
  const onSelect = vi.fn();
  await render({ chats: chats({ hits: [groupHit, botChatHit], onSelect }) });
  await type("quarterly");
  expect(headings()).toEqual(["Chats"]);
  const options = [...document.querySelectorAll('[role="option"]')];
  expect(options).toHaveLength(1);
  expect(options[0]?.textContent).toContain("the quarterly notes are ready");
  await act(async () => (options[0] as HTMLElement).click());
  expect(onSelect).toHaveBeenCalledWith(groupHit);
});

it("says a chat search failed instead of No results, and retries it", async () => {
  const onRetry = vi.fn();
  await render({ chats: chats({ error: "Could not reach the server", onRetry }) });
  await type("quarterly");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Could not reach the server");
  expect(document.body.textContent).not.toContain("No results");
  const retry = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
  await act(async () => retry?.click());
  expect(onRetry).toHaveBeenCalled();
});

it("waits for the chat search before saying there are no results", async () => {
  await render({ chats: chats({ loading: true }) });
  await type("quarterly");
  expect(document.body.textContent).not.toContain("No results");
  await render({ chats: chats({}) });
  expect(document.body.textContent).toContain("No results");
});
