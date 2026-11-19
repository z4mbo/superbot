// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RegistryInstallation, RegistryVersion } from "./registry";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  bots: { list: vi.fn() },
  pluginRegistry: {
    discover: vi.fn(),
    installations: vi.fn(),
    install: vi.fn(),
    setGrants: vi.fn(),
    uninstall: vi.fn(),
    mine: vi.fn(),
    submit: vi.fn(),
    submissions: vi.fn(),
    review: vi.fn(),
  },
}));

vi.mock("../../../lib/query/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));

import { CommunityStore } from "./community-store";

function release(slug: string, number: number, name: string): RegistryVersion {
  return {
    id: `${slug}-v${number}`,
    slug,
    version: number,
    manifest: {
      schemaVersion: 1,
      name,
      description: `${name} for tests`,
      parts: [
        {
          id: "temperatures",
          kind: "mcp",
          transport: "streamable_http",
          endpoint: "https://units.example.test/mcp",
        },
        { id: "conversion-guide", kind: "skill", instructions: "Report both units." },
      ],
    },
    status: "approved",
    reason: null,
    createdAt: `2026-11-0${number}T00:00:00.000Z`,
    reviewedAt: `2026-11-0${number}T01:00:00.000Z`,
  };
}

const converter1 = release("unit-converter", 1, "Unit converter");
const converter2 = release("unit-converter", 2, "Unit converter");
const notes = release("release-notes", 1, "Release notes");
const bot = (id: string, name: string) => ({ id, name });

let container: HTMLDivElement;
let root: Root;
let installs: RegistryInstallation[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installs = [];
  api.me.mockReset().mockResolvedValue({ isAdmin: false });
  api.bots.list.mockReset().mockResolvedValue([bot("bot-1", "Ada"), bot("bot-2", "Max")]);
  const registry = api.pluginRegistry;
  for (const fn of Object.values(registry)) fn.mockReset();
  registry.discover.mockImplementation(async (input: { slug?: string }) => ({
    items: [converter1, notes, converter2].filter((row) => !input.slug || row.slug === input.slug),
    nextAfter: null,
  }));
  registry.installations.mockImplementation(async () => ({ items: installs, nextAfter: null }));
  registry.mine.mockResolvedValue({ items: [], nextAfter: null });
  registry.submissions.mockResolvedValue({ items: [], nextAfter: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CommunityStore activeBotId="bot-1" onBack={() => undefined} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function settle() {
  await act(async () => {
    await vi.waitFor(() => {
      if (container.querySelector('[role="status"][aria-label="Loading…"], [aria-busy="true"]'))
        throw new Error("still loading");
    });
  });
}

function button(name: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === name || element.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function installation(grants: RegistryInstallation["grants"]): RegistryInstallation {
  return { id: "install-1", plugin: converter1, grants, createdAt: "2026-11-03T00:00:00.000Z" };
}

it("lists the newest approved version of each plugin and installs the one shown", async () => {
  api.pluginRegistry.install.mockImplementation(async ({ versionId }: { versionId: string }) => {
    installs = [{ ...installation([]), plugin: versionId === converter2.id ? converter2 : notes }];
    return installs[0];
  });
  await render();

  const rows = [...container.querySelectorAll('[data-testid="plugin-row"]')];
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("Release notes"),
    expect.stringContaining("Unit converter"),
  ]);

  await click(button("Add", rows[1] as HTMLElement));
  const detail = container.querySelector('[data-testid="community-plugin-detail"]')!;
  expect(detail.textContent).toContain("unit-converterVersion 2");
  const parts = [...detail.querySelectorAll('[data-testid="community-part"]')];
  expect(parts.map((part) => part.getAttribute("aria-label"))).toEqual([
    "temperatures",
    "conversion-guide",
  ]);
  expect(parts[0]!.textContent).toContain("Tools at https://units.example.test/mcp");
  expect(detail.querySelector('[role="switch"]')).toBeNull();

  await click(parts[1]!.querySelector<HTMLElement>("[aria-expanded]")!);
  expect(detail.querySelector("pre")?.textContent).toBe("Report both units.");

  await click(button("Install"));
  expect(api.pluginRegistry.install).toHaveBeenCalledExactlyOnceWith({ versionId: converter2.id });
  expect(button("Uninstall")).toBeTruthy();
  expect(detail.querySelectorAll('[role="switch"]')).toHaveLength(2);
});

it("finds releases beyond loaded pages and keeps search cursors and versions scoped", async () => {
  api.pluginRegistry.discover.mockImplementation(
    async (input: { slug?: string; query?: string; after?: string }) => {
      if (input.slug === converter1.slug)
        return { items: [converter1, converter2], nextAfter: null };
      if (input.query === "old converter") {
        return input.after
          ? { items: [converter1], nextAfter: null }
          : { items: [notes], nextAfter: "search-cursor" };
      }
      return {
        items: input.query ? [] : [notes],
        nextAfter: input.query || input.after ? null : "catalog-cursor",
      };
    },
  );
  api.pluginRegistry.install.mockResolvedValue(installation([]));
  await render();
  const searchInput = () =>
    container.querySelector<HTMLInputElement>('[aria-label="Search community plugins"]')!;
  async function searchFor(text: string) {
    vi.useFakeTimers();
    try {
      await type(searchInput(), text);
      await act(async () => vi.advanceTimersByTimeAsync(200));
      await act(async () => vi.advanceTimersByTimeAsync(0));
    } finally {
      vi.useRealTimers();
    }
    await act(flush);
  }
  expect(container.textContent).not.toContain("Unit converter");
  await click(button("Show more"));
  expect(api.pluginRegistry.discover).toHaveBeenLastCalledWith(
    { limit: 50, after: "catalog-cursor" },
    expect.anything(),
  );

  await searchFor(" old converter ");
  await vi.waitFor(() =>
    expect(api.pluginRegistry.discover).toHaveBeenLastCalledWith(
      { limit: 50, query: "old converter" },
      expect.anything(),
    ),
  );
  await settle();
  await click(button("Show more"));
  expect(api.pluginRegistry.discover).toHaveBeenLastCalledWith(
    { limit: 50, query: "old converter", after: "search-cursor" },
    expect.anything(),
  );

  await act(flush);
  const converter = [...container.querySelectorAll<HTMLElement>('[data-testid="plugin-row"]')].find(
    (row) => row.textContent?.includes("Unit converter"),
  );
  expect(converter).toBeDefined();
  await click(button("Add", converter));
  await act(flush);
  expect(api.pluginRegistry.discover).toHaveBeenLastCalledWith(
    { limit: 50, slug: converter1.slug, after: undefined },
    expect.anything(),
  );
  expect(container.textContent).toContain("unit-converterVersion 1");
  await click(button("Install"));
  expect(api.pluginRegistry.install).toHaveBeenCalledExactlyOnceWith({ versionId: converter1.id });
  await click(button("Back"));

  const searchAgain = searchInput();
  await searchFor("unavailable");
  await vi.waitFor(() =>
    expect(api.pluginRegistry.discover).toHaveBeenLastCalledWith(
      { limit: 50, query: "unavailable" },
      expect.anything(),
    ),
  );
  await settle();
  expect(container.textContent).toContain("No community plugins match your search.");
  expect(container.contains(searchAgain)).toBe(true);
});

it("grants and revokes one part for the open bot only", async () => {
  installs = [installation([{ botId: "bot-2", partId: "temperatures" }])];
  api.pluginRegistry.setGrants.mockImplementation(
    async (input: { botId: string; partIds: string[] }) => {
      const others = installs[0]!.grants.filter((grant) => grant.botId !== input.botId);
      installs = [
        installation([
          ...others,
          ...input.partIds.map((partId) => ({ botId: input.botId, partId })),
        ]),
      ];
      return installs[0];
    },
  );
  await render();

  await click(button("Installed1"));
  const row = container.querySelector('[data-testid="community-installed-row"]')!;
  expect(row.textContent).toContain("Version 1Allowed for Max");
  await click(button("Manage", row as HTMLElement));

  const allow = container.querySelector<HTMLElement>('[aria-label="Allow temperatures"]')!;
  expect(allow.getAttribute("aria-checked")).toBe("false");
  await click(allow);
  expect(api.pluginRegistry.setGrants).toHaveBeenLastCalledWith({
    installationId: "install-1",
    botId: "bot-1",
    partIds: ["temperatures"],
  });
  expect(
    container.querySelector('[aria-label="Allow temperatures"]')?.getAttribute("aria-checked"),
  ).toBe("true");

  await click(container.querySelector<HTMLElement>('[aria-label="Allow temperatures"]')!);
  expect(api.pluginRegistry.setGrants).toHaveBeenLastCalledWith({
    installationId: "install-1",
    botId: "bot-1",
    partIds: [],
  });
});

it("asks before uninstalling a plugin bots still use", async () => {
  installs = [installation([{ botId: "bot-1", partId: "conversion-guide" }])];
  api.pluginRegistry.uninstall.mockImplementation(async () => {
    installs = [];
    return { ok: true };
  });
  await render();
  await click(button("Installed1"));
  await click(button("Manage"));
  expect(container.textContent).toContain("unit-converterVersion 1 installed");

  await click(button("Uninstall"));
  expect(api.pluginRegistry.uninstall).not.toHaveBeenCalled();
  await click(button("Remove access from 1 bot"));
  expect(api.pluginRegistry.uninstall).toHaveBeenCalledExactlyOnceWith({
    installationId: "install-1",
  });
  expect(button("Install")).toBeTruthy();
});

it("checks a draft against the registry contract before sending it for review", async () => {
  const pending = { ...release("standup-notes", 1, "Standup notes"), status: "pending" as const };
  const rejected = {
    ...release("standup-notes", 1, "Standup notes"),
    id: "old",
    status: "rejected" as const,
    reason: "Describe the endpoint's data use.",
  };
  api.pluginRegistry.mine.mockResolvedValue({ items: [rejected], nextAfter: null });
  api.pluginRegistry.submit.mockImplementation(async () => {
    api.pluginRegistry.mine.mockResolvedValue({ items: [rejected, pending], nextAfter: null });
    return pending;
  });
  await render();
  await click(container.querySelector<HTMLElement>('[data-testid="community-create-tab"]')!);

  const mine = container.querySelector('[data-testid="community-mine"]')!;
  expect(mine.textContent).toContain("Rejected");
  expect(mine.textContent).toContain("Describe the endpoint's data use.");

  await type(container.querySelector<HTMLInputElement>("#community-name")!, "Standup notes");
  expect(container.querySelector<HTMLInputElement>("#community-slug")!.value).toBe("standup-notes");
  expect(container.querySelector<HTMLInputElement>("#community-version-input")!.value).toBe("2");
  await type(
    container.querySelector<HTMLTextAreaElement>("#community-description")!,
    "Turns notes into a standup.",
  );

  await click(button("Submit for review"));
  expect(api.pluginRegistry.submit).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Add instructions of up to 16,000 characters.");

  const instructions = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="community-part-editor"] textarea',
  )!;
  await type(instructions, "List what changed since yesterday.");
  await click(button("Check"));
  expect(container.textContent).toContain("Ready to submit");

  await click(button("Submit for review"));
  expect(api.pluginRegistry.submit).toHaveBeenCalledExactlyOnceWith({
    slug: "standup-notes",
    version: 2,
    manifest: {
      schemaVersion: 1,
      name: "Standup notes",
      description: "Turns notes into a standup.",
      parts: [{ id: "skill", kind: "skill", instructions: "List what changed since yesterday." }],
    },
  });
  await vi.waitFor(() =>
    expect(container.querySelectorAll('[data-testid="community-submission"]')).toHaveLength(2),
  );
  expect(mine.textContent).toContain("In review");
  expect(container.querySelector<HTMLInputElement>("#community-name")!.value).toBe("");
});

it("refuses an MCP endpoint the registry would refuse", async () => {
  await render();
  await click(container.querySelector<HTMLElement>('[data-testid="community-create-tab"]')!);
  await type(container.querySelector<HTMLInputElement>("#community-name")!, "Tracker");
  await type(container.querySelector<HTMLTextAreaElement>("#community-description")!, "Tracks.");
  await click(button("Add MCP tools"));
  await click(button("Remove part 1"));
  await type(
    container.querySelector<HTMLInputElement>(
      '[data-testid="community-part-editor"] input[inputmode="url"]',
    )!,
    "https://tracker.example.test/mcp?token=secret",
  );
  await click(button("Submit for review"));
  expect(api.pluginRegistry.submit).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    "Use a public HTTPS URL with no credentials, query string or fragment.",
  );
});

it("shows the review queue to deployment admins only", async () => {
  await render();
  expect(() => button("Review")).toThrow();
  await act(async () => root.unmount());

  root = createRoot(container);
  api.me.mockResolvedValue({ isAdmin: true });
  const submitted = { ...release("standup-notes", 1, "Standup notes"), status: "pending" as const };
  api.pluginRegistry.submissions.mockResolvedValue({ items: [submitted], nextAfter: null });
  api.pluginRegistry.review.mockResolvedValue({ ...submitted, status: "approved" });
  await render();
  await click(button("Review"));
  const item = container.querySelector('[data-testid="community-review-item"]')!;
  expect(item.textContent).toContain("standup-notesVersion 1");
  expect(item.textContent).toContain("Tools at https://units.example.test/mcp");
  expect(api.pluginRegistry.submissions).toHaveBeenCalledWith(
    { status: "pending", limit: 50 },
    expect.anything(),
  );
  await click(button("Approve", item as HTMLElement));
  expect(api.pluginRegistry.review).toHaveBeenCalledExactlyOnceWith({
    versionId: submitted.id,
    decision: "approved",
  });
});

it("switches a pinned install to another approved version only after confirming", async () => {
  installs = [installation([{ botId: "bot-1", partId: "temperatures" }])];
  api.pluginRegistry.uninstall.mockImplementation(async () => {
    installs = [];
    return { ok: true };
  });
  api.pluginRegistry.install.mockImplementation(async () => {
    installs = [{ ...installation([]), id: "install-2", plugin: converter2 }];
    return installs[0];
  });
  await render();
  await click(button("Installed1"));
  await click(button("Manage"));
  expect(container.textContent).toContain("Version 1 installed");

  const trigger = await vi.waitFor(() => {
    const found = container.querySelector<HTMLElement>('[data-testid="community-version"]');
    if (!found) throw new Error("versions still loading");
    return found;
  });
  await click(trigger);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
    element.textContent?.includes("Version 2 (latest)"),
  )!;
  await click(option);
  await click(button("Switch to version 2"));
  expect(api.pluginRegistry.uninstall).not.toHaveBeenCalled();

  await click(button("Remove access from 1 bot"));
  expect(api.pluginRegistry.uninstall).toHaveBeenCalledExactlyOnceWith({
    installationId: "install-1",
  });
  expect(api.pluginRegistry.install).toHaveBeenCalledExactlyOnceWith({ versionId: converter2.id });
  expect(container.textContent).toContain("Version 2 installed");
});
