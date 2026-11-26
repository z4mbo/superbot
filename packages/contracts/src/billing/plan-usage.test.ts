import { describe, expect, it } from "vitest";
import type { BillingStatus } from "./billing.js";
import { modelCreditsUsd } from "./billing.js";
import {
  planUsagePercent,
  providerUsageNextReset,
  providerUsagePercent,
  tightestProviderUsageFirst,
} from "./usage.js";

describe("modelCreditsUsd", () => {
  const status = (overrides: Partial<BillingStatus>) => overrides as BillingStatus;

  it("hides credits from members who only run on their own plans", () => {
    expect(modelCreditsUsd(null)).toBeNull();
    expect(modelCreditsUsd(status({ funding: "byok", balanceUsd: 0 }))).toBeNull();
    expect(modelCreditsUsd(status({ funding: null }))).toBeNull();
  });

  it("shows a credit plan's balance, even when it is spent, and a balance left after switching", () => {
    expect(modelCreditsUsd(status({ funding: "credits", balanceUsd: 0 }))).toBe(0);
    expect(modelCreditsUsd(status({ funding: "byok", balanceUsd: 4.5 }))).toBe(4.5);
  });
});

describe("planUsagePercent", () => {
  it("is the subscription with the most room, judged by its fullest window", () => {
    expect(planUsagePercent([])).toBeNull();
    expect(
      planUsagePercent([
        {
          credentialId: "a",
          name: "A",
          label: "A",
          windows: [
            { period: "session", usedPercent: 12, resetsAt: null },
            { period: "week", usedPercent: 64, resetsAt: null },
          ],
        },
        {
          credentialId: "b",
          name: "B",
          label: "B",
          windows: [{ period: "session", usedPercent: 93, resetsAt: null }],
        },
      ]),
    ).toBe(64);
  });
});

describe("provider usage", () => {
  const window = (usedPercent: number, resetsAt: string | null = null) => ({
    period: "session" as const,
    usedPercent,
    resetsAt,
  });

  it("judges a connection by its fullest allowance and soonest reset", () => {
    const usage = {
      windows: [window(12, "2026-11-26T10:00:00.000Z"), window(64, "2026-11-25T18:00:00.000Z")],
    };
    expect(providerUsagePercent(usage)).toBe(64);
    expect(providerUsageNextReset(usage)).toBe("2026-11-25T18:00:00.000Z");
  });

  it("reports nothing for a connection without allowances", () => {
    expect(providerUsagePercent({ windows: [] })).toBeNull();
    expect(providerUsageNextReset({ windows: [] })).toBeNull();
    expect(providerUsageNextReset({ windows: [window(5)] })).toBeNull();
  });

  it("puts the tightest connection first and keeps the rest in order", () => {
    const rows = [
      { id: "key", windows: [] },
      { id: "open", windows: [window(20)] },
      { id: "spent", windows: [window(0), window(91)] },
      { id: "other-key", windows: [] },
      { id: "unused", windows: [window(0)] },
    ];
    expect(tightestProviderUsageFirst(rows).map((row) => row.id)).toEqual([
      "spent",
      "open",
      "unused",
      "key",
      "other-key",
    ]);
  });
});
