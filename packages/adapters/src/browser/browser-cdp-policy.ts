/**
 * Which DevTools protocol methods browser_cdp may send to the page's tab, decided from the method
 * name alone, before anything reaches the browser. Names match exactly and case-sensitively.
 *
 * - "read": the method only reads the tab and changes nothing, so it runs like browser_snapshot.
 * - "ask": the method can act on the page as a person at it could (run script, type, click,
 *   restyle, emulate a device). A person approves each call.
 * - "deny": refused in every approval mode. Every domain not named in CDP_ASK_DOMAINS, known or
 *   new, is refused whole: cookies and site storage, request interception and anything that shows
 *   request or response headers or bodies (all of Network, Fetch, Audits, IO), other tabs and the
 *   browser itself (Target, Browser), downloads, permissions and the machine, security relaxations,
 *   the debugger and heap (which read whatever the page keeps in memory), and saved credentials.
 *   In the domains that are allowed, single methods are refused too: navigation, which must go
 *   through browser_navigate so the site gate and address checks see it; answering a dialog
 *   outside browser_dialog; handing the page files from the computer; reading a resource's body;
 *   and scripts that outlive the call.
 */
export type CdpMethodClass = "read" | "ask" | "deny";

/**
 * Methods that only read the page's own tab and each work on their own, in a fresh protocol
 * session: what they return is the tab's structure, never a request's headers or body.
 */
export const CDP_READ_METHODS: ReadonlySet<string> = new Set([
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Accessibility.queryAXTree",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getNodeForLocation",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Performance.getMetrics",
]);

/**
 * The only domains whose methods may run: each acts on this page as a person at it could. Their
 * methods ask unless they are read methods above or refused below.
 */
export const CDP_ASK_DOMAINS: ReadonlySet<string> = new Set([
  "Accessibility",
  "Animation",
  "CSS",
  "DOM",
  "DOMSnapshot",
  "Emulation",
  "Input",
  "LayerTree",
  "Overlay",
  "Page",
  "Performance",
  "PerformanceTimeline",
  "Runtime",
]);

/** Methods refused although their domain may run. */
export const CDP_DENIED_METHODS: ReadonlySet<string> = new Set([
  // Navigation: browser_navigate checks the address and the site first.
  "Page.navigate",
  "Page.reload",
  "Page.navigateToHistoryEntry",
  "Page.resetNavigationHistory",
  // Scripts and worlds that outlive the call, run in every document the tab opens next, or hide from it.
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Page.addScriptToEvaluateOnLoad",
  "Page.removeScriptToEvaluateOnLoad",
  "Page.createIsolatedWorld",
  "Runtime.addBinding",
  "Runtime.removeBinding",
  // Walks the page's heap, which holds whatever the page keeps in memory, tokens included.
  "Runtime.queryObjects",
  // A resource's body, or the whole page with its resources, can carry tokens the page fetched.
  "Page.getResourceContent",
  "Page.searchInResource",
  "Page.captureSnapshot",
  // Dialogs are answered with browser_dialog, which checks them first.
  "Page.handleJavaScriptDialog",
  // Files from the computer handed to the page, which browser_act upload confines.
  "DOM.setFileInputFiles",
  "DOM.getFileInfo",
  "Input.dispatchDragEvent",
  "Input.setInterceptDrags",
  // Downloads, payment and protocol-handler prompts answered unasked, and a weaker content policy.
  "Page.setDownloadBehavior",
  "Page.setSPCTransactionMode",
  "Page.setRPHRegistrationMode",
  "Page.setBypassCSP",
  // The tab itself, and test hooks that pause or crash it.
  "Page.close",
  "Page.crash",
  "Page.waitForDebugger",
  "Page.generateTestReport",
  "Page.produceCompilationCache",
  "Page.addCompilationCache",
  "Page.clearCompilationCache",
]);

const CDP_METHOD = /^[A-Z][A-Za-z]{0,39}\.[a-z][A-Za-z]{0,79}$/;

export function isCdpMethodName(method: string): boolean {
  return CDP_METHOD.test(method);
}

export function classifyCdpMethod(method: string): CdpMethodClass {
  if (!isCdpMethodName(method)) return "deny";
  if (CDP_READ_METHODS.has(method)) return "read";
  const domain = method.slice(0, method.indexOf("."));
  if (!CDP_ASK_DOMAINS.has(domain) || CDP_DENIED_METHODS.has(method)) return "deny";
  return "ask";
}

/** The most a call's params may hold once serialized. */
export const CDP_PARAMS_MAX_CHARS = 16_000;

export type CdpCall = { method: string; params?: Record<string, unknown> };

/** A browser_cdp call as the browser receives it, or why it was refused before anything ran. */
export function parseCdpCall(args: Record<string, unknown>): CdpCall | { error: string } {
  // Matched as given: a name with spaces or another case is not the method it resembles.
  const method = typeof args.method === "string" ? args.method : "";
  if (!isCdpMethodName(method))
    return {
      error: "browser_cdp needs method: a DevTools protocol method such as DOM.getDocument",
    };
  const params = args.params;
  if (params === undefined || params === null) return { method };
  if (typeof params !== "object" || Array.isArray(params))
    return { error: "browser_cdp params must be an object" };
  let serialized: string;
  try {
    serialized = JSON.stringify(params);
  } catch {
    return { error: "browser_cdp params must be plain JSON" };
  }
  if (serialized.length > CDP_PARAMS_MAX_CHARS)
    return { error: `browser_cdp params must be at most ${CDP_PARAMS_MAX_CHARS} characters` };
  return { method, params: JSON.parse(serialized) as Record<string, unknown> };
}

/** What the model is told when a method is refused outright. */
export function cdpDeniedMessage(method: string): string {
  return `browser_cdp refuses ${method || "this method"}: it reads cookies, storage, request headers or bodies, navigates, reaches beyond this page's tab, or weakens a browser check. Nothing was sent. Use browser_navigate, browser_snapshot, browser_act or browser_dialog instead.`;
}
