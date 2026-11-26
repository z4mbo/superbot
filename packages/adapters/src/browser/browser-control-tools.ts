import type {
  AdapterContext,
  BrowserDialog,
  BrowserDialogRequest,
  BrowserProvider,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { BROWSER_DIALOG_TYPES } from "@rakazo/adapter-kit";
import { cdpDeniedMessage, classifyCdpMethod, parseCdpCall } from "./browser-cdp-policy.js";
import {
  capCdpResult,
  redactCdpResult,
  redactCredentialText,
  secretForms,
} from "./browser-cdp-redaction.js";
import type { PageToolOptions } from "./browser-tools.js";
import { formatBrowserResult, redactBrowserResult } from "./browser-tools.js";

/** The answers browser_dialog gives, as its tool schema lists them. */
export const BROWSER_DIALOG_ACTIONS = ["accept", "dismiss"] as const;

/**
 * Dialogs whose OK confirms nothing: an alert only informs, and "Leave site?" leaves. A confirm or
 * prompt hands its answer to the page's script, which can submit a form or place an order on OK,
 * so accepting one needs a person's approval of that very dialog.
 */
export const HARMLESS_DIALOG_TYPES: readonly string[] = ["alert", "beforeunload"];

export const DIALOG_PROMPT_TEXT_MAX_CHARS = 2_000;
export const DIALOG_MESSAGE_MAX_CHARS = 300;

/** How much of a protocol result the model reads; the rest is cut with a marker. */
export const CDP_RESULT_MAX_CHARS = 10_000;

const NO_DIALOG_SUPPORT =
  "This computer's page browser cannot answer dialogs. Use request_takeover so the user can.";
const NO_CDP_SUPPORT = "This computer's page browser has no DevTools protocol access.";
export const NO_PAGE_MESSAGE =
  "No page is open in this run's browser, so nothing was sent. Open one with browser_navigate first.";
export const SECRET_ON_PAGE_MESSAGE =
  "This page holds a password or a saved login, card or code, so browser_cdp is off here and nothing was sent. Use browser_snapshot or browser_act.";
/** An image from before these commands answers that it does not know them. */
const OLDER_IMAGE = /^unknown command: (?:cdp|dialog)$/;
const OLDER_IMAGE_MESSAGE =
  "This computer runs an older image whose page browser lacks this tool. It works once the computer is updated.";

function refused(message: string) {
  return { ok: false, uncertain: false, error: message };
}

/** The approval a person gave to accept one confirm or prompt, as stored with the call. */
export function dialogApprovalOf(value: unknown): BrowserDialog | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { type, message } = value as Record<string, unknown>;
  if (typeof type !== "string" || typeof message !== "string") return undefined;
  if (!(BROWSER_DIALOG_TYPES as readonly string[]).includes(type)) return undefined;
  return { type, message: message.slice(0, DIALOG_MESSAGE_MAX_CHARS) };
}

export type DialogToolInput = {
  action: (typeof BROWSER_DIALOG_ACTIONS)[number];
  text?: string;
};

export function parseDialogCall(
  args: Record<string, unknown>,
): DialogToolInput | { error: string } {
  const action = typeof args.action === "string" ? args.action : "";
  if (!(BROWSER_DIALOG_ACTIONS as readonly string[]).includes(action))
    return { error: `browser_dialog needs action: ${BROWSER_DIALOG_ACTIONS.join(" or ")}` };
  const given = args.prompt_text;
  if (given === undefined || given === null) return { action: action as DialogToolInput["action"] };
  if (typeof given !== "string") return { error: "browser_dialog prompt_text must be text" };
  if (action !== "accept")
    return { error: "browser_dialog takes prompt_text only to accept a prompt dialog" };
  if (given.length > DIALOG_PROMPT_TEXT_MAX_CHARS)
    return {
      error: `browser_dialog prompt_text must be at most ${DIALOG_PROMPT_TEXT_MAX_CHARS} characters`,
    };
  return { action: "accept", text: given };
}

function olderImage(error: string | undefined): string | undefined {
  return error && OLDER_IMAGE.test(error) ? OLDER_IMAGE_MESSAGE : error;
}

/**
 * browser_dialog: accept or dismiss the JavaScript dialog the page has open. Dismissing always goes
 * ahead. Accepting goes ahead for an alert or "Leave site?" dialog, and for a confirm or prompt only
 * when `approved` names that same dialog: the browser leaves any other dialog open.
 */
export async function browserDialogFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: PageToolOptions & { approved?: BrowserDialog; redactions?: () => string[] } = {},
) {
  const input = parseDialogCall(args);
  if ("error" in input) return refused(input.error);
  if (!browser.dialog) return refused(NO_DIALOG_SUPPORT);
  const request: BrowserDialogRequest = {
    action: input.action,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.action === "accept"
      ? options.approved
        ? { expect: options.approved }
        : { only: [...HARMLESS_DIALOG_TYPES] }
      : {}),
    signal: context.signal,
  };
  const redactions = () => secretForms(options.redactions?.() ?? []);
  try {
    const result = await browser.dialog(computer, request, context);
    if (result.noPage) return refused(NO_PAGE_MESSAGE);
    const shown = { ...result, error: olderImage(result.error) };
    if (!shown.error) delete shown.error;
    // A confirm or prompt the call was not approved for is left open; the next call asks the user.
    if (
      !result.ok &&
      !result.answered &&
      input.action === "accept" &&
      result.dialog &&
      !HARMLESS_DIALOG_TYPES.includes(result.dialog)
    ) {
      return redactBrowserResult(
        {
          ...shown,
          note: "Nothing was answered. Call browser_dialog again to ask the user, or dismiss it.",
        },
        redactions(),
      );
    }
    return redactBrowserResult(
      formatBrowserResult(shown, { ...options, dialogTool: true }),
      redactions(),
    );
  } catch (error) {
    context.signal.throwIfAborted();
    return redactBrowserResult(
      {
        ok: false,
        // An answer that may have been sent is not sent again blind.
        uncertain: true,
        error: error instanceof Error ? error.message : String(error),
        note: "Check the page with browser_snapshot before answering again.",
      },
      redactions(),
    );
  }
}

/**
 * browser_cdp: one DevTools protocol command on the page's tab. A refused method never reaches the
 * browser, and neither does any command while the page holds a secret value. What comes back is
 * redacted twice (credential shapes, then the run's own secrets in every form) before it is cut to
 * size.
 */
export async function browserCdpFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: PageToolOptions & { redactions?: () => string[] } = {},
) {
  const call = parseCdpCall(args);
  if ("error" in call) return refused(call.error);
  if (classifyCdpMethod(call.method) === "deny") return refused(cdpDeniedMessage(call.method));
  if (!browser.cdp) return refused(NO_CDP_SUPPORT);
  // Read when the command answers: a fill during the call may have added one.
  const clean = (value: unknown) => {
    const secrets = options.redactions?.() ?? [];
    return redactBrowserResult(redactCdpResult(value, secrets), secretForms(secrets));
  };
  try {
    const result = await browser.cdp(computer, { ...call, signal: context.signal }, context);
    if (result.noPage) return refused(NO_PAGE_MESSAGE);
    if (result.secretOnPage) return refused(SECRET_ON_PAGE_MESSAGE);
    const page = {
      ...(typeof result.url === "string" ? { url: result.url } : {}),
      ...(typeof result.title === "string" ? { title: result.title } : {}),
    };
    if (!result.ok) {
      return clean(
        formatBrowserResult(
          {
            ok: false,
            method: call.method,
            ...page,
            ...(result.uncertain !== undefined ? { uncertain: result.uncertain } : {}),
            error: olderImage(result.error) ?? "The browser did not run the command.",
            ...(result.fallback ? { fallback: result.fallback } : {}),
          },
          options,
        ),
      );
    }
    const capped = capCdpResult(clean(result.result), CDP_RESULT_MAX_CHARS);
    return {
      ok: true,
      method: call.method,
      ...(clean(page) as object),
      ...capped,
      ...(result.truncated
        ? { note: "The browser cut a large result before sending it. Ask for less." }
        : {}),
    };
  } catch (error) {
    context.signal.throwIfAborted();
    return clean({
      ok: false,
      method: call.method,
      uncertain: classifyCdpMethod(call.method) !== "read",
      error: redactCredentialText(error instanceof Error ? error.message : String(error)),
    });
  }
}
