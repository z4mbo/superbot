// @vitest-environment jsdom
import { deferred, flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  RegistryAppRecord,
  RegistryInstallation,
  RegistryVersion,
  SubmitInput,
} from "./registry";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  bots: { list: vi.fn() },
  connections: { catalog: vi.fn(), list: vi.fn(), tools: vi.fn() },
  capabilities: { list: vi.fn(), catalogSearch: vi.fn(), sourcePresets: vi.fn() },
  mcp: { servers: { list: vi.fn() }, assignments: { list: vi.fn() } },
  marketplace: { catalog: vi.fn(), preview: vi.fn() },
  apps: { catalog: vi.fn(), installed: vi.fn() },
  pluginRegistry: {
    discover: vi.fn(),
    installations: vi.fn(),
    install: vi.fn(),
    switchVersion: vi.fn(),
    setGrants: vi.fn(),
    uninstall: vi.fn(),
    mine: vi.fn(),
    submit: vi.fn(),
    submissions: vi.fn(),
    review: vi.fn(),
    appRecords: vi.fn(),
    addAppRecord: vi.fn(),
    removeAppRecord: vi.fn(),
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

import { CommunitySkillGrants } from "./community-skill-grants";
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
  api.connections.catalog.mockReset().mockResolvedValue([]);
  api.connections.list.mockReset().mockResolvedValue([]);
  api.capabilities.list.mockReset().mockResolvedValue([]);
  api.capabilities.catalogSearch.mockReset().mockResolvedValue({ enabled: false, results: [] });
  api.capabilities.sourcePresets.mockReset().mockResolvedValue([]);
  api.mcp.servers.list.mockReset().mockResolvedValue([]);
  api.mcp.assignments.list.mockReset().mockResolvedValue([]);
  api.apps.catalog.mockReset().mockResolvedValue([]);
  api.apps.installed.mockReset().mockResolvedValue([]);
  api.marketplace.catalog
    .mockReset()
    .mockResolvedValue({ entries: [], unavailableRegistries: [], skippedEntries: 0 });
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
    container.querySelector<HTMLInputElement>('[aria-label="Search apps"]')!;
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
  expect(container.textContent).toContain("No apps match your search.");
  expect(container.contains(searchAgain)).toBe(true);
});

it("lists reviewed page apps above the community results and opens one", async () => {
  const listing = {
    releaseId: "release-1",
    appId: "kcal-diary",
    name: "Kcal diary",
    description: "Calories per day",
    version: "1.0.0",
    icon: null,
    permissions: [],
    digest: "sha256-test",
  };
  api.apps.catalog.mockImplementation(async (input: { query: string }) =>
    "kcal diary".includes(input.query.toLowerCase()) ? [listing] : [],
  );
  await render();
  const section = container.querySelector('[data-testid="app-section"]')!;
  expect(section.textContent).toContain("Kcal diary");
  expect(
    section.compareDocumentPosition(container.querySelector('[data-testid="community-results"]')!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  await click(button("Add", section as HTMLElement));
  expect(container.querySelector('[data-testid="app-detail"]')?.textContent).toContain(
    "Kcal diary",
  );
  await click(button("Back"));
  expect(container.querySelector('[data-testid="app-section"]')).not.toBeNull();
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
  api.pluginRegistry.switchVersion.mockImplementation(async () => {
    installs = [{ ...installation([]), plugin: converter2 }];
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
  expect(api.pluginRegistry.switchVersion).not.toHaveBeenCalled();

  await click(button("Remove access from 1 bot"));
  expect(api.pluginRegistry.switchVersion).toHaveBeenCalledExactlyOnceWith({
    installationId: "install-1",
    expectedVersionId: converter1.id,
    versionId: converter2.id,
  });
  expect(api.pluginRegistry.uninstall).not.toHaveBeenCalled();
  expect(api.pluginRegistry.install).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Version 2 installed");
});

const diaryApp = {
  id: "diary",
  kind: "app" as const,
  fields: [
    { id: "food", label: "Food", type: "text" as const, required: true },
    { id: "kcal", label: "Calories (kcal)", type: "number" as const, required: true },
    { id: "date", label: "Date", type: "date" as const, required: true },
    { id: "note", label: "Note", type: "text" as const, required: false },
  ],
  summaryField: "kcal",
};
const diary: RegistryVersion = {
  ...release("kcal-diary", 1, "Kcal diary"),
  manifest: {
    schemaVersion: 1,
    name: "Kcal diary",
    description: "Calories per day",
    parts: [diaryApp],
  },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function localDay(offset = 0) {
  const day = new Date();
  day.setDate(day.getDate() + offset);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function labelled(text: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find((element) =>
    element.textContent?.startsWith(text),
  );
  if (!label) throw new Error(`No field ${text}`);
  return document.getElementById(label.htmlFor) as HTMLInputElement;
}

function useDiaryRecords() {
  let records: RegistryAppRecord[] = [];
  api.pluginRegistry.appRecords.mockImplementation(async (input: { date?: string }) => {
    const items = records.filter((row) => !input.date || row.values.date === input.date);
    return {
      items,
      nextAfter: null,
      total: items.reduce((sum, row) => sum + Number(row.values.kcal), 0),
    };
  });
  api.pluginRegistry.addAppRecord.mockImplementation(
    async (input: { operationId: string; values: RegistryAppRecord["values"] }) => {
      const record = {
        id: `00000000-0000-4000-8000-00000000000${records.length + 1}`,
        values: input.values,
        createdAt: "2026-11-20T08:00:00.000Z",
      };
      records = [record, ...records];
      return record;
    },
  );
  api.pluginRegistry.removeAppRecord.mockImplementation(async (input: { recordId: string }) => {
    records = records.filter((row) => row.id !== input.recordId);
    return { ok: true };
  });
}

async function openInstalledDiary() {
  installs = [{ id: "install-app", plugin: diary, grants: [], createdAt: diary.createdAt }];
  await render();
  const installedTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) =>
    tab.textContent?.startsWith("Installed"),
  )!;
  await click(installedTab);
  await click(button("Open Kcal diary"));
}

it("lets a member add, total, filter and remove entries in an installed app", async () => {
  useDiaryRecords();
  await openInstalledDiary();
  const target = { installationId: "install-app", partId: "diary" };
  expect(api.pluginRegistry.appRecords).toHaveBeenLastCalledWith(
    { ...target, limit: 20, date: localDay() },
    expect.anything(),
  );
  expect(container.textContent).toContain("No entries on this day.");
  expect(labelled("Date").value).toBe(localDay());
  expect(labelled("Note").required).toBe(false);
  expect(labelled("Food").required).toBe(true);

  await click(button("Add entry"));
  expect(api.pluginRegistry.addAppRecord).not.toHaveBeenCalled();
  expect(labelled("Food").getAttribute("aria-invalid")).toBe("true");
  expect(container.textContent).toContain("Enter Food.");
  expect(document.activeElement).toBe(labelled("Food"));

  await type(labelled("Food"), "Oats");
  await type(labelled("Calories (kcal)"), "350.5");
  await click(button("Add entry"));
  expect(api.pluginRegistry.addAppRecord).toHaveBeenCalledExactlyOnceWith({
    ...target,
    operationId: expect.stringMatching(UUID),
    values: { food: "Oats", kcal: 350.5, date: localDay() },
  });
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="community-app-total"]')?.textContent).toContain(
      "350.5",
    ),
  );
  expect(labelled("Food").value).toBe("");
  const rows = () => [...container.querySelectorAll('[data-testid="community-app-record"]')];
  expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["Oats"]);

  await type(labelled("Food"), "Soup");
  await type(labelled("Calories (kcal)"), "200");
  await type(labelled("Date"), localDay(-1));
  await click(button("Add entry"));
  const [firstOperation, secondOperation] = api.pluginRegistry.addAppRecord.mock.calls.map(
    ([input]) => (input as { operationId: string }).operationId,
  );
  expect(secondOperation).not.toBe(firstOperation);
  await vi.waitFor(() =>
    expect(api.pluginRegistry.appRecords).toHaveBeenLastCalledWith(
      { ...target, limit: 20, date: localDay(-1) },
      expect.anything(),
    ),
  );
  await vi.waitFor(() =>
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["Soup"]),
  );

  await click(button("All dates"));
  expect(api.pluginRegistry.appRecords).toHaveBeenLastCalledWith(
    { ...target, limit: 20 },
    expect.anything(),
  );
  await vi.waitFor(() => expect(rows()).toHaveLength(2));
  expect(container.querySelector('[data-testid="community-app-total"]')?.textContent).toContain(
    "550.5",
  );

  await click(button("Remove Soup"));
  expect(api.pluginRegistry.removeAppRecord).not.toHaveBeenCalled();
  await click(button("Remove"));
  expect(api.pluginRegistry.removeAppRecord).toHaveBeenCalledExactlyOnceWith({
    ...target,
    recordId: "00000000-0000-4000-8000-000000000002",
  });
  await vi.waitFor(() =>
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["Oats"]),
  );
});

it("warns that uninstalling an app deletes its entries and opens it from its page", async () => {
  useDiaryRecords();
  installs = [{ id: "install-app", plugin: diary, grants: [], createdAt: diary.createdAt }];
  api.pluginRegistry.discover.mockResolvedValue({ items: [diary], nextAfter: null });
  await render();
  await click(button("Added"));
  const part = container.querySelector('[data-testid="community-part"]')!;
  expect(part.textContent).toContain("App: Food, Calories (kcal), Date, Note");

  await click(button("Uninstall"));
  expect(container.textContent).toContain(
    "Uninstalling permanently deletes your entries in this app.",
  );
  await click(button("Cancel"));
  await click(button("Open", part));
  expect(container.querySelector('[data-testid="community-app"]')).not.toBeNull();
  await click(button("Back"));
  expect(container.querySelector('[data-testid="community-plugin-detail"]')).not.toBeNull();
});

it("starts an app from the calorie diary example or a published plugin", async () => {
  api.pluginRegistry.discover.mockResolvedValue({ items: [diary], nextAfter: null });
  api.pluginRegistry.submit.mockImplementation(async (input: SubmitInput) => ({
    ...diary,
    ...input,
    status: "pending",
  }));
  await render();
  await click(container.querySelector<HTMLElement>('[data-testid="community-create-tab"]')!);
  await click(
    container.querySelector<HTMLElement>('[data-testid="community-example-calorie-diary"]')!,
  );
  expect(container.querySelector<HTMLInputElement>("#community-slug")!.value).toBe("calorie-diary");
  expect(container.querySelectorAll('[data-testid="community-app-field-editor"]')).toHaveLength(3);

  await click(button("Add field"));
  const labels = [...container.querySelectorAll<HTMLInputElement>('input[id$="-label"]')];
  await type(labels.at(-1)!, "Protein (g)");
  const ids = [...container.querySelectorAll<HTMLInputElement>('input[id$="-id"]')];
  expect(ids.at(-1)!.value).toBe("protein-g");

  await click(button("Submit for review"));
  expect(api.pluginRegistry.submit).toHaveBeenCalledExactlyOnceWith({
    slug: "calorie-diary",
    version: 1,
    manifest: {
      schemaVersion: 1,
      name: "Calorie diary",
      description: "Log meals and see the total calories for a day.",
      parts: [
        {
          id: "meals",
          kind: "app",
          fields: [
            { id: "date", label: "Date", type: "date", required: true },
            { id: "meal", label: "Meal", type: "text", required: true },
            { id: "kcal", label: "Calories (kcal)", type: "number", required: true },
            { id: "protein-g", label: "Protein (g)", type: "text", required: true },
          ],
          summaryField: "kcal",
        },
      ],
    },
  });

  const discoverTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (tab) => tab.textContent === "Discover",
  )!;
  await click(discoverTab);
  await click(button("Add"));
  await click(button("Use as template"));
  expect(container.querySelector<HTMLInputElement>("#community-name")!.value).toBe("Kcal diary");
  expect(container.querySelector<HTMLInputElement>("#community-slug")!.value).toBe("my-kcal-diary");
  expect(container.querySelectorAll('[data-testid="community-app-field-editor"]')).toHaveLength(4);
});

it("keeps what a member types while the previous entry is still saving", async () => {
  useDiaryRecords();
  const answer = deferred();
  const save = api.pluginRegistry.addAppRecord.getMockImplementation()!;
  api.pluginRegistry.addAppRecord.mockImplementationOnce(async (input) => {
    await answer.promise;
    return save(input);
  });
  await openInstalledDiary();
  await type(labelled("Food"), "Oats");
  await type(labelled("Calories (kcal)"), "350");
  await act(async () => button("Add entry").click());
  await type(labelled("Food"), "Soup");
  await act(async () => answer.resolve());
  await settle();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="community-app-total"]')?.textContent).toContain(
      "350",
    ),
  );
  expect(labelled("Food").value).toBe("Soup");
});

it("lists marketplace packages beside community entries and searches both", async () => {
  api.marketplace.catalog.mockResolvedValue({
    entries: [
      {
        id: "weather-kit",
        name: "weather-kit",
        displayName: "Weather kit",
        description: "Weather kit for tests",
        keywords: [],
        category: "data",
        logo: null,
        homepage: null,
        domains: [],
        registry: "fixture",
        source: "https://example.test/weather-kit",
        installedSource: "https://example.test/weather-kit",
        hasConnector: true,
        skillCount: 1,
      },
      {
        id: "style-guide",
        name: "style-guide",
        displayName: "Style guide",
        description: "Style guide for tests",
        keywords: [],
        category: null,
        logo: null,
        homepage: null,
        domains: [],
        registry: "fixture",
        source: "https://example.test/style-guide",
        installedSource: "https://example.test/style-guide",
        hasConnector: false,
        skillCount: 3,
      },
    ],
    unavailableRegistries: [],
    skippedEntries: 0,
  });
  api.capabilities.list.mockResolvedValue([
    {
      id: "install-style",
      kind: "plugin",
      name: "style-guide",
      source: "https://example.test/style-guide",
      config: {},
      availability: { mode: "current" },
    },
  ]);
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Weather kit"));
  const sections = [...container.querySelectorAll('[data-testid="plugin-section"]')].map(
    (section) => section.querySelector("h2")?.textContent,
  );
  expect(sections).toEqual(["Data", "More"]);
  expect(container.querySelector('[data-testid="community-results"]')?.textContent).toContain(
    "Unit converter",
  );

  vi.useFakeTimers();
  try {
    await type(container.querySelector<HTMLInputElement>('[aria-label="Search apps"]')!, "weather");
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await act(async () => vi.advanceTimersByTimeAsync(0));
  } finally {
    vi.useRealTimers();
  }
  await act(flush);
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="plugin-results"]')?.textContent).toContain(
      "Weather kit",
    ),
  );
  expect(container.querySelector('[data-testid="plugin-results"]')?.textContent).toContain(
    "Weather kit",
  );
  expect(container.querySelector('[data-testid="plugin-results"]')?.textContent).not.toContain(
    "Style guide",
  );

  const installedTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) =>
    tab.textContent?.startsWith("Installed"),
  )!;
  expect(installedTab.textContent).toBe("Installed1");
  await click(installedTab);
  const installedPackage = container.querySelector('[data-testid="package-installed-row"]')!;
  expect(installedPackage.textContent).toContain("Style guide");
});

it("lets a member allow one community skill for one agent from Skills", async () => {
  installs = [installation([{ botId: "bot-2", partId: "conversion-guide" }])];
  api.pluginRegistry.setGrants.mockImplementation(
    async (input: { botId: string; partIds: string[] }) => {
      installs = [
        installation([
          { botId: "bot-2", partId: "conversion-guide" },
          ...input.partIds.map((partId) => ({ botId: input.botId, partId })),
        ]),
      ];
      return installs[0];
    },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CommunitySkillGrants activeBotId="bot-1" />
      </QueryClientProvider>,
    );
  });
  await settle();
  const toggle = () =>
    container.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Allow conversion-guide for Ada"]',
    );
  await vi.waitFor(() => expect(toggle()).not.toBeNull());
  expect(container.querySelectorAll('[data-testid="community-skill-grant"]')).toHaveLength(1);
  expect(toggle()!.getAttribute("aria-checked")).toBe("false");

  await click(toggle()!);
  expect(api.pluginRegistry.setGrants).toHaveBeenCalledExactlyOnceWith({
    installationId: "install-1",
    botId: "bot-1",
    partIds: ["conversion-guide"],
  });
  await vi.waitFor(() => expect(toggle()!.getAttribute("aria-checked")).toBe("true"));
});
