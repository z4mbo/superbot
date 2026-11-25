import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { PlanLimitWindow, ProviderCredits } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import {
  ANTHROPIC_OAUTH_PROVIDER,
  CHATGPT_OAUTH_PROVIDER,
  oauthCredentialAccountId,
} from "../runtime/pi/models/pi-oauth.js";

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

/** What a provider reported for one connection; empty fields are ones it did not report. */
export type UsageReading = {
  windows: PlanLimitWindow[];
  credits: ProviderCredits | null;
  plan: string | null;
};

/** A provider answered with an HTTP error; only the status is kept, never the body. */
export class UsageHttpError extends Error {
  constructor(readonly status: number) {
    super(`http ${status}`);
  }

  /** The provider no longer accepts the sign-in or key. */
  get rejected(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

type OAuthUsageReader = {
  /** The subscription's own name, which is what people know their plan by. */
  name?: string;
  /** Whether its reading carries the plan's allowances, which is what `usage.limits` lists. */
  planLimits?: true;
  read: (credential: OAuthCredential, fetchImpl: typeof fetch) => Promise<UsageReading>;
};

type KeyUsageReader = (key: string, fetchImpl: typeof fetch) => Promise<UsageReading>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schema");
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function percent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("schema");
  return Math.min(100, Math.max(0, value));
}

/** A finite number, or a decimal string some providers send amounts as; anything else is unknown. */
function amount(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : NaN;
  return Number.isFinite(number) ? number : null;
}

const spent = (value: unknown) => {
  const number = amount(value);
  return number !== null && number >= 0 ? number : null;
};

/** Seconds since the epoch or an ISO string; anything else is unknown. */
function resetTime(value: unknown): string | null {
  const ms =
    typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function periodFor(seconds: unknown): PlanLimitWindow["period"] | null {
  if (typeof seconds !== "number" || seconds <= 0) return null;
  if (seconds <= 86_400) return "session";
  if (seconds <= 8 * 86_400) return "week";
  return "month";
}

function creditPeriod(value: unknown): ProviderCredits["period"] {
  return value === "daily"
    ? "day"
    : value === "weekly"
      ? "week"
      : value === "monthly"
        ? "month"
        : null;
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetchImpl(url, {
    headers: { ...headers, accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await bestEffort("cancel unread response body", response.body?.cancel());
    throw new UsageHttpError(response.status);
  }
  return readBoundedJsonResponse(response, MAX_BYTES, signal);
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Weekly windows that cover one model family, named as the provider names the family. */
const CLAUDE_MODEL_WINDOWS = [
  ["seven_day_opus", "Opus"],
  ["seven_day_sonnet", "Sonnet"],
] as const;

/**
 * The session and weekly windows, each model family's own weekly window, and extra usage paid
 * beyond the plan. Extra-usage amounts are minor units of their currency (cents for US dollars),
 * and only US dollars are reported.
 */
export function parseClaudeUsage(payload: unknown): UsageReading {
  const body = record(payload);
  const windows: PlanLimitWindow[] = [];
  for (const [key, period] of [
    ["five_hour", "session"],
    ["seven_day", "week"],
  ] as const) {
    if (body[key] == null) continue;
    const window = record(body[key]);
    windows.push({
      period,
      usedPercent: percent(window.utilization),
      resetsAt: resetTime(window.resets_at),
    });
  }
  const models = new Set<string>();
  for (const [key, model] of CLAUDE_MODEL_WINDOWS) {
    const window = optionalRecord(body[key]);
    if (!window || typeof window.utilization !== "number") continue;
    models.add(model.toLowerCase());
    windows.push({
      period: "week",
      usedPercent: percent(window.utilization),
      resetsAt: resetTime(window.resets_at),
      model,
    });
  }
  // Newer answers list model-scoped weekly limits; ones already read above are not repeated.
  for (const entry of Array.isArray(body.limits) ? body.limits : []) {
    const limit = optionalRecord(entry);
    const model = optionalRecord(optionalRecord(limit?.scope)?.model)?.display_name;
    if (limit?.kind !== "weekly_scoped" || typeof model !== "string" || !model.trim()) continue;
    if (typeof limit.percent !== "number" || models.has(model.trim().toLowerCase())) continue;
    models.add(model.trim().toLowerCase());
    windows.push({
      period: "week",
      usedPercent: percent(limit.percent),
      resetsAt: resetTime(limit.resets_at),
      model: model.trim(),
    });
  }
  return { windows, credits: claudeExtraUsage(body.extra_usage), plan: null };
}

function claudeExtraUsage(value: unknown): ProviderCredits | null {
  const extra = optionalRecord(value);
  if (!extra) return null;
  // The CLI the endpoint serves reads a missing currency as US dollars.
  const currency = typeof extra.currency === "string" ? extra.currency.toUpperCase() : "USD";
  const used = spent(extra.used_credits);
  const limit = spent(extra.monthly_limit);
  // Switched off with no limit is extra usage never set up, not spending without a cap.
  if (currency !== "USD" || used === null || (extra.is_enabled !== true && limit === null))
    return null;
  return {
    usedUsd: used / 100,
    limitUsd: limit === null ? null : limit / 100,
    remainingUsd: null,
    period: "month",
    resetsAt: null,
  };
}

/** Session and weekly windows; per-model weekly limits do not gate the shared allowance. */
export function parseClaudePlanLimits(payload: unknown): PlanLimitWindow[] {
  return parseClaudeUsage(payload).windows.filter((window) => !window.model);
}

function chatGptWindows(value: unknown, model?: string): PlanLimitWindow[] {
  const limits = record(value);
  const windows: PlanLimitWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    if (limits[key] == null) continue;
    const window = record(limits[key]);
    const period = periodFor(window.limit_window_seconds);
    if (!period) continue;
    windows.push({
      period,
      usedPercent: percent(window.used_percent),
      resetsAt: resetTime(window.reset_at),
      ...(model ? { model } : {}),
    });
  }
  return windows;
}

function chatGptPlan(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const words = value.trim().replaceAll("_", " ");
  if (!words || words === "unknown") return null;
  return words[0]?.toUpperCase() + words.slice(1);
}

/**
 * The account's primary and secondary windows, named by their length, the limits of models with
 * their own allowance, and the plan. Its credit balance is not in dollars, so it is left out.
 */
export function parseChatGptUsage(payload: unknown): UsageReading {
  const body = record(payload);
  const windows = chatGptWindows(body.rate_limit);
  for (const entry of Array.isArray(body.additional_rate_limits)
    ? body.additional_rate_limits
    : []) {
    const limit = optionalRecord(entry);
    const name = typeof limit?.limit_name === "string" ? limit.limit_name.trim() : "";
    if (!limit || !name || limit.rate_limit == null) continue;
    try {
      windows.push(...chatGptWindows(limit.rate_limit, name));
    } catch {
      // One unreadable extra limit leaves the account's own windows standing.
    }
  }
  return { windows, credits: null, plan: chatGptPlan(body.plan_type) };
}

/** The account's primary and secondary windows, named by their length. */
export function parseChatGptPlanLimits(payload: unknown): PlanLimitWindow[] {
  return chatGptWindows(record(payload).rate_limit);
}

/**
 * Spending on the key. The budget that stops requests first wins; without one, the key's own
 * limit and the spending counted in the period it starts over. A null limit is no cap.
 */
export function parseOpenRouterKeyUsage(payload: unknown): UsageReading {
  const data = record(record(payload).data);
  const budget = optionalRecord(data.effective_budget);
  if (budget) {
    return {
      windows: [],
      credits: {
        usedUsd: spent(budget.spend_usd),
        limitUsd: spent(budget.limit_usd),
        remainingUsd: amount(budget.remaining_usd),
        period: creditPeriod(budget.reset_interval),
        resetsAt: resetTime(budget.resets_at),
      },
      plan: null,
    };
  }
  const limit = spent(data.limit);
  const period = limit === null ? null : creditPeriod(data.limit_reset);
  const used =
    period === "day"
      ? data.usage_daily
      : period === "week"
        ? data.usage_weekly
        : period === "month"
          ? data.usage_monthly
          : data.usage;
  return {
    windows: [],
    credits: {
      usedUsd: spent(used),
      limitUsd: limit,
      remainingUsd: limit === null ? null : amount(data.limit_remaining),
      period,
      resetsAt: null,
    },
    plan: null,
  };
}

/** The balance usable in US dollars; a balance only in another currency is not reported. */
export function parseDeepSeekBalance(payload: unknown): UsageReading {
  const infos = record(payload).balance_infos;
  const usd = (Array.isArray(infos) ? infos : [])
    .map(optionalRecord)
    .find((info) => info?.currency === "USD");
  const remaining = usd ? amount(usd.total_balance) : null;
  return {
    windows: [],
    credits:
      remaining === null
        ? null
        : { usedUsd: null, limitUsd: null, remainingUsd: remaining, period: null, resetsAt: null },
    plan: null,
  };
}

/** The international platform's balance, in US dollars, cash and vouchers together. */
export function parseMoonshotBalance(payload: unknown): UsageReading {
  const remaining = amount(record(record(payload).data).available_balance);
  return {
    windows: [],
    credits:
      remaining === null
        ? null
        : { usedUsd: null, limitUsd: null, remainingUsd: remaining, period: null, resetsAt: null },
    plan: null,
  };
}

/** The gateway's remaining credit and everything spent to date, in US dollars. */
export function parseGatewayCredits(payload: unknown): UsageReading {
  const body = record(payload);
  const remaining = amount(body.balance);
  const used = spent(body.total_used);
  return {
    windows: [],
    credits:
      remaining === null && used === null
        ? null
        : { usedUsd: used, limitUsd: null, remainingUsd: remaining, period: null, resetsAt: null },
    plan: null,
  };
}

const readOpenRouterKey: KeyUsageReader = async (key, fetchImpl) =>
  parseOpenRouterKeyUsage(
    await getJson(fetchImpl, "https://openrouter.ai/api/v1/key", bearer(key)),
  );

export const OAUTH_USAGE_READERS: Record<string, OAuthUsageReader> = {
  [ANTHROPIC_OAUTH_PROVIDER]: {
    name: "Claude",
    planLimits: true,
    read: async (credential, fetchImpl) =>
      parseClaudeUsage(
        await getJson(fetchImpl, "https://api.anthropic.com/api/oauth/usage", {
          ...bearer(credential.access),
          "anthropic-beta": "oauth-2025-04-20",
        }),
      ),
  },
  [CHATGPT_OAUTH_PROVIDER]: {
    name: "ChatGPT",
    planLimits: true,
    read: async (credential, fetchImpl) => {
      const accountId = oauthCredentialAccountId(credential);
      if (!accountId) throw new Error("account");
      return parseChatGptUsage(
        await getJson(fetchImpl, "https://chatgpt.com/backend-api/wham/usage", {
          ...bearer(credential.access),
          "chatgpt-account-id": accountId,
          originator: "rakazo",
        }),
      );
    },
  },
  // Signing in creates an ordinary key, which is what the stored access token holds.
  openrouter: { read: (credential, fetchImpl) => readOpenRouterKey(credential.access, fetchImpl) },
};

export const KEY_USAGE_READERS: Record<string, KeyUsageReader> = {
  openrouter: readOpenRouterKey,
  deepseek: async (key, fetchImpl) =>
    parseDeepSeekBalance(
      await getJson(fetchImpl, "https://api.deepseek.com/user/balance", bearer(key)),
    ),
  moonshotai: async (key, fetchImpl) =>
    parseMoonshotBalance(
      await getJson(fetchImpl, "https://api.moonshot.ai/v1/users/me/balance", bearer(key)),
    ),
  "vercel-ai-gateway": async (key, fetchImpl) =>
    parseGatewayCredits(
      await getJson(fetchImpl, "https://ai-gateway.vercel.sh/v1/credits", bearer(key)),
    ),
};

export function oauthUsageReader(provider: string): OAuthUsageReader | undefined {
  return Object.hasOwn(OAUTH_USAGE_READERS, provider) ? OAUTH_USAGE_READERS[provider] : undefined;
}

export function keyUsageReader(provider: string): KeyUsageReader | undefined {
  return Object.hasOwn(KEY_USAGE_READERS, provider) ? KEY_USAGE_READERS[provider] : undefined;
}

/** The subscriptions whose readings carry plan allowances. */
export const PLAN_LIMIT_PROVIDERS = Object.keys(OAUTH_USAGE_READERS).filter(
  (provider) => OAUTH_USAGE_READERS[provider]?.planLimits,
);
