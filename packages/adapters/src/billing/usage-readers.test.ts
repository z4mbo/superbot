import { describe, expect, it } from "vitest";
import {
  parseChatGptPlanLimits,
  parseChatGptUsage,
  parseClaudePlanLimits,
  parseClaudeUsage,
  parseDeepSeekBalance,
  parseGatewayCredits,
  parseMoonshotBalance,
  parseOpenRouterKeyUsage,
} from "./usage-readers.js";

const claudeBody = {
  five_hour: { utilization: 42, resets_at: "2026-11-10T15:00:00Z" },
  seven_day: { utilization: 12.5, resets_at: "2026-11-14T00:00:00Z" },
  seven_day_oauth_apps: null,
  seven_day_opus: { utilization: 90, resets_at: "2026-11-14T00:00:00Z" },
  seven_day_sonnet: null,
  limits: [
    {
      kind: "weekly_scoped",
      group: "week",
      percent: 91,
      resets_at: "2026-11-14T00:00:00Z",
      scope: { model: { display_name: "Opus" } },
    },
    {
      kind: "weekly_scoped",
      group: "week",
      percent: 30,
      resets_at: "2026-11-14T00:00:00Z",
      scope: { model: { display_name: "Fable" } },
    },
    { kind: "session", group: "session", percent: 42, resets_at: null, scope: null },
  ],
  extra_usage: {
    is_enabled: true,
    monthly_limit: 5000,
    used_credits: 1234,
    utilization: 24.68,
    currency: "USD",
  },
};

describe("parseClaudeUsage", () => {
  it("reads shared, per-model and extra-usage figures", () => {
    expect(parseClaudeUsage(claudeBody)).toEqual({
      windows: [
        { period: "session", usedPercent: 42, resetsAt: "2026-11-10T15:00:00.000Z" },
        { period: "week", usedPercent: 12.5, resetsAt: "2026-11-14T00:00:00.000Z" },
        {
          period: "week",
          usedPercent: 90,
          resetsAt: "2026-11-14T00:00:00.000Z",
          model: "Opus",
        },
        {
          period: "week",
          usedPercent: 30,
          resetsAt: "2026-11-14T00:00:00.000Z",
          model: "Fable",
        },
      ],
      credits: {
        usedUsd: 12.34,
        limitUsd: 50,
        remainingUsd: null,
        period: "month",
        resetsAt: null,
      },
      plan: null,
    });
  });

  it("keeps the plan-limits view to the shared windows", () => {
    expect(parseClaudePlanLimits(claudeBody)).toEqual(
      parseClaudeUsage(claudeBody).windows.slice(0, 2),
    );
  });

  it("reports extra usage without a cap, or not at all when it is off or not in dollars", () => {
    const credits = (extra: unknown) => parseClaudeUsage({ extra_usage: extra }).credits;
    expect(credits({ is_enabled: true, monthly_limit: null, used_credits: 250 })).toEqual({
      usedUsd: 2.5,
      limitUsd: null,
      remainingUsd: null,
      period: "month",
      resetsAt: null,
    });
    expect(
      credits({ is_enabled: false, monthly_limit: null, used_credits: 0, utilization: null }),
    ).toBeNull();
    expect(
      credits({ is_enabled: true, monthly_limit: 5000, used_credits: 10, currency: "EUR" }),
    ).toBeNull();
    expect(credits({ is_enabled: true, monthly_limit: 5000, used_credits: null })).toBeNull();
    expect(credits(null)).toBeNull();
  });
});

describe("parseChatGptUsage", () => {
  const body = {
    plan_type: "free_workspace",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 7, limit_window_seconds: 18_000, reset_at: 1_794_326_400 },
      secondary_window: null,
    },
    additional_rate_limits: [
      {
        metered_feature: "codex_other",
        limit_name: "GPT-Spark",
        rate_limit: {
          primary_window: { used_percent: 55, limit_window_seconds: 604_800, reset_at: null },
        },
      },
      { limit_name: "Broken", rate_limit: { primary_window: { used_percent: "x" } } },
      { limit_name: "", rate_limit: null },
    ],
    credits: { has_credits: true, unlimited: false, balance: "120" },
  };

  it("reads the plan, its windows and models with their own limit, but not its credits", () => {
    expect(parseChatGptUsage(body)).toEqual({
      windows: [
        { period: "session", usedPercent: 7, resetsAt: "2026-11-10T16:00:00.000Z" },
        { period: "week", usedPercent: 55, resetsAt: null, model: "GPT-Spark" },
      ],
      credits: null,
      plan: "Free workspace",
    });
    expect(parseChatGptPlanLimits(body)).toEqual([
      { period: "session", usedPercent: 7, resetsAt: "2026-11-10T16:00:00.000Z" },
    ]);
  });

  it("names the plan as reported and leaves an unknown one out", () => {
    const plan = (plan_type: unknown) => parseChatGptUsage({ plan_type, rate_limit: {} }).plan;
    expect(plan("plus")).toBe("Plus");
    expect(plan("unknown")).toBeNull();
    expect(plan(undefined)).toBeNull();
  });
});

describe("parseOpenRouterKeyUsage", () => {
  const key = {
    label: "sk-or-v1-abc...123",
    limit: 100,
    limit_remaining: 74.5,
    limit_reset: "monthly",
    usage: 25.5,
    usage_daily: 1.5,
    usage_weekly: 10,
    usage_monthly: 25.5,
    byok_usage: 17.38,
    is_free_tier: false,
    include_byok_in_limit: false,
    expires_at: null,
  };

  it("reads the key's limit and the spending counted against it", () => {
    expect(parseOpenRouterKeyUsage({ data: key }).credits).toEqual({
      usedUsd: 25.5,
      limitUsd: 100,
      remainingUsd: 74.5,
      period: "month",
      resetsAt: null,
    });
  });

  it("reads an uncapped free-tier key as lifetime spending with no limit", () => {
    expect(
      parseOpenRouterKeyUsage({
        data: {
          ...key,
          limit: null,
          limit_remaining: null,
          limit_reset: null,
          usage: 0,
          is_free_tier: true,
        },
      }),
    ).toEqual({
      windows: [],
      credits: { usedUsd: 0, limitUsd: null, remainingUsd: null, period: null, resetsAt: null },
      plan: null,
    });
  });

  it("prefers the budget that blocks requests first", () => {
    expect(
      parseOpenRouterKeyUsage({
        data: {
          ...key,
          effective_budget: {
            scope: "workspace",
            limit_usd: 500,
            spend_usd: 93.45,
            remaining_usd: 406.55,
            reset_interval: "weekly",
            resets_at: "2026-11-23T00:00:00.000Z",
            include_byok: false,
          },
        },
      }).credits,
    ).toEqual({
      usedUsd: 93.45,
      limitUsd: 500,
      remainingUsd: 406.55,
      period: "week",
      resetsAt: "2026-11-23T00:00:00.000Z",
    });
  });

  it("rejects a body without key data", () => {
    expect(() => parseOpenRouterKeyUsage({})).toThrow();
  });
});

describe("balance readers", () => {
  it("reads a US dollar balance and nothing from one in another currency", () => {
    const info = (currency: string) => ({
      currency,
      total_balance: "110.00",
      granted_balance: "10.00",
      topped_up_balance: "100.00",
    });
    expect(
      parseDeepSeekBalance({ is_available: true, balance_infos: [info("CNY"), info("USD")] })
        .credits,
    ).toEqual({ usedUsd: null, limitUsd: null, remainingUsd: 110, period: null, resetsAt: null });
    expect(
      parseDeepSeekBalance({ is_available: true, balance_infos: [info("CNY")] }).credits,
    ).toBeNull();
  });

  it("reads the available balance, which can be below zero", () => {
    const balance = (available_balance: number) =>
      parseMoonshotBalance({
        code: 0,
        data: { available_balance, voucher_balance: 46.58893, cash_balance: 3.00001 },
        scode: "0x0",
        status: true,
      }).credits?.remainingUsd;
    expect(balance(49.58894)).toBe(49.58894);
    expect(balance(-2)).toBe(-2);
  });

  it("reads gateway credit and spending, and nothing from an empty answer", () => {
    expect(
      parseGatewayCredits({
        balance: "95.50",
        token_pass: { remaining: "12.34", resets_at: "2026-12-01T00:00:00.000Z" },
        total_used: "4.50",
      }).credits,
    ).toEqual({ usedUsd: 4.5, limitUsd: null, remainingUsd: 95.5, period: null, resetsAt: null });
    expect(parseGatewayCredits({}).credits).toBeNull();
  });
});
