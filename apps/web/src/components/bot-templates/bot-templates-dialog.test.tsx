// @vitest-environment jsdom
import type { Bot, BotTemplateListing } from "@rakazo/contracts";
import { BOT_TEMPLATE_CHANGED } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bots = vi.hoisted(() => ({
  templates: vi.fn(),
  createFromTemplate: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../../lib/query/rpc", () => {
  const rpc = {
    bots,
    connections: { catalog: vi.fn(async () => []) },
    communityTemplates: { list: vi.fn(async () => []), mine: vi.fn(async () => []) },
  };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
    i18n: { locale: "en" },
  }),
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    Dialog: Box,
    DialogClose: () => null,
    DropdownMenu: Box,
    DropdownMenuContent: Box,
    DropdownMenuItem: ({ onClick, children }: { onClick?: () => void; children?: ReactNode }) => (
      <button type="button" role="menuitem" onClick={onClick}>
        {children}
      </button>
    ),
    DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Input: ({ size: _size, ...props }: ComponentProps<"input"> & { size?: string }) => (
      <input {...props} />
    ),
    DialogContent: Box,
    DialogHeader: Box,
    DialogTitle: Box,
    SectionHeading: Box,
    Spinner: () => <span role="status" />,
  };
});
vi.mock("../integrations/plugin-marketplace", () => ({ PluginLogo: () => null, ROW_HOVER: "" }));

import { useSpaceQueries } from "../../lib/query/query";
import { BotTemplatesPanel } from "./bot-templates-dialog";

const template: BotTemplateListing = {
  id: "weekly-digest",
  version: 3,
  name: "Weekly digest",
  category: "assistant",
  summary: "A summary every Friday",
  sample: "**Friday**",
  description: "",
  instructions: "Summarize the week.",
  skills: [],
  routines: [],
  apps: [],
  botId: null,
};
const made = { id: "bot-new", name: "Weekly digest" } as Bot;

/** Another screen that lists the space's bots. */
function Roster() {
  useQuery(useSpaceQueries().bots.list.queryOptions());
  return null;
}

const onOpenBot = vi.fn();
let container: HTMLDivElement;
let root: Root;
async function render(listed: BotTemplateListing = template) {
  bots.templates.mockResolvedValue([listed]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (open: boolean) => (
    <QueryClientProvider client={client}>
      <Roster />
      {open ? <BotTemplatesPanel onOpenBot={onOpenBot} /> : null}
    </QueryClientProvider>
  );
  await act(async () => root.render(tree(true)));
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="bot-template-card"]')).toBeTruthy(),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="bot-template-card"]')!.click(),
  );
  return { close: () => act(async () => root.render(tree(false))) };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const call of Object.values(bots)) call.mockReset();
  bots.list.mockResolvedValue([]);
  onOpenBot.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(name: string) {
  return [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
}
const back = () => container.querySelector<HTMLButtonElement>('button[aria-label="Back"]');
const alert = () => container.querySelector('[role="alert"]')?.textContent;

it("creates one bot, holds the page meanwhile, reads the bots again, then opens it and stays held", async () => {
  const creating = deferred<{ bot: Bot; created: boolean }>();
  bots.createFromTemplate.mockReturnValue(creating.promise);
  await render();
  await act(async () => {
    button("Create bot")?.click();
    button("Create bot")?.click();
  });
  expect(bots.createFromTemplate.mock.calls).toEqual([
    [{ templateId: "weekly-digest", version: 3, name: "Weekly digest" }],
  ]);
  expect(button("Creating…")?.disabled).toBe(true);
  expect(back()?.disabled).toBe(true);
  expect(onOpenBot).not.toHaveBeenCalled();

  await act(async () => creating.resolve({ bot: made, created: true }));
  await vi.waitFor(() => expect(onOpenBot).toHaveBeenCalledWith(made));
  expect(bots.list).toHaveBeenCalledTimes(2);
  expect(button("Creating…")?.disabled).toBe(true);
});

it("says why the bot was not created and offers the page again", async () => {
  bots.createFromTemplate.mockRejectedValue({ code: "INTERNAL_SERVER_ERROR" });
  await render();
  await act(async () => button("Create bot")?.click());
  expect(alert()).toBe("Could not create the bot");
  expect(button("Create bot")?.disabled).toBe(false);
  expect(back()?.disabled).toBe(false);
  expect(onOpenBot).not.toHaveBeenCalled();
  expect(bots.list).toHaveBeenCalledTimes(1);
});

it("reads the templates again when the one shown has changed", async () => {
  bots.createFromTemplate.mockRejectedValue({ data: { reason: BOT_TEMPLATE_CHANGED } });
  await render();
  await act(async () => button("Create bot")?.click());
  expect(alert()).toBe("This template was just updated. Check it again.");
  expect(bots.templates).toHaveBeenCalledTimes(2);
});

it("opens the bot a template already made, and says when it cannot", async () => {
  bots.get.mockRejectedValueOnce({ code: "INTERNAL_SERVER_ERROR" }).mockResolvedValue(made);
  await render({ ...template, botId: "bot-new" });
  await act(async () => button("Open")?.click());
  expect(alert()).toBe("Could not open the bot");
  expect(button("Open")?.disabled).toBe(false);

  await act(async () => button("Open")?.click());
  expect(bots.get).toHaveBeenLastCalledWith({ botId: "bot-new" });
  expect(onOpenBot).toHaveBeenCalledWith(made);
});

it("does not open a bot that arrives after the templates were closed", async () => {
  const creating = deferred<{ bot: Bot; created: boolean }>();
  bots.createFromTemplate.mockReturnValue(creating.promise);
  const dialog = await render();
  await act(async () => button("Create bot")?.click());
  await dialog.close();
  await act(async () => creating.resolve({ bot: made, created: true }));
  expect(onOpenBot).not.toHaveBeenCalled();
  // The roster still on screen lists the new bot.
  await vi.waitFor(() => expect(bots.list).toHaveBeenCalledTimes(2));
});

describe("the catalog", () => {
  const listing = (
    id: string,
    name: string,
    category: BotTemplateListing["category"],
    summary = "",
  ): BotTemplateListing => ({ ...template, id, name, category, summary });
  const catalog = [
    listing("trip", "Travel planner", "travel", "Flights and stays"),
    listing("fares", "Fare watch", "travel"),
    listing("recap", "Meeting recap", "meetings", "Notes into a recap"),
    listing("diet", "Nutrition coach", "health"),
  ];
  const cards = () =>
    [...container.querySelectorAll('[data-testid="bot-template-card"]')].map(
      (card) => card.querySelector("[id$='-title']")?.textContent,
    );
  async function show(list = catalog) {
    bots.templates.mockResolvedValue(list);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <BotTemplatesPanel onOpenBot={onOpenBot} />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(list.length));
  }
  async function search(text: string) {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("lists the first-party templates under one titled group", async () => {
    await show();
    const groups = container.querySelectorAll('[data-testid="bot-template-group"]');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.textContent).toContain("From Superbot");
  });

  it("searches names, summaries and category names", async () => {
    await show();
    await search("flights");
    expect(cards()).toEqual(["Travel planner"]);
    await search("travel");
    expect(cards()).toEqual(["Travel planner", "Fare watch"]);
    await search("nothing like this");
    expect(cards()).toEqual([]);
    expect(container.textContent).toContain("No agents match");
  });

  it("filters by category, and All shows everything again", async () => {
    await show();
    await act(async () => button("Meetings")?.click());
    expect(cards()).toEqual(["Meeting recap"]);
    expect(button("Meetings")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("All")?.click());
    expect(cards()).toHaveLength(catalog.length);
  });

  it("shows a page of cards at a time", async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      listing(`t${index}`, `Template ${index}`, "assistant"),
    );
    bots.templates.mockResolvedValue(many);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <BotTemplatesPanel onOpenBot={onOpenBot} />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(24));
    await act(async () => button("Show more")?.click());
    expect(cards()).toHaveLength(30);
  });
});
