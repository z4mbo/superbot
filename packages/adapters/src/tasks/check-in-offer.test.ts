import { planActionGate, toolRequiresApproval, toolRequiresExplicitApproval } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApprovalAskBlock } from "../approvals/approval-ask.js";
import type { RunContext } from "../runs/assembly/run-context.js";
import type { ToolCall } from "../runs/tools/run-tool-gate.js";
import { taskThreadTools } from "../runs/tools/run-tools-task-threads.js";
import { createScheduleFromTool, scheduleCreateError } from "../tools/schedule-tools.js";
import {
  checkInOfferRefusal,
  checkInOfferSummary,
  checkInSchedule,
  checkInTiming,
} from "./check-in-offer.js";
import { CHECK_IN_ALREADY_DISMISSED } from "./task-threads.prompt.js";

vi.mock("../tools/schedule-tools.js", async (original) => ({
  ...(await original<typeof import("../tools/schedule-tools.js")>()),
  createScheduleFromTool: vi.fn(async () => ({ ok: true, routineId: "routine-1" })),
  scheduleCreateError: vi.fn(async () => undefined),
}));

const OFFER = {
  subject: "Launch brief in Notion",
  prompt: "Look for new comments and summarize them.",
  cron: "0 9 * * 1-5",
};

function harness(denied: { request: unknown; result: unknown }[] = []) {
  const findMany = vi.fn(async (_args: unknown) => denied);
  const ctx = {
    deps: { prisma: { externalEffect: { findMany } } },
    run: { id: "run-1", spaceId: "space", userId: "user", trigger: "user" },
    bot: { id: "bot" },
    thread: { id: "chat" },
  } as unknown as RunContext;
  return { ctx, findMany };
}

/** The card the request step describes and the gate shows. */
const offerCard = (args: Record<string, unknown>) =>
  buildApprovalAskBlock("effect-1", "offer_check_in", args, [], {
    summary: checkInOfferSummary(args),
  });

beforeEach(() => vi.clearAllMocks());

describe("offer_check_in", () => {
  it("always waits for the person's own answer, and Never ask cannot accept it for them", () => {
    expect(toolRequiresApproval("offer_check_in", false)).toBe(true);
    expect(toolRequiresExplicitApproval("offer_check_in")).toBe(true);
    const resolved = { decision: "allow", source: "default", matchingRules: [] } as never;
    const gate = (mode: "ask" | "auto" | "never") =>
      planActionGate({
        resolved,
        mode,
        mandatory: true,
        steerable: true,
        consequential: true,
        checkerConfigured: true,
      });
    expect(gate("ask")).toBe("ask");
    expect(gate("auto")).toBe("ask");
    expect(gate("never")).toBe("deny");
  });

  it("shows an accept or turn-down card that names what and when", () => {
    const block = offerCard(OFFER);
    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      text: expect.stringMatching(/^Check in on Launch brief in Notion .+\?$/),
      detail: OFFER.prompt,
      checkInOffer: true,
      actions: [
        { id: "allow", label: "Set it up" },
        { id: "deny", label: "No thanks" },
      ],
    });
  });

  it("escapes what it names, so the card title shows it as written", () => {
    const block = offerCard({ ...OFFER, subject: "the *launch* [brief]" });
    expect(block).toMatchObject({ text: expect.stringContaining("the \\*launch\\* \\[brief\\]") });
  });

  it("keeps an older reader's plain approval: its answers are the usual allow and deny", () => {
    const block = offerCard(OFFER);
    // A reader from before checkInOffer drops it and labels these as Allow once and Deny.
    expect(block.kind === "ask" && block.actions?.map((action) => action.id)).toEqual([
      "allow",
      "deny",
    ]);
    expect(block.kind === "ask" && block.actions?.some((action) => "outcome" in action)).toBe(
      false,
    );
  });

  it("creates nothing until accepted, then the routine through schedule_create's save", async () => {
    const { ctx } = harness();
    await checkInOfferRefusal(ctx, OFFER);
    expect(createScheduleFromTool).not.toHaveBeenCalled();
    const call = {
      name: "offer_check_in",
      args: OFFER,
      finish: async (result: unknown) => result,
    } as unknown as ToolCall;
    await expect(taskThreadTools.offer_check_in!(ctx, call)).resolves.toEqual({
      ok: true,
      routineId: "routine-1",
    });
    expect(createScheduleFromTool).toHaveBeenCalledExactlyOnceWith(ctx.deps, {
      spaceId: "space",
      botId: "bot",
      userId: "user",
      threadId: "chat",
      ...checkInSchedule(OFFER),
    });
    expect(checkInSchedule(OFFER)).toMatchObject({
      name: "Launch brief in Notion",
      prompt: expect.stringContaining(OFFER.prompt),
      inChat: false,
      schedule: { cron: OFFER.cron },
    });
  });

  it("is not offered again in this conversation once turned down", async () => {
    const dismissed = { request: { ...OFFER, subject: "launch brief in notion " }, result: null };
    const { ctx, findMany } = harness([dismissed]);
    await expect(checkInOfferRefusal(ctx, OFFER)).resolves.toEqual({
      error: CHECK_IN_ALREADY_DISMISSED,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "offer_check_in",
          status: "denied",
          run: { threadId: "chat", botId: "bot" },
        }),
      }),
    );
    // Another subject, or a call refused rather than answered, is still free to offer.
    await expect(checkInOfferRefusal(ctx, { ...OFFER, subject: "Inbox" })).resolves.toBeUndefined();
    const refused = harness([{ request: OFFER, result: { refused: "repeat" } }]);
    await expect(checkInOfferRefusal(refused.ctx, OFFER)).resolves.toBeUndefined();
    // Turning it down never ran the call, so no routine was made.
    expect(createScheduleFromTool).not.toHaveBeenCalled();
  });

  it("shows no card for a routine that could not be saved", async () => {
    vi.mocked(scheduleCreateError).mockResolvedValueOnce("cron must be a 5-field cron expression.");
    const { ctx } = harness();
    await expect(checkInOfferRefusal(ctx, { ...OFFER, cron: "nope" })).resolves.toEqual({
      error: "cron must be a 5-field cron expression.",
    });
  });

  it.each([
    [{ every: 1, unit: "days" }, "every day"],
    [{ every: 2, unit: "hours" }, "every 2 hours"],
    [{ delayMinutes: 120 }, "in 2 hours"],
    [{ delayMinutes: 30 }, "in 30 minutes"],
    [{ runAt: "2026-12-01T09:00" }, "at 2026-12-01T09:00"],
  ])("says when it runs: %o", (timing, words) => {
    expect(checkInTiming(timing)).toBe(words);
  });
});
