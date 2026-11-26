import type { BrowserDialog } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { urlSite } from "@rakazo/core/egress";
import type { FleetCardSummary } from "../../approvals/approval-ask.js";
import {
  cdpDeniedMessage,
  classifyCdpMethod,
  parseCdpCall,
} from "../../browser/browser-cdp-policy.js";
import {
  browserCdpFromTool,
  browserDialogFromTool,
  DIALOG_MESSAGE_MAX_CHARS,
  dialogApprovalOf,
  HARMLESS_DIALOG_TYPES,
  parseDialogCall,
} from "../../browser/browser-control-tools.js";
import { browserResultForModel } from "../../browser/browser-tools.js";
import type { RunContext } from "../assembly/run-context.js";
import { builtinOffered } from "../assembly/run-instructions.prompt.js";
import { computerScreenToolResult } from "../lifecycle/run-lifecycle.js";
import { refusal } from "../turn/tool-refusal.js";
import { auditToolCall } from "./run-tool-audit.js";
import type { ToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { screenBlocked } from "./run-tools-computer.js";

/** Tools that act on the page browser's open page beyond navigate, snapshot and act. */
export const BROWSER_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "browser_cdp",
  "browser_dialog",
]);

/** Whether this call can change the page: a dialog's answer, or a protocol command that acts. */
function browserControlMovesPage(name: string, args: Record<string, unknown>): boolean {
  if (name === "browser_dialog") return true;
  return name === "browser_cdp" && classifyCdpMethod(String(args.method ?? "")) !== "read";
}

function cdpSummary(method: string, params: Record<string, unknown> | undefined): FleetCardSummary {
  const lines = Object.entries(params ?? {}).map(
    ([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  return { title: `Run ${method} on the page?`, lines, onceOnly: true };
}

function dialogSummary(dialog: BrowserDialog & { site?: string }, text: string | undefined) {
  return {
    title: dialog.site ? `Accept the dialog on ${dialog.site}?` : "Accept the page's dialog?",
    lines: [dialog.message, ...(text !== undefined ? [`Answer: ${text}`] : [])],
    onceOnly: true,
  } satisfies FleetCardSummary;
}

/** The dialog the page has open now, as the browser reports it, or none when it cannot tell. */
async function openDialog(
  ctx: RunContext,
  name: string,
): Promise<(BrowserDialog & { site?: string }) | undefined> {
  const { browser } = ctx.providers;
  if (!browser.dialog || !ctx.computer.pageBrowserAllowed || ctx.computer.heldForTakeover)
    return undefined;
  try {
    const computer = await ctx.computer.get("tool", name);
    const status = await browser.dialog(
      computer,
      { action: "status", signal: ctx.context.signal },
      ctx.context,
    );
    if (!status.ok || !status.dialog) return undefined;
    const site = status.url ? urlSite(status.url) : undefined;
    return {
      type: status.dialog,
      // Stored with the approval and compared with the page's own text: a secret the page echoes
      // makes the two differ, and the dialog is then left open.
      message: redactSecrets(status.message ?? "", ctx.secrets).slice(0, DIALOG_MESSAGE_MAX_CHARS),
      ...(site ? { site } : {}),
    };
  } catch {
    ctx.context.signal.throwIfAborted();
    // Accepting then offers only an alert or "Leave site?", which the browser checks itself.
    return undefined;
  }
}

/**
 * Before the gate: a protocol method the policy refuses never reaches a card or the browser, and
 * one that can act on the page asks a person each time, as does accepting a confirm or prompt, which
 * can submit what the page asks about. Rewrites the request's arguments to what the browser runs.
 */
export async function prepareBrowserControlRequest(
  ctx: RunContext,
  request: ToolRequest,
): Promise<{ error: string } | undefined> {
  const { name, nextApprovedTool } = request;
  if (name === "browser_cdp") {
    const call = parseCdpCall(request.args);
    if ("error" in call) return refusal("browser_cdp_invalid", call.error);
    const kind = classifyCdpMethod(call.method);
    if (kind === "deny") {
      await auditToolCall(ctx, name, "denied", { reason: "cdp_policy", method: call.method });
      return refusal("browser_cdp_refused", cdpDeniedMessage(call.method));
    }
    request.args = { method: call.method, ...(call.params ? { params: call.params } : {}) };
    request.effectRequest = request.args;
    if (kind === "ask") {
      request.heldForApproval = true;
      request.personEveryTime = true;
      request.fleetSummary = cdpSummary(call.method, call.params);
    }
    return undefined;
  }
  if (name !== "browser_dialog") return undefined;
  const input = parseDialogCall(request.args);
  if ("error" in input) return refusal("browser_dialog_invalid", input.error);
  // The approval is written here from what the page shows; a model-supplied one is dropped, and an
  // approved replay keeps the one the user saw.
  let args: Record<string, unknown> = {
    action: input.action,
    ...(input.text !== undefined ? { prompt_text: input.text } : {}),
  };
  if (input.action === "accept") {
    const approved =
      nextApprovedTool === name ? dialogApprovalOf(request.args.dialogApproval) : undefined;
    const open = approved ?? (await openDialog(ctx, name));
    if (open && !HARMLESS_DIALOG_TYPES.includes(open.type)) {
      if (!approved && nextApprovedTool === name)
        return refusal(
          "dialog_not_approved",
          "The user has not approved accepting this dialog, so it was left open. Call browser_dialog again; that asks the user.",
        );
      args = { ...args, dialogApproval: { type: open.type, message: open.message } };
      request.heldForApproval = true;
      request.personEveryTime = true;
      request.fleetSummary = dialogSummary(open, input.text);
    }
  }
  request.args = args;
  request.effectRequest = args;
  return undefined;
}

/** browser_cdp and browser_dialog on the page the run's browser already has open. */
export async function browserControlTool(ctx: RunContext, call: ToolCall) {
  const { name, args } = call;
  const blocked = await screenBlocked(ctx);
  if (blocked) return call.finish({ error: blocked });
  if (browserControlMovesPage(name, args)) ctx.computer.checkpoint.markDirty();
  const options = {
    desktopTools:
      ctx.computer.graphicalToolsAllowed && builtinOffered(ctx.tools.disabled, "computer_act"),
    // Read when each result comes back, so a value filled since the call began is hidden too.
    redactions: () => [...ctx.secrets],
  };
  return computerScreenToolResult(async () => {
    const computer = await ctx.computer.get("tool", name);
    const result =
      name === "browser_dialog"
        ? await browserDialogFromTool(ctx.providers.browser, computer, ctx.context, args, {
            ...options,
            approved: dialogApprovalOf(args.dialogApproval),
          })
        : await browserCdpFromTool(ctx.providers.browser, computer, ctx.context, args, options);
    return browserResultForModel(result);
  }, call.finish);
}
