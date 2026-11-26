import { describe, expect, it } from "vitest";
import {
  CDP_ASK_DOMAINS,
  CDP_DENIED_METHODS,
  CDP_PARAMS_MAX_CHARS,
  CDP_READ_METHODS,
  classifyCdpMethod,
  parseCdpCall,
} from "./browser-cdp-policy.js";

describe("classifyCdpMethod", () => {
  it.each([...CDP_READ_METHODS])("lets %s read the page as browser_snapshot does", (method) => {
    expect(classifyCdpMethod(method)).toBe("read");
  });

  it.each([
    "Runtime.evaluate",
    "Runtime.callFunctionOn",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "DOM.setAttributeValue",
    "DOM.getOuterHTML",
    "DOM.querySelector",
    "CSS.setStyleTexts",
    "Emulation.setDeviceMetricsOverride",
    "Overlay.highlightNode",
    "Page.captureScreenshot",
    "Page.stopLoading",
    "DOMSnapshot.captureSnapshot",
    "Animation.setPlaybackRate",
  ])(
    "asks a person before %s, which acts on the page or reads more than its structure",
    (method) => {
      expect(classifyCdpMethod(method)).toBe("ask");
    },
  );

  describe("refuses in every mode", () => {
    it.each([
      // Cookies, site storage and saved credentials.
      "Network.getCookies",
      "Network.getAllCookies",
      "Network.setCookie",
      "Network.deleteCookies",
      "Storage.getCookies",
      "Storage.clearDataForOrigin",
      "DOMStorage.getDOMStorageItems",
      "IndexedDB.requestData",
      "CacheStorage.requestCachedResponse",
      "Autofill.trigger",
      "WebAuthn.getCredentials",
      "FedCm.selectAccount",
    ])("%s, which holds cookies, storage or credentials", (method) => {
      expect(classifyCdpMethod(method)).toBe("deny");
    });

    it.each([
      // Request and response headers and bodies, and the event streams that carry them.
      "Network.enable",
      "Network.getResponseBody",
      "Network.getRequestPostData",
      "Network.searchInResponseBody",
      "Network.setExtraHTTPHeaders",
      "Network.loadNetworkResource",
      "Network.replayXHR",
      "Network.streamResourceContent",
      "Fetch.enable",
      "Fetch.getResponseBody",
      "Audits.getEncodedResponse",
      "IO.read",
      "Log.enable",
      "Page.getResourceContent",
      "Page.searchInResource",
      "Page.captureSnapshot",
    ])("%s, which shows request headers, response bodies or what a page fetched", (method) => {
      expect(classifyCdpMethod(method)).toBe("deny");
    });

    it.each([
      // Memory: closures, heap and profiles hold what the page keeps, tokens included.
      "Debugger.enable",
      "Debugger.evaluateOnCallFrame",
      "Debugger.getScriptSource",
      "HeapProfiler.takeHeapSnapshot",
      "Runtime.queryObjects",
      "Memory.getDOMCounters",
      "Profiler.start",
      "DOMDebugger.setDOMBreakpoint",
      "EventBreakpoints.setInstrumentationBreakpoint",
    ])("%s, which reads the page's memory or pauses it", (method) => {
      expect(classifyCdpMethod(method)).toBe("deny");
    });

    it.each([
      // Navigation and opening anything, which browser_navigate checks.
      "Page.navigate",
      "Page.reload",
      "Page.navigateToHistoryEntry",
      "Page.resetNavigationHistory",
      "Page.createIsolatedWorld",
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.addScriptToEvaluateOnLoad",
      "Runtime.addBinding",
      "Target.createTarget",
      "Target.attachToTarget",
      "Target.setAutoAttach",
      "Target.getTargets",
    ])("%s, which navigates, opens a tab or outlives the call", (method) => {
      expect(classifyCdpMethod(method)).toBe("deny");
    });

    it.each([
      // The browser, the machine, downloads, permissions and files.
      "Browser.close",
      "Browser.grantPermissions",
      "Browser.setDownloadBehavior",
      "Page.setDownloadBehavior",
      "SystemInfo.getInfo",
      "Tracing.start",
      "ServiceWorker.enable",
      "BackgroundService.startObserving",
      "DOM.setFileInputFiles",
      "DOM.getFileInfo",
      "Input.dispatchDragEvent",
      "Input.setInterceptDrags",
      "FileSystem.getDirectory",
      "Extensions.loadUnpacked",
      "PWA.install",
      "Tethering.bind",
      "Cast.startTabMirroring",
      "DeviceAccess.selectPrompt",
    ])("%s, which reaches past this tab", (method) => {
      expect(classifyCdpMethod(method)).toBe("deny");
    });

    it.each([
      // Security relaxations, unasked prompts and dialogs answered outside browser_dialog.
      "Security.setIgnoreCertificateErrors",
      "Page.setBypassCSP",
      "Page.setSPCTransactionMode",
      "Page.setRPHRegistrationMode",
      "Page.handleJavaScriptDialog",
      "Page.close",
      "Page.crash",
    ])("%s, which weakens a check or answers what a person should", (method) => {
      expect(classifyCdpMethod(method)).toBe("deny");
    });

    it.each([
      // Unknown domains and methods never read, and a new domain is refused until it is reviewed.
      "Preload.enable",
      "WebAudio.enable",
      "Schema.getDomains",
      "Media.enable",
      "Inspector.enable",
      "Console.enable",
      "Database.executeSQL",
      "SmartCardEmulation.enable",
      "Brandnew.read",
      "Rakazo.getSecrets",
    ])("%s, a domain that is not reviewed as one that acts on the page", (method) => {
      expect(classifyCdpMethod(method)).toBe("deny");
    });

    it("an unknown method of a domain that may run asks, never reads", () => {
      expect(classifyCdpMethod("DOM.getEverythingNew")).toBe("ask");
      expect(classifyCdpMethod("Page.getSomethingNew")).toBe("ask");
    });

    it.each([
      "",
      "Runtime",
      "runtime.evaluate",
      "RUNTIME.EVALUATE",
      "Runtime.Evaluate",
      " Runtime.evaluate",
      "Runtime.evaluate ",
      "Runtime..evaluate",
      "Runtime.evaluate.call",
      "Page.navigate\n",
      "DOM.getDocument;Page.navigate",
      "Dom.getDocument",
      "Page/navigate",
      "Pagе.getFrameTree",
      `A${"a".repeat(40)}.get`,
      `DOM.${"a".repeat(81)}`,
    ])("malformed name %j", (method) => {
      expect(classifyCdpMethod(method)).toBe("deny");
    });
  });

  it("refuses only methods of domains that may otherwise run", () => {
    for (const method of CDP_DENIED_METHODS) {
      expect(CDP_ASK_DOMAINS.has(method.slice(0, method.indexOf(".")))).toBe(true);
    }
    for (const method of CDP_READ_METHODS) {
      expect(CDP_ASK_DOMAINS.has(method.slice(0, method.indexOf(".")))).toBe(true);
      expect(CDP_DENIED_METHODS.has(method)).toBe(false);
    }
  });
});

describe("parseCdpCall", () => {
  it("takes the method exactly as given and plain JSON params", () => {
    expect(parseCdpCall({ method: "DOM.getDocument", params: { depth: 2 } })).toEqual({
      method: "DOM.getDocument",
      params: { depth: 2 },
    });
    expect(parseCdpCall({ method: "DOM.getDocument", params: null })).toEqual({
      method: "DOM.getDocument",
    });
    // Not trimmed: a padded name is not the method it resembles.
    expect(parseCdpCall({ method: " DOM.getDocument" })).toHaveProperty("error");
  });

  it.each([
    [{}, "needs method"],
    [{ method: 5 }, "needs method"],
    [{ method: "DOM.getDocument", params: [1] }, "must be an object"],
    [{ method: "DOM.getDocument", params: "{}" }, "must be an object"],
    [{ method: "DOM.getDocument", params: { text: "x".repeat(CDP_PARAMS_MAX_CHARS) } }, "at most"],
  ])("refuses %j", (args, message) => {
    expect(parseCdpCall(args as Record<string, unknown>)).toEqual({
      error: expect.stringContaining(message),
    });
  });

  it("refuses params that are not plain JSON", () => {
    const params: Record<string, unknown> = {};
    params.self = params;
    expect(parseCdpCall({ method: "DOM.getDocument", params })).toEqual({
      error: expect.stringContaining("plain JSON"),
    });
  });
});
