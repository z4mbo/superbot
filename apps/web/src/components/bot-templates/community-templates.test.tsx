// @vitest-environment jsdom
import type {
  Bot,
  BotTemplateListing,
  CommunityTemplateListing,
  CommunityTemplateSubmission,
} from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  bots: { templates: vi.fn(), createFromTemplate: vi.fn(), get: vi.fn(), list: vi.fn() },
  communityTemplates: { list: vi.fn(), mine: vi.fn(), withdraw: vi.fn(), unlist: vi.fn() },
  connections: { catalog: vi.fn(async () => []) },
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
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
    DropdownMenu: Box,
    DropdownMenuContent: Box,
    DropdownMenuItem: Box,
    DropdownMenuTrigger: Box,
    Input: ({
      size: _size,
      ...props
    }: Omit<ComponentProps<"input">, "size"> & { size?: string }) => <input {...props} />,
    SectionHeading: Box,
    Spinner: () => <span role="status" />,
    toast: { error: vi.fn(), success: vi.fn() },
  };
});
vi.mock("../integrations/plugin-marketplace", () => ({ PluginLogo: () => null, ROW_HOVER: "" }));

import { BotTemplatesPanel } from "./bot-templates-dialog";

const recipe = {
  category: "research" as const,
  summary: "What changed on topics you follow",
  sample: "**This week**",
  description: "",
  instructions: "Report only what is new. Never send email.",
  skills: [],
  routines: [{ name: "Weekly digest", prompt: "Send the digest.", crons: ["0 9 * * 1"] }],
  apps: [],
};
const firstParty: BotTemplateListing = {
  ...recipe,
  id: "morning-briefing",
  version: 1,
  name: "Morning briefing",
  category: "assistant",
  summary: "Your day at a glance",
  botId: null,
};
const shared: CommunityTemplateListing = {
  ...recipe,
  id: "topic-digest",
  version: 2,
  name: "Topic digest",
  botId: null,
  author: "Ana Author",
};
const submission = (status: CommunityTemplateSubmission["status"], reason: string | null = null) =>
  ({
    id: `submission-${status}`,
    slug: "topic-digest",
    version: 1,
    status,
    reason,
    recipe: { ...recipe, name: `Digest ${status}` },
    author: "Ana Author",
    createdAt: "2026-11-01T00:00:00.000Z",
    reviewedAt: null,
  }) satisfies CommunityTemplateSubmission;

let container: HTMLDivElement;
let root: Root;
const onOpenBot = vi.fn();

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <BotTemplatesPanel onOpenBot={onOpenBot} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(cards()).toHaveLength(2));
}

const cards = () => [...container.querySelectorAll('[data-testid="bot-template-card"]')];
const groups = () =>
  [...container.querySelectorAll('[data-testid="bot-template-group"]')].map((group) => ({
    title: group.firstElementChild?.textContent,
    cards: [...group.querySelectorAll('[data-testid="bot-template-card"]')].map(
      (card) => card.textContent,
    ),
  }));
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const group of [api.bots, api.communityTemplates]) {
    for (const call of Object.values(group)) call.mockReset();
  }
  api.bots.templates.mockResolvedValue([firstParty]);
  api.bots.list.mockResolvedValue([]);
  api.communityTemplates.list.mockResolvedValue([shared]);
  api.communityTemplates.mine.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("lists shared templates as a Community group with their author, searched and filtered with the rest", async () => {
  await render();
  expect(groups()).toEqual([
    { title: "From Superbot", cards: [expect.stringContaining("Morning briefing")] },
    { title: "Community", cards: [expect.stringContaining("Shared by Ana Author")] },
  ]);

  await act(async () => button("Research")!.click());
  expect(groups().map((group) => group.title)).toEqual(["Community"]);
  await act(async () => button("All")!.click());

  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(search, "morning");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(groups().map((group) => group.title)).toEqual(["From Superbot"]);
});

it("shows who wrote a community template and its full instructions before creating it", async () => {
  api.bots.createFromTemplate.mockResolvedValue({ bot: { id: "bot-1" } as Bot, created: true });
  await render();
  await act(async () => (cards()[1] as HTMLButtonElement).click());

  const detail = container.querySelector('[data-testid="bot-template-detail"]')!;
  expect(detail.querySelector('[data-testid="bot-template-author"]')?.textContent).toBe(
    "Shared by Ana Author",
  );
  expect(detail.textContent).toContain("Report only what is new. Never send email.");

  await act(async () => button("Create bot")!.click());
  await vi.waitFor(() => expect(onOpenBot).toHaveBeenCalledOnce());
  expect(api.bots.createFromTemplate).toHaveBeenCalledWith({
    templateId: "topic-digest",
    version: 2,
    name: "Topic digest",
  });
});

it("names a community template without a public author plainly", async () => {
  api.communityTemplates.list.mockResolvedValue([{ ...shared, author: null }]);
  await render();
  expect(cards()[1]?.textContent).toContain("Shared by a community member");
});

it("shows the user's own submissions with their status, and withdraws or unlists them", async () => {
  api.communityTemplates.mine.mockResolvedValue([
    submission("pending"),
    submission("approved"),
    submission("rejected", "Add a real example."),
    submission("withdrawn"),
  ]);
  api.communityTemplates.withdraw.mockResolvedValue(submission("withdrawn"));
  api.communityTemplates.unlist.mockResolvedValue(submission("unlisted"));
  await render();
  const mine = await vi.waitFor(() => {
    const list = container.querySelector('[data-testid="my-shared-templates"]');
    expect(list).toBeTruthy();
    return list!;
  });
  const rows = [...mine.querySelectorAll("li")].map((row) => row.getAttribute("aria-label"));
  expect(rows).toEqual(["Digest pending", "Digest approved", "Digest rejected"]);
  expect(mine.textContent).toContain("Waiting for review");
  expect(mine.textContent).toContain("Add a real example.");

  await act(async () => button("Withdraw")!.click());
  await vi.waitFor(() =>
    expect(api.communityTemplates.withdraw).toHaveBeenCalledWith({ id: "submission-pending" }),
  );
  await vi.waitFor(() => expect(button("Unlist")?.disabled).toBe(false));
  await act(async () => button("Unlist")!.click());
  await vi.waitFor(() =>
    expect(api.communityTemplates.unlist).toHaveBeenCalledWith({ id: "submission-approved" }),
  );
});

it("shows nothing of its own until the user has shared one", async () => {
  await render();
  expect(container.querySelector('[data-testid="my-shared-templates"]')).toBeNull();
});
