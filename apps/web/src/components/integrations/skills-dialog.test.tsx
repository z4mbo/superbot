// @vitest-environment jsdom
import type { AgentSkillLibraryEntry } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const agentSkills = vi.hoisted(() => ({
  list: vi.fn(),
  library: vi.fn(),
  create: vi.fn(),
}));
vi.mock("../../lib/query/rpc", () => {
  const rpc = {
    agentSkills,
    capabilities: { list: vi.fn(async () => []) },
    marketplace: {
      catalog: vi.fn(async () => ({ entries: [], unavailableRegistries: [], skippedEntries: 0 })),
    },
  };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: () => null,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
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
    Field: Box,
    FieldLabel: Box,
    Input: ({ size: _size, ...props }: ComponentProps<"input"> & { size?: string }) => (
      <input {...props} />
    ),
    SectionHeading: Box,
    Spinner: () => <span role="status" />,
  };
});
vi.mock("./plugin-marketplace", () => ({
  PluginDetail: () => null,
  PluginLogo: () => null,
  ROW_HOVER: "",
  pluginSelection: () => ({}),
  PluginRow: ({
    name,
    installed,
    onOpen,
  }: {
    name: string;
    installed: boolean;
    onOpen: () => void;
  }) => (
    <button type="button" data-testid="browse-row" onClick={onOpen}>
      {name}
      {installed ? " (added)" : ""}
    </button>
  ),
}));
vi.mock("../../pages/space/KnowledgeSection", () => ({ AgentSkills: () => null }));
vi.mock("../../pages/plugins/community/community-skill-grants", () => ({
  CommunitySkillGrants: () => null,
}));

import { SkillsPanel } from "./skills-dialog";

const skill = (name: string, description: string): AgentSkillLibraryEntry => ({
  name,
  description,
  content: buildSkillMd({ name, description, body: `1. Do ${name}.` }),
});
const LIBRARY = [
  skill("Find flights", "Search and compare flights."),
  skill("Order food", "Order a meal for delivery."),
  skill("Code review", "Review a code change."),
];

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const call of Object.values(agentSkills)) call.mockReset();
  agentSkills.library.mockResolvedValue(LIBRARY);
  agentSkills.list.mockResolvedValue([
    { id: "s1", name: "code review", description: "", source: "user", readOnly: false },
  ]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SkillsPanel />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(rows()).toHaveLength(3));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const rows = () =>
  [...container.querySelectorAll('[data-testid="browse-row"]')].map((row) => row.textContent);
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);

it("lists the first-party skills in Browse and marks the ones already added", () => {
  expect(rows()).toEqual(["Find flights", "Order food", "Code review (added)"]);
});

it("searches the library", async () => {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search skills"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, "deliv");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(rows()).toEqual(["Order food"]);
});

it("adds a library skill as the user's own skill once, then shows it added", async () => {
  const creating = deferred<unknown>();
  agentSkills.create.mockReturnValue(creating.promise);
  await act(async () => button("Find flights")?.click());
  expect(container.querySelector('[data-testid="library-skill-detail"]')?.textContent).toContain(
    "1. Do Find flights.",
  );
  await act(async () => {
    button("Add skill")?.click();
    button("Add skill")?.click();
  });
  expect(agentSkills.create.mock.calls).toEqual([[{ content: LIBRARY[0]!.content }]]);
  expect(button("Adding…")?.disabled).toBe(true);

  agentSkills.list.mockResolvedValue([
    { id: "s2", name: "Find flights", description: "", source: "user", readOnly: false },
  ]);
  await act(async () => creating.resolve({}));
  await vi.waitFor(() => expect(button("Added")?.disabled).toBe(true));
});
