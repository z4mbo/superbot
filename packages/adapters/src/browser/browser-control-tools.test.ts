import type {
  AdapterContext,
  BrowserProvider,
  ComputerRef,
  PageBrowserCommand,
} from "@rakazo/adapter-kit";
import { REDACTED_MARKER } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { ComputerBrowserProvider } from "../computers/screens/computer-browser.js";
import {
  browserCdpFromTool,
  browserDialogFromTool,
  CDP_RESULT_MAX_CHARS,
  DIALOG_PROMPT_TEXT_MAX_CHARS,
  dialogApprovalOf,
  NO_PAGE_MESSAGE,
  parseDialogCall,
  SECRET_ON_PAGE_MESSAGE,
} from "./browser-control-tools.js";
import { FakeBrowserProvider } from "./fake-browser.js";

const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "space",
  userId: "u",
  signal: new AbortController().signal,
};
const url = "https://shop.example.test/cart";
const html = `<!doctype html><html><head><title>Cart</title></head><body>
  <label>Coupon <input name="coupon" /></label>
  <label>Password <input type="password" name="password" /></label>
  <button>Place order</button></body></html>`;

async function openPage() {
  const browser = new FakeBrowserProvider({ pages: { [url]: { title: "Cart", html } } });
  await browser.navigate(computer, { url }, context);
  return browser;
}

describe("browser_cdp", () => {
  it("sends nothing when the run's browser has no page open, and never opens one", async () => {
    const browser = new FakeBrowserProvider();
    const result = await browserCdpFromTool(browser, computer, context, {
      method: "DOM.getDocument",
    });
    expect(result).toEqual({ ok: false, uncertain: false, error: NO_PAGE_MESSAGE });
    expect(browser.cdpCalls).toEqual([]);
    // No session was created by asking.
    expect(browser.sessions.peek("c1::b1")).toBeUndefined();
  });

  it("runs a read method on the open tab and returns its result", async () => {
    const browser = await openPage();
    const result = await browserCdpFromTool(browser, computer, context, {
      method: "Page.getLayoutMetrics",
    });
    expect(result).toMatchObject({
      ok: true,
      method: "Page.getLayoutMetrics",
      url,
      title: "Cart",
      result: { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } },
    });
    expect(browser.cdpCalls).toEqual([{ method: "Page.getLayoutMetrics" }]);
  });

  it.each(["Network.getAllCookies", "Page.navigate", "Target.createTarget", "Bogus.method", "x"])(
    "refuses %s before anything reaches the browser",
    async (method) => {
      const browser = await openPage();
      const result = await browserCdpFromTool(browser, computer, context, {
        method,
        params: { url: "file:///etc/passwd" },
      });
      expect(result).toMatchObject({ ok: false, uncertain: false });
      expect(browser.cdpCalls).toEqual([]);
    },
  );

  it("sends nothing while the page holds a typed password or a saved login it was filled with", async () => {
    const browser = await openPage();
    const snap = await browser.snapshot(computer, {}, context);
    const password = snap.elements.find((element) => element.name === "Password")!;
    await browser.act(
      computer,
      { actions: [{ kind: "fill", ref: password.ref, text: "hunter2" }] },
      context,
    );
    for (const method of ["DOM.getDocument", "Runtime.evaluate"]) {
      const result = await browserCdpFromTool(browser, computer, context, {
        method,
        params: { expression: "document.querySelector('[type=password]').value" },
      });
      expect(result).toEqual({ ok: false, uncertain: false, error: SECRET_ON_PAGE_MESSAGE });
    }
    expect(browser.cdpCalls).toEqual([]);
  });

  it("redacts credentials and the run's secrets in every form before the model sees them", async () => {
    const browser = await openPage();
    const secret = "fake-run-secret-9";
    browser.cdpResults.set("Runtime.evaluate", {
      result: {
        type: "object",
        value: {
          headers: { Authorization: "Bearer zzz", "Set-Cookie": "sid=1" },
          echoed: `the page says ${secret}`,
          encoded: encodeURIComponent(`${secret}?`),
          url: "https://api.example.test/?access_token=abc&x=1",
        },
      },
    });
    const result = await browserCdpFromTool(
      browser,
      computer,
      context,
      { method: "Runtime.evaluate", params: { expression: "x" } },
      { redactions: () => [secret] },
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain("zzz");
    expect(text).not.toContain("sid=1");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("access_token=abc");
    expect(text).toContain(REDACTED_MARKER);
  });

  it("cuts a large result to its size limit with a marker", async () => {
    const browser = await openPage();
    browser.cdpResults.set("DOM.getDocument", { root: { text: "x".repeat(50_000) } });
    const result = (await browserCdpFromTool(browser, computer, context, {
      method: "DOM.getDocument",
    })) as { resultText: string; truncated: boolean };
    expect(result.truncated).toBe(true);
    expect(result.resultText.length).toBeLessThan(CDP_RESULT_MAX_CHARS + 50);
    expect(result.resultText).toMatch(/characters cut\]$/);
  });

  it("says when a browser has no protocol access, or runs an older computer image", async () => {
    const browser = await openPage();
    const plain: BrowserProvider = {
      describe: () => browser.describe(),
      navigate: (...args) => browser.navigate(...args),
      snapshot: (...args) => browser.snapshot(...args),
      act: (...args) => browser.act(...args),
    };
    expect(
      await browserCdpFromTool(plain, computer, context, { method: "DOM.getDocument" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("no DevTools protocol access") });
    const older = new ComputerBrowserProvider({
      liveDriver: async () => ({
        ok: false,
        error: "unknown command: cdp",
        fallback: "computer_act",
      }),
    });
    const live = { ...computer, kind: "docker" } as ComputerRef;
    expect(
      await browserCdpFromTool(older, live, context, { method: "DOM.getDocument" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("older image") });
  });

  it("reports a command that failed after it was sent as maybe run, and a refused read as not", async () => {
    const failing = new ComputerBrowserProvider({
      liveDriver: async () => {
        throw new Error("socket closed");
      },
    });
    const live = { ...computer, kind: "docker" } as ComputerRef;
    expect(
      await browserCdpFromTool(failing, live, context, {
        method: "Runtime.evaluate",
        params: { expression: "1" },
      }),
    ).toMatchObject({ ok: false, uncertain: true });
    const noPage = new ComputerBrowserProvider({
      liveDriver: async () => ({ ok: false, uncertain: false, noPage: true, error: "none" }),
    });
    expect(await browserCdpFromTool(noPage, live, context, { method: "DOM.getDocument" })).toEqual({
      ok: false,
      uncertain: false,
      error: NO_PAGE_MESSAGE,
    });
  });

  it("sends the live helper the method and params only", async () => {
    const sent: PageBrowserCommand[] = [];
    const provider = new ComputerBrowserProvider({
      liveDriver: async (_computer, request) => {
        sent.push(request);
        return { ok: true, url, title: "Cart", result: { frameTree: {} } };
      },
    });
    const live = { ...computer, kind: "docker" } as ComputerRef;
    await browserCdpFromTool(provider, live, context, {
      method: "Page.getFrameTree",
      params: { a: 1 },
      extra: "dropped",
    });
    expect(sent).toEqual([{ command: "cdp", method: "Page.getFrameTree", params: { a: 1 } }]);
  });
});

describe("browser_dialog", () => {
  async function withDialog(type: string, message = "Are you sure?") {
    const browser = await openPage();
    const snap = await browser.snapshot(computer, {}, context);
    const button = snap.elements.find((element) => element.name === "Place order")!;
    browser.nextActOpensDialog = { type, message };
    const opened = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: button.ref }] },
      context,
    );
    return { browser, opened };
  }

  it("parses only accept and dismiss, and prompt text only to accept", () => {
    expect(parseDialogCall({ action: "accept", prompt_text: "Ada" })).toEqual({
      action: "accept",
      text: "Ada",
    });
    expect(parseDialogCall({ action: "status" })).toHaveProperty("error");
    expect(parseDialogCall({ action: "dismiss", prompt_text: "x" })).toHaveProperty("error");
    expect(
      parseDialogCall({
        action: "accept",
        prompt_text: "x".repeat(DIALOG_PROMPT_TEXT_MAX_CHARS + 1),
      }),
    ).toHaveProperty("error");
    expect(parseDialogCall({ action: "accept", prompt_text: 5 })).toHaveProperty("error");
  });

  it("keeps a confirm open for the bot instead of answering it, and points to browser_dialog", async () => {
    const { browser, opened } = await withDialog("confirm");
    expect(opened).toMatchObject({ ok: false, dialog: "confirm", fallback: "computer_act" });
    expect(browser.sessions.peek("c1::b1")?.dialog).toEqual({
      type: "confirm",
      message: "Are you sure?",
    });
    // Page reads do not wait on it: they report it at once.
    const snap = await browser.snapshot(computer, {}, context);
    expect(snap).toMatchObject({ dialog: "confirm", error: expect.stringContaining("confirm") });
  });

  it("answers nothing when no dialog is open", async () => {
    const browser = await openPage();
    for (const action of ["accept", "dismiss"]) {
      expect(await browserDialogFromTool(browser, computer, context, { action })).toMatchObject({
        ok: false,
        uncertain: false,
        error: "No dialog is open on the page.",
      });
    }
    expect(browser.sessions.peek("c1::b1")?.dialogAnswers).toEqual([]);
  });

  it("asks nothing of a browser with no page open", async () => {
    const browser = new FakeBrowserProvider();
    expect(await browserDialogFromTool(browser, computer, context, { action: "dismiss" })).toEqual({
      ok: false,
      uncertain: false,
      error: NO_PAGE_MESSAGE,
    });
  });

  it.each(["alert", "confirm", "prompt", "beforeunload"])("dismisses a %s", async (type) => {
    const { browser } = await withDialog(type);
    // An alert is closed by the page tools as they read on, so only the others are still open.
    if (type === "alert") return;
    const result = await browserDialogFromTool(browser, computer, context, { action: "dismiss" });
    expect(result).toMatchObject({ ok: true, answered: true, dialog: type, url });
    expect(browser.sessions.peek("c1::b1")?.dialogAnswers.at(-1)).toMatchObject({
      type,
      action: "dismiss",
    });
  });

  it("accepts a Leave site? dialog unasked", async () => {
    const { browser } = await withDialog("beforeunload", "Leave site?");
    const result = await browserDialogFromTool(browser, computer, context, { action: "accept" });
    expect(result).toMatchObject({ ok: true, answered: true, dialog: "beforeunload" });
  });

  it.each(["confirm", "prompt"])(
    "leaves a %s open unless the user approved that very dialog",
    async (type) => {
      const { browser } = await withDialog(type, "Place the order for $5?");
      const unasked = await browserDialogFromTool(browser, computer, context, {
        action: "accept",
      });
      expect(unasked).toMatchObject({
        ok: false,
        dialog: type,
        note: expect.stringContaining("ask the user"),
      });
      const other = await browserDialogFromTool(
        browser,
        computer,
        context,
        { action: "accept" },
        { approved: { type, message: "Delete the account?" } },
      );
      expect(other).toMatchObject({ ok: false, error: expect.stringContaining("not the one") });
      expect(browser.sessions.peek("c1::b1")?.dialog).toBeDefined();
      const approved = await browserDialogFromTool(
        browser,
        computer,
        context,
        { action: "accept", ...(type === "prompt" ? { prompt_text: "Ada" } : {}) },
        { approved: { type, message: "Place the order for $5?" } },
      );
      expect(approved).toMatchObject({ ok: true, answered: true, dialog: type });
      expect(browser.sessions.peek("c1::b1")?.dialogAnswers.at(-1)).toEqual({
        type,
        message: "Place the order for $5?",
        action: "accept",
        ...(type === "prompt" ? { text: "Ada" } : {}),
      });
    },
  );

  it("treats the dialog's message as outside text: the run's secrets are hidden in it", async () => {
    const secret = "fake-run-secret-9";
    const { browser } = await withDialog("confirm", `Send ${secret} to the shop?`);
    const result = await browserDialogFromTool(
      browser,
      computer,
      context,
      { action: "dismiss" },
      { redactions: () => [secret] },
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("reads a stored approval only in its known shape", () => {
    expect(dialogApprovalOf({ type: "confirm", message: "x".repeat(400) })).toEqual({
      type: "confirm",
      message: "x".repeat(300),
    });
    expect(dialogApprovalOf({ type: "window", message: "x" })).toBeUndefined();
    expect(dialogApprovalOf({ type: "confirm" })).toBeUndefined();
    expect(dialogApprovalOf("confirm")).toBeUndefined();
  });

  it("reports an answer that got no reply as maybe sent, so it is not sent again blind", async () => {
    const failing = new ComputerBrowserProvider({
      liveDriver: async () => {
        throw new Error("socket closed");
      },
    });
    const live = { ...computer, kind: "docker" } as ComputerRef;
    expect(
      await browserDialogFromTool(failing, live, context, { action: "dismiss" }),
    ).toMatchObject({ ok: false, uncertain: true });
  });

  it("sends the live helper what to accept, and never a dialog the user did not approve", async () => {
    const sent: PageBrowserCommand[] = [];
    const provider = new ComputerBrowserProvider({
      liveDriver: async (_computer, request) => {
        sent.push(request);
        return { ok: true, url, title: "Cart", answered: true, dialog: "alert", message: "" };
      },
    });
    const live = { ...computer, kind: "docker" } as ComputerRef;
    await browserDialogFromTool(provider, live, context, { action: "accept" });
    await browserDialogFromTool(
      provider,
      live,
      context,
      { action: "accept", prompt_text: "Ada" },
      { approved: { type: "prompt", message: "Name?" } },
    );
    await browserDialogFromTool(provider, live, context, { action: "dismiss" });
    expect(sent).toEqual([
      { command: "dialog", action: "accept", only: ["alert", "beforeunload"] },
      {
        command: "dialog",
        action: "accept",
        text: "Ada",
        expect: { type: "prompt", message: "Name?" },
      },
      { command: "dialog", action: "dismiss" },
    ]);
  });
});
