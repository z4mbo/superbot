import { CARD_TITLE_ESCAPED_CHARACTERS, formatCron } from "@rakazo/core";
import type { FleetCardSummary } from "../approvals/approval-ask.js";
import { boundDirectApprovalDetails } from "../approvals/approval-effect.js";
import type { RunContext } from "../runs/assembly/run-context.js";
import { CATALOG_APPROVAL_TOOL } from "../runs/lifecycle/run-effects.js";
import {
  compactScheduleInput,
  isScheduleValueProvided,
  scheduleCreateError,
  scheduleTimingArgs,
} from "../tools/schedule-tools.js";
import { CHECK_IN_ALREADY_DISMISSED, checkInPrompt } from "./task-threads.prompt.js";

/**
 * The tool a bot calls to offer the person a check-in on something they just discussed. It
 * creates nothing itself: its call waits on the person's answer as an approval card, accepting
 * runs it, which sets the routine up through schedule_create's own code, and turning it down is
 * kept as that denied call, so the same offer is not made again in this conversation.
 */
export const OFFER_CHECK_IN_TOOL = "offer_check_in";

/** What to check, in the few words the person reads on the card and in Routines. */
function subjectOf(args: Record<string, unknown>): string {
  return String(args.subject ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The timing methods an offer takes, named in its refusal when it gives none or several. */
export const CHECK_IN_TIMING_REQUIRED =
  "Give exactly one timing: cron, or every with unit, to repeat; runAt or delayMinutes for once.";

/**
 * Why an offer's timing is refused before anything else: its schema leaves every timing field
 * optional, so exactly one method is checked here. Null or blank fields count as not given.
 */
export function checkInTimingError(args: Record<string, unknown>): string | undefined {
  const given = (name: string) => isScheduleValueProvided(args[name]);
  if (given("every") !== given("unit"))
    return `every and unit go together. ${CHECK_IN_TIMING_REQUIRED}`;
  const methods = [given("cron"), given("every"), given("runAt"), given("delayMinutes")];
  if (given("delaySeconds") || methods.filter(Boolean).length !== 1)
    return CHECK_IN_TIMING_REQUIRED;
  return undefined;
}

/** The routine an accepted offer creates, as createScheduleFromTool takes it. */
export function checkInSchedule(args: Record<string, unknown>) {
  const subject = subjectOf(args);
  return {
    name: subject,
    prompt: subject ? checkInPrompt(subject, String(args.prompt ?? "").trim()) : "",
    inChat: false,
    timezone: isScheduleValueProvided(args.timezone) ? String(args.timezone) : undefined,
    schedule: compactScheduleInput(scheduleTimingArgs(args)),
    on: undefined,
  };
}

/** When the check-in runs, in words for its card. */
export function checkInTiming(args: Record<string, unknown>): string {
  const timing = compactScheduleInput(scheduleTimingArgs(args));
  if (typeof timing.cron === "string") {
    const words = formatCron(timing.cron);
    return words.charAt(0).toLowerCase() + words.slice(1);
  }
  if (timing.every !== undefined && typeof timing.unit === "string") {
    const every = Number(timing.every);
    const unit = every === 1 ? timing.unit.replace(/s$/, "") : timing.unit;
    return every === 1 ? `every ${unit}` : `every ${every} ${unit}`;
  }
  if (timing.runAt !== undefined) return `at ${String(timing.runAt)}`;
  const minutes = Number(timing.delayMinutes ?? Number(timing.delaySeconds ?? 0) / 60);
  if (minutes >= 60 && minutes % 60 === 0)
    return minutes === 60 ? "in an hour" : `in ${minutes / 60} hours`;
  return minutes === 1 ? "in a minute" : `in ${Math.max(Math.round(minutes), 1)} minutes`;
}

/** The offer's card: what to check and when as its title, and what each check-in does under it. */
export function checkInOfferSummary(args: Record<string, unknown>): FleetCardSummary {
  const subject = subjectOf(args).replace(new RegExp(CARD_TITLE_ESCAPED_CHARACTERS, "g"), "\\$&");
  const prompt = String(args.prompt ?? "").trim();
  return {
    title: `Check in on ${subject} ${checkInTiming(args)}?`,
    lines: prompt ? [prompt] : [],
    checkInOffer: true,
  };
}

/**
 * Why an offer is not shown: the person already turned the same check-in down in this
 * conversation, or the routine it would create cannot be saved. Checked before its card.
 */
export async function checkInOfferRefusal(
  ctx: RunContext,
  args: Record<string, unknown>,
): Promise<{ error: string } | undefined> {
  const { deps, run, bot, thread } = ctx;
  const subject = subjectOf(args).toLowerCase();
  if (!subject) return { error: "subject is required" };
  const timingError = checkInTimingError(args);
  if (timingError) return { error: timingError };
  const turnedDown = await deps.prisma.externalEffect.findMany({
    where: {
      spaceId: run.spaceId,
      kind: OFFER_CHECK_IN_TOOL,
      status: "denied",
      run: { threadId: thread.id, botId: bot.id },
    },
    select: { request: true, result: true },
  });
  // A refusal carries a result; only the person's own answer leaves none.
  const dismissed = turnedDown.some((effect) => {
    if (effect.result != null) return false;
    const request =
      boundDirectApprovalDetails(effect.request, CATALOG_APPROVAL_TOOL)?.args ?? effect.request;
    return (
      typeof request === "object" &&
      request !== null &&
      subjectOf(request as Record<string, unknown>).toLowerCase() === subject
    );
  });
  if (dismissed) return { error: CHECK_IN_ALREADY_DISMISSED };
  const error = await scheduleCreateError(deps, {
    spaceId: run.spaceId,
    botId: bot.id,
    userId: run.userId,
    threadId: thread.id,
    ...checkInSchedule(args),
  });
  return error ? { error } : undefined;
}
