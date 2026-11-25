// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectionsSection } from "./connections-section";
import { SourceFormView, useSourceForm } from "./source-form";

const api = vi.hoisted(() => ({
  connections: {
    catalog: vi.fn(),
    list: vi.fn(),
    tools: vi.fn(),
  },
  capabilities: { list: vi.fn(), catalogSearch: vi.fn(), sourcePresets: vi.fn() },
  mcp: { servers: { list: vi.fn() }, assignments: { list: vi.fn() } },
  marketplace: { catalog: vi.fn() },
  apps: { catalog: vi.fn(), installed: vi.fn() },
  pluginRegistry: { discover: vi.fn(), installations: vi.fn() },
}));

vi.mock("../../lib/query/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("../../lib/integrations/mcp-connect", () => ({ connectMcpOauth: vi.fn() }));
vi.mock("../../components/integrations/space-availability", () => ({
  AvailabilityControl: () => null,
  AvailabilityLabel: () => null,
  reachesOtherSpaces: () => false,
  useOwnSpaces: () => [],
}));
vi.mock("@lingui/react/macro", () => ({
  Plural: () => null,
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + (i ? String(values[i - 1]) : "") + part, ""),
  }),
}));
vi.mock("@rakazo/ui-web", async () => {
  const { createElement } = await import("react");
  const container = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return Object.fromEntries([
    ...[
      "Badge",
      "Dialog",
      "DialogClose",
      "DialogContent",
      "DialogHeader",
      "DialogTitle",
      "Disclosure",
      "DropdownMenu",
      "DropdownMenuContent",
      "DropdownMenuItem",
      "DropdownMenuSeparator",
      "DropdownMenuTrigger",
      "Field",
      "FieldDescription",
      "FieldLabel",
      "OptionSelect",
      "SectionHeading",
      "Spinner",
    ].map((name) => [name, container]),
    [
      "Button",
      ({
        children,
        onClick,
        disabled,
        type,
        "aria-label": label,
      }: {
        children?: ReactNode;
        onClick?: () => void;
        disabled?: boolean;
        type?: "button" | "submit";
        "aria-label"?: string;
      }) =>
        createElement(
          "button",
          { type: type ?? "button", onClick, disabled, "aria-label": label },
          children,
        ),
    ],
    [
      "Input",
      (props: {
        value?: string;
        disabled?: boolean;
        placeholder?: string;
        onChange?: () => void;
        "aria-label"?: string;
      }) =>
        createElement("input", {
          value: props.value,
          disabled: props.disabled,
          placeholder: props.placeholder,
          onChange: props.onChange,
          "aria-label": props["aria-label"],
        }),
    ],
  ]);
});

let client: QueryClient;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.connections.catalog.mockReset().mockResolvedValue([]);
  api.apps.catalog.mockReset().mockResolvedValue([]);
  api.apps.installed.mockReset().mockResolvedValue([]);
  api.connections.list.mockReset().mockResolvedValue([]);
  api.connections.tools.mockReset().mockResolvedValue([]);
  api.capabilities.list.mockReset().mockResolvedValue([]);
  api.capabilities.sourcePresets.mockReset().mockResolvedValue([]);
  api.pluginRegistry.discover.mockReset().mockResolvedValue({ items: [], nextAfter: null });
  api.pluginRegistry.installations.mockReset().mockResolvedValue({ items: [], nextAfter: null });
  api.capabilities.catalogSearch
    .mockReset()
    .mockImplementation(async (input: { usePublicCatalog?: boolean }) =>
      input.usePublicCatalog
        ? {
            enabled: true,
            results: [
              {
                domain: "canva.example.test",
                name: "Canva",
                description: "",
                pageUrl: null,
                surfaces: [
                  {
                    kind: "mcp",
                    slug: "canva",
                    source: "https://mcp.canva.example.test/mcp",
                    auth: null,
                  },
                ],
              },
            ],
          }
        : { enabled: false, results: [] },
    );
  api.mcp.servers.list.mockReset().mockResolvedValue([]);
  api.mcp.assignments.list.mockReset().mockResolvedValue([]);
  api.marketplace.catalog.mockReset().mockResolvedValue({ entries: [], unavailableRegistries: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function searchBox() {
  return host.querySelector<HTMLInputElement>('input[aria-label="Search connections"]')!;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function publicCatalogRow() {
  return Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.startsWith("Search MCP servers for"),
  );
}

function publicSearches() {
  return api.capabilities.catalogSearch.mock.calls.filter(
    (call) => (call[0] as { usePublicCatalog?: boolean }).usePublicCatalog,
  );
}

it("offers the public catalog for a search and sends nothing there until it is picked", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionsSection onOpenApps={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));

  await type(searchBox(), "c");
  expect(publicCatalogRow()).toBeUndefined();

  // Longer than the catalog search accepts: nothing to offer.
  await type(searchBox(), "x".repeat(254));
  expect(publicCatalogRow()).toBeUndefined();

  await type(searchBox(), " canva ");
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "No connections match your search.",
  );
  expect(publicCatalogRow()?.textContent).toBe("Search MCP servers for “canva”");
  expect(publicSearches()).toHaveLength(0);

  await act(async () => publicCatalogRow()?.click());
  await vi.waitFor(() => expect(host.textContent).toContain("Canva"));
  expect(host.textContent).toContain("Add MCP server");
  expect(searchBox().value).toBe("canva");
  expect(publicSearches()).toEqual([[{ query: "canva", usePublicCatalog: true }]]);
});

it("keeps complete Unicode initials in the connected-app marks", async () => {
  api.connections.catalog.mockResolvedValue(
    ["🦞 OpenClaw", "𠮷野", "notes"].map((name, i) => ({
      connectorId: "fixture",
      slug: `app-${i}`,
      name,
      logo: null,
      connected: true,
      noAuth: false,
    })),
  );
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionsSection onOpenApps={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  const marks = [...host.querySelectorAll("span[aria-hidden] .place-items-center")].map(
    (mark) => mark.textContent,
  );
  expect(marks).toEqual(["🦞", "𠮷", "N"]);
});

it("opens both Unicode fallback screenshot targets through browse and manage", async () => {
  api.connections.catalog.mockResolvedValue([
    {
      connectorId: "fixture",
      slug: "unicode",
      name: "𠮷野",
      logo: null,
      connected: true,
      noAuth: false,
    },
  ]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionsSection onOpenApps={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  const connected = host.querySelector("span[aria-hidden]")!.closest("button")!;
  await act(async () => connected.click());
  const apps = host.querySelector('[data-testid="connected-apps"]')!;
  expect(
    [...apps.querySelectorAll(".place-items-center")].some((el) => el.textContent === "𠮷"),
  ).toBe(true);
  const added = [...apps.querySelectorAll("button")].find(
    (button) => button.textContent === "Added",
  )!;
  await act(async () => added.click());
  expect(
    host.querySelector('[data-testid="connection-detail"] .place-items-center')?.textContent,
  ).toBe("𠮷");
});

it("opens a sign-in preset with its address filled in and no token to paste", async () => {
  const preset = {
    id: "gateway",
    name: "Gateway",
    defaultUrl: "https://gateway.example.test/mcp",
    signIn: true,
  };
  let form: ReturnType<typeof useSourceForm> | null = null;
  function Harness() {
    form = useSourceForm();
    return (
      <SourceFormView
        form={form}
        installing={false}
        sourceError={null}
        onBack={() => {}}
        onSubmit={() => {}}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  await act(async () => form?.start("mcp", preset));

  // Name and address only: a token preset would add a third field for the token.
  expect([...host.querySelectorAll("input")].map((input) => input.value)).toEqual([
    "Gateway",
    "https://gateway.example.test/mcp",
  ]);
  expect(host.textContent).toContain("Save and sign in");
});

it("leads from an app that is also a chat app here to messaging, and says nothing for other apps", async () => {
  api.connections.catalog.mockResolvedValue(
    [
      { slug: "chatty", name: "Chatty", chatApp: true },
      { slug: "notes", name: "Notes" },
    ].map((app) => ({
      connectorId: "fixture",
      logo: null,
      connected: false,
      noAuth: false,
      ...app,
    })),
  );
  const onOpenMessaging = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionsSection onOpenApps={() => {}} onOpenMessaging={onOpenMessaging} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.textContent).toContain("Notes"));

  const hints = host.querySelectorAll('[data-testid="chat-app-hint"]');
  expect([...hints].map((hint) => hint.textContent)).toEqual([
    "Tools for your bot.Chat from Chatty",
  ]);
  await act(async () => hints[0]!.querySelector("button")!.click());
  expect(onOpenMessaging).toHaveBeenCalledOnce();
});

it("finds community apps from the Connections search and opens them in Apps", async () => {
  const diary = {
    id: "kcal-diary-v1",
    slug: "kcal-diary",
    version: 1,
    manifest: {
      schemaVersion: 1,
      name: "Kcal diary",
      description: "Calories per day",
      parts: [
        {
          id: "diary",
          kind: "app",
          fields: [{ id: "kcal", label: "Calories", type: "number", required: true }],
        },
      ],
    },
    status: "approved",
    reason: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    reviewedAt: "2026-11-01T00:00:00.000Z",
  };
  api.pluginRegistry.discover.mockImplementation(async (input: { query?: string }) => ({
    items: !input.query || "kcal diary".includes(input.query.toLowerCase()) ? [diary] : [],
    nextAfter: null,
  }));
  const onOpenApps = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionsSection onOpenApps={onOpenApps} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  expect(host.querySelector("[data-testid=plugin-picks]")).toBeNull();
  await type(searchBox(), "kcal");
  await vi.waitFor(() =>
    expect(host.querySelector("[data-testid=plugin-picks]")?.textContent).toContain("Kcal diary"),
  );
  const pick = [
    ...host.querySelectorAll<HTMLButtonElement>("[data-testid=plugin-picks] button"),
  ].find((button) => button.textContent === "Add")!;
  await act(async () => pick.click());
  expect(onOpenApps).toHaveBeenCalledWith({ kind: "community", slug: "kcal-diary" });

  await type(searchBox(), "weather");
  await vi.waitFor(() =>
    expect(api.pluginRegistry.discover).toHaveBeenCalledWith(
      expect.objectContaining({ query: "weather" }),
      expect.anything(),
    ),
  );
  await vi.waitFor(() => expect(host.querySelector("[data-testid=plugin-picks]")).toBeNull());
});

it("offers the server's connector presets when there is no managed catalog, even if the community registry fails", async () => {
  api.capabilities.sourcePresets.mockResolvedValue([
    { id: "tracker", name: "Tracker", url: "https://mcp.tracker.example.test/mcp", signIn: true },
    {
      id: "code-host",
      name: "Code host",
      url: "https://mcp.code.example.test/mcp",
      signIn: true,
      oauthSetupUrl: "https://docs.code.example.test/oauth",
    },
  ]);
  api.pluginRegistry.discover.mockRejectedValue(new Error("registry offline"));
  // A marketplace plugin of the same name does not stand in for the direct connection.
  api.marketplace.catalog.mockResolvedValue({
    entries: [
      {
        id: "tracker-skills",
        name: "tracker-skills",
        displayName: "Tracker",
        description: "Tracker writing guide",
        keywords: [],
        category: null,
        logo: null,
        homepage: null,
        domains: [],
        registry: "fixture",
        source: "https://example.test/tracker-skills",
        installedSource: "https://example.test/tracker-skills",
        hasConnector: false,
        skillCount: 2,
      },
    ],
    unavailableRegistries: [],
    skippedEntries: 0,
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionsSection onOpenApps={() => {}} />
      </QueryClientProvider>,
    ),
  );
  const rows = () => [...host.querySelectorAll('[data-testid="source-preset"]')];
  await vi.waitFor(() =>
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Tracker\s*Connect$/),
      expect.stringMatching(/Code host\s*Connect$/),
    ]),
  );
  expect(rows().map((row) => row.querySelector("button")?.getAttribute("aria-label"))).toEqual([
    "Tracker",
    "Code host",
  ]);
  expect(host.textContent).not.toContain("Configure a connection catalog");
  expect(host.querySelector("[data-testid=plugin-picks]")).toBeNull();

  await type(searchBox(), "code");
  await vi.waitFor(() =>
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Code host\s*Connect$/),
    ]),
  );
  expect(host.textContent).not.toContain("No connections match your search.");

  const connect = [...rows()[0]!.querySelectorAll("button")].find(
    (button) => button.textContent === "Connect",
  )!;
  await act(async () => connect.click());
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll<HTMLInputElement>("input")].map((input) => input.value),
    ).toContain("Code host"),
  );
  const guide = host.querySelector<HTMLAnchorElement>("[data-testid=integrations-source-form] a");
  expect(guide?.textContent).toBe("Sign-in setup guide");
  expect(guide?.href).toBe("https://docs.code.example.test/oauth");
  expect(guide?.rel).toBe("noopener noreferrer");
});

it("offers a connector preset once, as the managed app, when the catalog also connects it", async () => {
  api.capabilities.sourcePresets.mockResolvedValue([
    { id: "tracker", name: "Tracker", url: "https://mcp.tracker.example.test/mcp", signIn: true },
    { id: "code-host", name: "Code host", url: "https://mcp.code.example.test/mcp" },
  ]);
  api.connections.catalog.mockResolvedValue([
    {
      connectorId: "fixture",
      slug: "tracker",
      name: "Tracker",
      logo: null,
      connected: false,
      noAuth: false,
    },
  ]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionsSection onOpenApps={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  await type(searchBox(), "tracker");
  await vi.waitFor(() => expect(host.textContent).toContain("Tracker"));
  expect(host.querySelector('[data-testid="source-preset"]')).toBeNull();

  await type(searchBox(), "code");
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll('[data-testid="source-preset"] button')].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Code host", "Connect Code host"]),
  );
});

it("leads Connections with what is already connected and sends an added preset to its management", async () => {
  api.connections.catalog.mockResolvedValue([
    {
      connectorId: "fixture",
      slug: "notes",
      name: "Notes",
      logo: null,
      connected: true,
      noAuth: false,
    },
    {
      connectorId: "fixture",
      slug: "mail",
      name: "Mail",
      logo: null,
      connected: false,
      noAuth: false,
    },
  ]);
  api.capabilities.sourcePresets.mockResolvedValue([
    { id: "tracker", name: "Tracker", url: "https://mcp.tracker.example.test/mcp", signIn: true },
    { id: "code-host", name: "Code host", url: "https://mcp.code.example.test/mcp" },
    { id: "wiki", name: "Wiki", url: "https://mcp.wiki.example.test/mcp", signIn: true },
  ]);
  const server = (id: string, endpoint: string, oauthStatus: string) => ({
    id,
    name: id,
    slug: id,
    endpoint,
    enabled: true,
    installId: null,
    oauthClientId: null,
    oauthStatus,
    health: { status: "unknown" },
  });
  api.mcp.servers.list.mockResolvedValue([
    server("tracker", "https://mcp.tracker.example.test/mcp", "connected"),
    server("wiki", "https://mcp.wiki.example.test/mcp", "reconnect"),
  ]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionsSection onOpenApps={() => {}} />
      </QueryClientProvider>,
    ),
  );
  const connected = () => host.querySelector('[data-testid="connected-now"]');
  await vi.waitFor(() => expect(connected()?.textContent).toContain("Tracker"));
  expect(connected()?.textContent).toContain("Notes");
  expect(connected()?.textContent).not.toContain("Wiki");
  const presetLabels = () =>
    [...host.querySelectorAll('[data-testid="source-preset"] button')].map((button) =>
      button.getAttribute("aria-label"),
    );
  expect(presetLabels()).toEqual(
    expect.arrayContaining([
      "Manage Tracker, connected",
      "Manage Wiki, not connected yet",
      "Connect Code host",
    ]),
  );

  const wiki = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === "Manage Wiki, not connected yet",
  )!;
  await act(async () => wiki.click());
  await vi.waitFor(() => expect(searchBox()).toBeNull());
  expect(host.querySelector('[data-testid="integrations-source-form"]')).toBeNull();
});

it("lists services in Connections and offers matching app packages only from its search", async () => {
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
  const onOpenApps = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionsSection onOpenApps={onOpenApps} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  expect(host.textContent).not.toContain("Weather kit");
  expect(host.querySelector('[data-testid="plugin-categories"]')).toBeNull();

  await type(searchBox(), "weather");
  const picks = () => host.querySelector('[data-testid="plugin-picks"]');
  await vi.waitFor(() => expect(picks()?.textContent).toContain("Weather kit"));
  await type(searchBox(), "style");
  await vi.waitFor(() => expect(picks()).toBeNull());

  await type(searchBox(), "weather");
  await vi.waitFor(() => expect(picks()?.textContent).toContain("Weather kit"));
  const add = [...picks()!.querySelectorAll("button")].find(
    (button) => button.textContent === "Add",
  )!;
  await act(async () => add.click());
  expect(onOpenApps).toHaveBeenCalledWith({
    kind: "package",
    selection: expect.objectContaining({ installedSource: "https://example.test/weather-kit" }),
  });
});
