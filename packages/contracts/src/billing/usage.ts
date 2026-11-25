import * as z from "zod";
import { Id } from "../ids.js";

export const UsageRecordSchema = z.object({
  id: Id,
  botId: Id.nullable(),
  runId: Id.nullable(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  cacheReadTokens: z.number().int().nullable().optional(),
  cacheWriteTokens: z.number().int().nullable().optional(),
  cacheWrite1hTokens: z.number().int().nullable().optional(),
  reasoningTokens: z.number().int().nullable().optional(),
  totalTokens: z.number().int().nullable().optional(),
  costUsd: z.number().nonnegative().nullable().optional(),
  costSource: z.string().nullable().optional(),
  pricingVersion: z.string().nullable().optional(),
  usageSource: z.string().nullable().optional(),
  callId: z.string().nullable().optional(),
  operationId: z.string().nullable().optional(),
  operationKind: z.enum(["answer", "setup", "retrieval", "subagent", "compaction"]).optional(),
  parentRunId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  createdAt: z.string(),
});

/** Token and cost totals are null when any counted call lacks that figure. */
const UsageTotalsSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable().optional(),
  costUsd: z.number().nullable().optional(),
  modelCalls: z.number().optional(),
});
export const UsageSummarySchema = UsageTotalsSchema.extend({
  runs: z.number(),
  models: z
    .array(UsageTotalsSchema.required().extend({ provider: z.string(), model: z.string() }))
    .optional(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const UsageDateRangeSchema = z.enum(["today", "7d", "30d", "all"]);
export type UsageDateRange = z.infer<typeof UsageDateRangeSchema>;

export const UsageBreakdownInputSchema = z.object({
  /** Omit or null to include every bot. */
  botId: Id.nullish(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  range: UsageDateRangeSchema.default("30d"),
});
export type UsageBreakdownInput = z.infer<typeof UsageBreakdownInputSchema>;

export const UsageBreakdownModelSchema = UsageTotalsSchema.required().extend({
  provider: z.string(),
  model: z.string(),
});
export type UsageBreakdownModel = z.infer<typeof UsageBreakdownModelSchema>;

export const UsageBreakdownPointSchema = UsageTotalsSchema.required().extend({
  /** The bucket's first day in the member's timezone, YYYY-MM-DD. */
  date: z.string(),
});
export type UsageBreakdownPoint = z.infer<typeof UsageBreakdownPointSchema>;

export const UsageBreakdownBotSchema = z.object({
  id: Id,
  /** Null for a bot removed without a record of its name. */
  name: z.string().nullable(),
  deleted: z.boolean(),
  runs: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  modelCalls: z.number(),
});
export type UsageBreakdownBot = z.infer<typeof UsageBreakdownBotSchema>;

export const UsageBreakdownSchema = z.object({
  range: UsageDateRangeSchema,
  /** Each bot with usage in the range, for the bot selector. */
  bots: z.array(UsageBreakdownBotSchema),
  /** Every model used in the range, for the model selector. */
  modelOptions: z.array(z.object({ provider: z.string(), model: z.string() })),
  totals: UsageTotalsSchema.required().extend({ runs: z.number() }),
  models: z.array(UsageBreakdownModelSchema),
  /** One point per day, or per month for an all-time history longer than two months. */
  overTimeUnit: z.enum(["day", "month"]),
  overTime: z.array(UsageBreakdownPointSchema),
});
export type UsageBreakdown = z.infer<typeof UsageBreakdownSchema>;

/** One rolling allowance of a model subscription the member signed in with. */
export const PlanLimitWindowSchema = z.object({
  period: z.enum(["session", "week", "month"]),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().nullable(),
  /** The model family the allowance covers, as its provider names it; absent when it covers all. */
  model: z.string().optional(),
});
export type PlanLimitWindow = z.infer<typeof PlanLimitWindowSchema>;
/** A subscription connection's allowances, as its provider last reported them. */
export const PlanLimitsSchema = z.object({
  credentialId: z.string(),
  /** The subscription's name. */
  name: z.string(),
  /** The connection's own name, which tells two sign-ins to one subscription apart. */
  label: z.string(),
  windows: z.array(PlanLimitWindowSchema).min(1),
});
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

/**
 * How used the subscription with the most room is. Each one is only as open as its fullest
 * allowance, so a nearly spent session on one plan does not read as the member being out.
 */
export function planUsagePercent(plans: readonly PlanLimits[]): number | null {
  if (!plans.length) return null;
  return Math.min(
    ...plans.map((plan) => Math.max(...plan.windows.map((window) => window.usedPercent))),
  );
}

/**
 * Why a connection's row shows what it shows. Only `ok` carries figures: `no_data` is a provider
 * that answered with nothing to report, `unavailable` one that publishes no usage for this kind of
 * connection, `not_signed_in` a sign-in or key the provider no longer accepts, and `error` a read
 * that failed.
 */
export const ProviderUsageStatusSchema = z.enum([
  "ok",
  "no_data",
  "unavailable",
  "not_signed_in",
  "error",
]);
export type ProviderUsageStatus = z.infer<typeof ProviderUsageStatusSchema>;

/**
 * Money a provider reports for a connection, in US dollars. Every figure is null unless the
 * provider reported it: a missing balance is unknown, never zero, and a null limit beside
 * reported spending is a key with no cap.
 */
export const ProviderCreditsSchema = z.object({
  usedUsd: z.number().nonnegative().nullable(),
  limitUsd: z.number().nonnegative().nullable(),
  remainingUsd: z.number().nullable(),
  /** How often the limit starts over, when it does. */
  period: z.enum(["day", "week", "month"]).nullable(),
  resetsAt: z.string().nullable(),
});
export type ProviderCredits = z.infer<typeof ProviderCreditsSchema>;

/** One connected model credential and the usage its provider reports for it, if any. */
export const ProviderUsageSchema = z.object({
  credentialId: z.string(),
  /** The provider's id, for its mark. */
  provider: z.string(),
  /** The provider or subscription as people know it. */
  name: z.string(),
  /** The connection's own name, which tells two connections to one provider apart. */
  label: z.string(),
  kind: z.enum(["subscription", "api_key"]),
  /** The plan's name as the provider reports it; null when it does not. */
  plan: z.string().nullable(),
  status: ProviderUsageStatusSchema,
  /** Rolling allowances, empty unless the provider reported some. */
  windows: z.array(PlanLimitWindowSchema),
  credits: ProviderCreditsSchema.nullable(),
  /** When the provider last answered; null when it never has. */
  readAt: z.string().nullable(),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

/** How used a connection's fullest allowance is, or null when it reports none. */
export function providerUsagePercent(usage: Pick<ProviderUsage, "windows">): number | null {
  if (!usage.windows.length) return null;
  return Math.max(...usage.windows.map((window) => window.usedPercent));
}

/** The soonest reset among a connection's allowances, or null when none is reported. */
export function providerUsageNextReset(usage: Pick<ProviderUsage, "windows">): string | null {
  const resets = usage.windows
    .map((window) => window.resetsAt)
    .filter((reset): reset is string => reset !== null)
    .sort();
  return resets[0] ?? null;
}

/** Connections with the least room first; ones reporting no allowance keep their order after. */
export function tightestProviderUsageFirst<T extends Pick<ProviderUsage, "windows">>(
  rows: readonly T[],
): T[] {
  return rows
    .map((row, index) => ({ row, index, used: providerUsagePercent(row) }))
    .sort((a, b) => (b.used ?? -1) - (a.used ?? -1) || a.index - b.index)
    .map(({ row }) => row);
}
