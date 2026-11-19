import { humanizeToolName } from "@rakazo/core";
import type { AuditEventInput } from "@rakazo/db";
import { recordAuditEvent } from "@rakazo/db";
import type { RunContext } from "../assembly/run-context.js";
import type { AppliedEffect } from "./run-tool-gate.js";

/** A bot's consequential tool call, recorded in its organization's audit log. */
export async function auditToolCall(
  ctx: RunContext,
  tool: string,
  outcome: "success" | "failure" | "denied",
  metadata: AuditEventInput["metadata"],
  recorded: Pick<AuditEventInput, "action" | "actor"> = {
    action: "tool.call",
    actor: { type: "bot", id: ctx.bot.id, label: ctx.bot.name },
  },
): Promise<void> {
  await recordAuditEvent({
    ...recorded,
    spaceId: ctx.run.spaceId,
    target: { type: "tool", id: tool, label: humanizeToolName(tool) },
    outcome,
    runId: ctx.runId,
    threadId: ctx.thread.id,
    metadata,
  });
}

export function auditAutoReview(
  ctx: RunContext,
  tool: string,
  applied: AppliedEffect | undefined,
  decision: string,
  model: string | undefined,
): Promise<void> {
  return auditToolCall(
    ctx,
    tool,
    decision === "error" ? "failure" : "success",
    { effectId: applied?.effect.id, decision },
    { action: "approval.auto_reviewed", actor: { type: "system", label: model } },
  );
}
