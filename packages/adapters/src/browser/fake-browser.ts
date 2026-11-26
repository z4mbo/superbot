import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserCdpRequest,
  BrowserCdpResult,
  BrowserDialog,
  BrowserDialogRequest,
  BrowserDialogResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  ComputerRef,
  SignInFillCall,
} from "@rakazo/adapter-kit";
import { emulatorExtensionFill } from "../sign-in-sources/sign-in-source-emulator.js";
import { fetchSafeWebText } from "../web/web-ssrf.js";
import type { PageBrowserSession } from "./page-browser-session.js";
import { PageBrowserSessionStore, pageBrowserSessionKey } from "./page-browser-session.js";

export interface FakeBrowserProviderOptions {
  /** Inject HTML for a URL without hitting the network (offline tests). */
  pages?: Record<string, { title?: string; html: string }>;
  fetch?: typeof globalThis.fetch;
}

/**
 * In-process page browser for offline tests and keyless core. Not a hosted
 * browser vendor: sessions are keyed by computer id so tools stay computer-scoped.
 */
export class FakeBrowserProvider implements BrowserProvider {
  readonly sessions = new PageBrowserSessionStore();
  private readonly pages: Record<string, { title?: string; html: string }>;
  private readonly fetchImpl?: typeof globalThis.fetch;
  navigateError?: Error;
  snapshotError?: Error;
  actError?: Error;
  /** When set, every method returns computer_act fallback (fallback-path tests). */
  forceFallback?: string;
  /** The next act that completes opens this dialog, as a page's click handler would. */
  nextActOpensDialog?: BrowserDialog;
  /** What each DevTools protocol method answers; any other is unknown to the browser. */
  readonly cdpResults = new Map<string, unknown>([
    ["Page.getLayoutMetrics", { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } }],
  ]);
  /** Every DevTools protocol command the browser received, oldest first. */
  readonly cdpCalls: BrowserCdpRequest[] = [];

  constructor(options: FakeBrowserProviderOptions = {}) {
    this.pages = options.pages ?? {};
    this.fetchImpl = options.fetch;
  }

  describe() {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        page: true,
        refs: true,
        keyless: true,
      },
    };
  }

  async navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    if (this.forceFallback) {
      return {
        url: request.url,
        title: "",
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.navigateError) throw this.navigateError;
    const url = request.url.trim();
    if (!url) {
      return { url: "", title: "", fallback: "computer_act", error: "url is required" };
    }
    const session = this.sessions.get(pageBrowserSessionKey(computer, context));
    const seeded = this.pages[url] ?? this.pages[stripHash(url)];
    if (seeded) {
      const html = seeded.title ? ensureTitle(seeded.html, seeded.title) : seeded.html;
      return session.load(url, html);
    }
    try {
      const { url: finalUrl, body } = await fetchSafeWebText(url, {
        fetch: this.fetchImpl,
        signal: request.signal ?? context.signal,
      });
      return session.load(finalUrl, body);
    } catch (error) {
      return {
        url,
        title: "",
        fallback: "computer_act",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async snapshot(
    computer: ComputerRef,
    _request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult> {
    if (this.forceFallback) {
      return {
        url: "",
        title: "",
        tree: "",
        elements: [],
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.snapshotError) throw this.snapshotError;
    const session = this.sessions.get(pageBrowserSessionKey(computer, context));
    const blocked = dialogBlocked(session);
    if (blocked) return { url: "", title: "", tree: "", elements: [], ...blocked };
    return session.snapshot();
  }

  async act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult> {
    if (this.forceFallback) {
      return {
        ok: false,
        completed: 0,
        url: "",
        title: "",
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.actError) throw this.actError;
    if (!request.actions?.length) {
      return {
        ok: false,
        completed: 0,
        url: this.sessions.get(pageBrowserSessionKey(computer, context)).url,
        title: this.sessions.get(pageBrowserSessionKey(computer, context)).title,
        error: "actions is required",
        fallback: "computer_act",
      };
    }
    const session = this.sessions.get(pageBrowserSessionKey(computer, context));
    const blocked = dialogBlocked(session);
    if (blocked)
      return { ok: false, completed: 0, uncertain: false, url: "", title: "", ...blocked };
    const result = session.act(request.actions);
    const opens = this.nextActOpensDialog;
    if (!result.ok || !opens) return result;
    this.nextActOpensDialog = undefined;
    session.dialog = opens;
    const stops = dialogBlocked(session);
    // An alert only informs: it is closed and its message noted, as the computer's helper does.
    if (!stops)
      return {
        ...result,
        note: `The page showed an alert, now closed${opens.message ? `: ${JSON.stringify(opens.message)}` : ""}.`,
      };
    const { tree: _tree, elements: _elements, ...page } = result;
    return { ...page, ok: false, uncertain: false, ...stops };
  }

  /** The page this computer's browser has open, if browser_navigate opened one; never a new one. */
  private openPage(computer: ComputerRef, context: AdapterContext): PageBrowserSession | undefined {
    const session = this.sessions.peek(pageBrowserSessionKey(computer, context));
    return session && session.url !== "about:blank" ? session : undefined;
  }

  /** Reads or answers the dialog a test opened, as the computer's helper does on a real page. */
  async dialog(
    computer: ComputerRef,
    request: BrowserDialogRequest,
    context: AdapterContext,
  ): Promise<BrowserDialogResult> {
    context.signal.throwIfAborted();
    const session = this.openPage(computer, context);
    if (!session) return { ok: false, uncertain: false, noPage: true, error: NO_PAGE_OPEN };
    const open = session.dialog;
    const page = { url: session.url, title: session.title };
    if (request.action === "status")
      return { ok: true, ...page, ...(open ? { dialog: open.type, message: open.message } : {}) };
    if (!open) return { ok: false, uncertain: false, ...page, error: NO_DIALOG_OPEN };
    const shown = { dialog: open.type, message: open.message };
    if (
      request.action === "accept" &&
      (request.expect
        ? request.expect.type !== open.type || request.expect.message !== open.message
        : request.only && !request.only.includes(open.type))
    ) {
      return {
        ok: false,
        uncertain: false,
        ...page,
        ...shown,
        error: request.expect ? DIALOG_CHANGED : dialogNeedsApproval(open.type),
      };
    }
    session.dialog = undefined;
    session.dialogAnswers.push({
      ...open,
      action: request.action,
      ...(request.action === "accept" && open.type === "prompt" && request.text !== undefined
        ? { text: request.text }
        : {}),
    });
    return { ok: true, answered: true, ...shown, ...session.snapshot() };
  }

  /** Answers from `cdpResults`, and records each command. */
  async cdp(
    computer: ComputerRef,
    request: BrowserCdpRequest,
    context: AdapterContext,
  ): Promise<BrowserCdpResult> {
    context.signal.throwIfAborted();
    const session = this.openPage(computer, context);
    if (!session) return { ok: false, uncertain: false, noPage: true, error: NO_PAGE_OPEN };
    const page = { url: session.url, title: session.title };
    if (session.holdsSecret())
      return { ok: false, uncertain: false, secretOnPage: true, ...page, error: SECRET_ON_PAGE };
    const { signal: _signal, ...sent } = request;
    this.cdpCalls.push(sent);
    if (!this.cdpResults.has(request.method))
      return { ok: false, uncertain: false, ...page, error: `'${request.method}' wasn't found` };
    return { ok: true, ...page, result: this.cdpResults.get(request.method) };
  }

  /**
   * The offline sign-in source's extension, as if installed in this browser: it fills the login
   * the call names into the page's sign-in form. Calls for any other source fail.
   */
  async signInFill(
    computer: ComputerRef,
    request: { origin: string; call: SignInFillCall },
    context: AdapterContext,
  ): Promise<unknown> {
    context.signal.throwIfAborted();
    const answer = emulatorExtensionFill(request.call);
    if ("status" in answer) return answer;
    const session = this.sessions.get(pageBrowserSessionKey(computer, context));
    return { status: session.fillLogin(request.origin, answer.login) };
  }
}

const NO_DIALOG_OPEN = "No dialog is open on the page.";
const NO_PAGE_OPEN = "No page is open in the browser.";
const SECRET_ON_PAGE = "The page holds a password or a saved login or card detail.";
const DIALOG_CHANGED =
  "The dialog on the page is not the one the user approved, so it was left open.";

function dialogNeedsApproval(type: string): string {
  return `Accepting a ${type} dialog needs the user's approval, so it was left open.`;
}

/**
 * What a page read or action reports while a dialog is open, as the computer's helper does: an
 * alert is closed and its message noted, and any other dialog stops the page tools.
 */
function dialogBlocked(
  session: PageBrowserSession,
): { error: string; dialog: string; fallback: "computer_act" } | undefined {
  const open = session.dialog;
  if (!open) return undefined;
  const quoted = open.message ? `: ${JSON.stringify(open.message)}` : "";
  if (open.type === "alert") {
    session.dialog = undefined;
    session.dialogAnswers.push({ ...open, action: "accept" });
    return undefined;
  }
  const name = open.type === "beforeunload" ? '"Leave site?"' : open.type;
  return {
    error: `A ${name} dialog is open on the screen${quoted}`,
    dialog: open.type,
    fallback: "computer_act",
  };
}

function stripHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function ensureTitle(html: string, title: string): string {
  if (/<title[\s>]/i.test(html)) {
    return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  }
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1><title>${escapeHtml(title)}</title>`);
  }
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
