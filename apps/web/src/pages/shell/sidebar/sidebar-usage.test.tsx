// @vitest-environment jsdom

import type { ProviderUsage } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({ providers: vi.fn() }));
vi.mock("../../../lib/query/rpc", () => {
  const rpc = { usage };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

const { SidebarUsage, revealSidebarUsage } = await import("./sidebar-usage");
const { sidebarUsageExpandedPreference } = await import(
  "../../../lib/preferences/sidebar-usage-pref"
);

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

function row(overrides: Partial<ProviderUsage>): ProviderUsage {
  return {
    credentialId: "credential",
    provider: "acme",
    name: "Acme",
    label: "Acme",
    kind: "api_key",
    plan: null,
    status: "ok",
    windows: [],
    credits: null,
    readAt: new Date().toISOString(),
    ...overrides,
  };
}

const subscription = row({
  credentialId: "sub-1",
  provider: "anthropic",
  name: "Claude",
  label: "Claude",
  kind: "subscription",
  plan: "Max",
  windows: [
    { period: "session", usedPercent: 42, resetsAt: inHours(2) },
    { period: "week", usedPercent: 61, resetsAt: inHours(50) },
    { period: "week", usedPercent: 30, resetsAt: inHours(50), model: "Opus" },
  ],
});
const nearlySpent = row({
  credentialId: "sub-2",
  provider: "openai",
  name: "ChatGPT",
  label: "ChatGPT",
  kind: "subscription",
  plan: "Plus",
  windows: [{ period: "session", usedPercent: 85.4, resetsAt: inHours(1) }],
});
const uncapped = row({
  credentialId: "key-1",
  name: "Router",
  label: "Router",
  credits: { usedUsd: 4.2, limitUsd: null, remainingUsd: null, period: null, resetsAt: null },
});

describe("SidebarUsage", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onOpenSettings = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Element.prototype.scrollIntoView = vi.fn();
    sidebarUsageExpandedPreference(null).set(false);
    usage.providers.mockReset();
    onOpenSettings.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function show() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <SidebarUsage onOpenSettings={onOpenSettings} />
        </QueryClientProvider>,
      ),
    );
  }
  const section = () => container.querySelector<HTMLElement>('[data-testid="sidebar-usage"]');
  // The words in each row; a bar's hidden helper text is not part of them.
  const rows = () =>
    [...container.querySelectorAll<HTMLElement>('[data-testid="usage-row"]')].map((element) => {
      const copy = element.cloneNode(true) as HTMLElement;
      for (const bar of copy.querySelectorAll('[role="progressbar"]')) bar.remove();
      return copy.textContent;
    });
  const header = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  const refreshButton = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Refresh usage"]')!;
  async function loaded(list: ProviderUsage[]) {
    usage.providers.mockResolvedValue(list);
    show();
    await vi.waitFor(() => expect(rows().length).toBe(list.length));
  }

  it("lists each connection on one line, the one with the least room first", async () => {
    await loaded([uncapped, subscription, nearlySpent]);
    expect(usage.providers).toHaveBeenCalledWith(undefined, expect.anything());
    expect(rows()).toEqual(["ChatGPT85% Running low", "Claude61%", "Router$4.20 used"]);
    expect(header().getAttribute("aria-expanded")).toBe("false");
    // Plans and resets wait for the detailed view.
    expect(section()!.textContent).not.toContain("Max");
    expect(section()!.textContent).not.toContain("Resets in");
  });

  it("shows each allowance, its model family and reset, and the plan, in detail", async () => {
    await loaded([subscription]);
    act(() => header().click());
    expect(header().getAttribute("aria-expanded")).toBe("true");
    const [claude] = rows();
    expect(claude).toContain("ClaudeMax");
    expect(claude).toContain("Session42%");
    expect(claude).toContain("Resets in 2h 0m");
    expect(claude).toContain("Weekly61%");
    expect(claude).toContain("WeeklyOpus30%");
    const bars = [...section()!.querySelectorAll('[role="progressbar"]')].map((bar) =>
      bar.getAttribute("aria-label"),
    );
    expect(bars).toEqual(["Session", "Weekly", "Weekly Opus"]);
    act(() => container.querySelector<HTMLButtonElement>("ul + button")!.click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("remembers the detailed view", async () => {
    sidebarUsageExpandedPreference(null).set(true);
    await loaded([subscription]);
    expect(header().getAttribute("aria-expanded")).toBe("true");
    act(() => header().click());
    expect(sidebarUsageExpandedPreference(null).get()).toBe(false);
  });

  it("marks a nearly spent allowance in words as well as color", async () => {
    await loaded([nearlySpent, subscription]);
    const figures = [...section()!.querySelectorAll(".text-warning")].map(
      (element) => element.textContent,
    );
    expect(figures).toEqual(["85% Running low"]);
    act(() => header().click());
    expect([...section()!.querySelectorAll(".text-warning")].map((e) => e.textContent)).toEqual([
      "85% Running low",
    ]);
  });

  it("says why a connection has no figures", async () => {
    await loaded([
      row({ credentialId: "a", name: "A", status: "unavailable" }),
      row({ credentialId: "b", name: "B", status: "not_signed_in" }),
      row({ credentialId: "c", name: "C", status: "error" }),
      row({ credentialId: "d", name: "D", status: "no_data" }),
      row({ credentialId: "e", name: "E", status: "ok" }),
    ]);
    const expected = [
      "AUsage not available",
      "BNot signed in",
      "CCouldn't load usage",
      "DNo usage data",
      "ENo usage data",
    ];
    expect(rows()).toEqual(expected);
    act(() => header().click());
    expect(rows()).toEqual(expected);
    expect(section()!.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("shows only the money a provider reported", async () => {
    const credits = (value: Partial<NonNullable<ProviderUsage["credits"]>>) => ({
      usedUsd: null,
      limitUsd: null,
      remainingUsd: null,
      period: null,
      resetsAt: null,
      ...value,
    });
    await loaded([
      row({
        credentialId: "capped",
        name: "Capped",
        credits: credits({ usedUsd: 4.2, limitUsd: 20, remainingUsd: 15.8, period: "month" }),
      }),
      row({ credentialId: "uncapped", name: "Uncapped", credits: credits({ usedUsd: 4.2 }) }),
      row({ credentialId: "left", name: "Left", credits: credits({ remainingUsd: 15.8 }) }),
      row({ credentialId: "unknown", name: "Unknown", credits: credits({}) }),
    ]);
    expect(rows()).toEqual([
      "Capped$15.80 left",
      "Uncapped$4.20 used",
      "Left$15.80 left",
      "UnknownNo usage data",
    ]);
    // Only the capped key has two reported numbers to draw a bar from.
    expect(section()!.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    act(() => header().click());
    expect(rows()).toEqual([
      "CappedMonthly credits$4.20 of $20.00 used",
      "UncappedCredits$4.20 used",
      "LeftCredits$15.80 left",
      "UnknownNo usage data",
    ]);
    expect(section()!.textContent).not.toContain("$0.00");
  });

  it("names the connection too when two share a provider's name", async () => {
    await loaded([
      row({ credentialId: "a", name: "Router", label: "Work", status: "unavailable" }),
      row({ credentialId: "b", name: "Router", label: "Home", status: "unavailable" }),
      row({ credentialId: "c", name: "Other", label: "Other", status: "unavailable" }),
    ]);
    expect(rows()).toEqual([
      "RouterWorkUsage not available",
      "RouterHomeUsage not available",
      "OtherUsage not available",
    ]);
  });

  it("says it is loading, and shows nothing for a member with no connections", async () => {
    const pending = deferred<ProviderUsage[]>();
    usage.providers.mockReturnValue(pending.promise);
    show();
    expect(section()!.textContent).toContain("Loading usage…");
    expect(refreshButton().disabled).toBe(true);
    await act(async () => pending.resolve([]));
    await vi.waitFor(() => expect(section()).toBeNull());
  });

  it("says when usage could not be read, and reads it again on refresh", async () => {
    usage.providers.mockRejectedValueOnce(new Error("offline"));
    show();
    await vi.waitFor(() => expect(section()!.textContent).toContain("Couldn't load usage"));
    usage.providers.mockResolvedValue([subscription]);
    act(() => refreshButton().click());
    await vi.waitFor(() => expect(rows()).toEqual(["Claude61%"]));
    expect(usage.providers).toHaveBeenLastCalledWith({ refresh: true });
  });

  it("asks the providers again on refresh and shows what they say", async () => {
    await loaded([subscription]);
    const fresh = deferred<ProviderUsage[]>();
    usage.providers.mockReturnValue(fresh.promise);
    act(() => refreshButton().click());
    expect(usage.providers).toHaveBeenLastCalledWith({ refresh: true });
    expect(refreshButton().disabled).toBe(true);
    await act(async () =>
      fresh.resolve([
        { ...subscription, windows: [{ period: "session", usedPercent: 70, resetsAt: null }] },
      ]),
    );
    await vi.waitFor(() => expect(rows()).toEqual(["Claude70%"]));
    expect(refreshButton().disabled).toBe(false);
  });

  it("opens in detail and takes focus when the model list asks", async () => {
    await loaded([subscription]);
    act(() => revealSidebarUsage());
    expect(header().getAttribute("aria-expanded")).toBe("true");
    await vi.waitFor(() => expect(document.activeElement).toBe(header()));
    expect(header().scrollIntoView).toHaveBeenCalled();
  });
});
