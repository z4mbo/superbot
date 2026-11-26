import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { recordAuditEvent } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBrowserProvider } from "../../browser/fake-browser.js";
import { recordEffect } from "../lifecycle/run-effects.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";
import { browserControlTool } from "./run-tools-browser-control.js";

const plans = vi.hoisted(() => [] as string[]);
vi.mock("@rakazo/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    planActionGate: (input: Parameters<typeof core.planActionGate>[0]) => {
      const plan = core.planActionGate(input);
      plans.push(plan);
      return plan;
    },
  };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
}));
// Recording the effect a person answers is where an ask begins; the test stops there unless it
// lets one call through.
vi.mock("../lifecycle/run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => {
    throw new Error("asks the user");
  }),
  claimEffect: vi.fn(async () => true),
}));

const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "b1",
  signal: new AbortController().signal,
};
const url = "https://shop.example.test/cart";
const html = `<!doctype html><html><head><title>Cart</title></head><body>
  <button>Place order</button></body></html>`;

async function pageWithDialog(dialog?: { type: string; message: string }) {
  const browser = new FakeBrowserProvider({ pages: { [url]: { title: "Cart", html } } });
  await browser.navigate(computer, { url }, context);
  if (dialog) browser.sessions.peek("c1::b1")!.dialog = dialog;
  return browser;
}

type Mode = "ask" | "auto" | "never";

function harness(
  browser: FakeBrowserProvider,
  options: { mode?: Mode; trigger?: string; rule?: "always_allow" | "deny"; tool?: string } = {},
) {
  const state = {
    // The page the run opened is outside content.
    tainted: true,
    pageUrl: url,
    pageUrlUncertain: false,
    effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    screen: {
      unchangedVisualStreak: { count: 0 },
      turn: { controlFence: undefined as number | undefined, mustLook: false },
    },
  };
  const ctx = {
    deps: {
      // Auto Review is configured; a person-only call never reaches it.
      autoReview: vi.fn(async () => ({ decision: "pass", reason: "fine" })),
      prisma: {
        externalEffect: { findMany: async () => [] },
        taughtSkill: { findFirst: async () => null },
        computer: { findUnique: async () => null },
      },
    },
    run: {
      id: "run-1",
      userId: "user-1",
      spaceId: "space-1",
      botId: "b1",
      trigger: options.trigger ?? "user",
    },
    runId: "run-1",
    bot: { id: "b1", name: "Helper" },
    thread: { id: "thread-1" },
    context,
    source: { ownerStartedRun: true },
    tools: { connector: new Map(), connectedPlugins: [], disabled: new Set<string>() },
    providers: { browser },
    computer: {
      heldForTakeover: false,
      pageBrowserAllowed: true,
      graphicalToolsAllowed: true,
      stored: { id: "c1" },
      mode: "private",
      checkpoint: { markDirty: vi.fn() },
      get: async () => computer,
    },
    secrets: [] as string[],
    state,
    trust: {
      loadApprovalRules: async () =>
        options.rule
          ? [{ effect: options.rule, matchKind: "tool", matchValue: options.tool ?? "browser_cdp" }]
          : [],
      loadAutoReviewPreference: async () => ({
        enabled: options.mode === "auto",
        skipApprovals: options.mode === "never",
      }),
      loadApprovalModel: async () => null,
    },
  };
  return ctx;
}

function request(name: string, args: Record<string, unknown>, nextApprovedTool?: string) {
  const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
  return {
    name,
    args,
    executionId,
    connectorCall: { tool: name, args, executionId, route: undefined },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool,
    approvedEffectKey: undefined,
    replayEffectToolName: name,
    fleetSummary: undefined,
    heldForApproval: false,
    settingsChange: false,
    ignoresAllowRules: false,
    personEveryTime: false,
    purchase: undefined,
    cardUse: undefined,
    loginUse: undefined,
  } satisfies ToolRequest;
}

async function decide(
  name: string,
  args: Record<string, unknown>,
  options: Parameters<typeof harness>[1] & { browser?: FakeBrowserProvider } = {},
) {
  plans.length = 0;
  const browser = options.browser ?? (await pageWithDialog());
  const ctx = harness(browser, options);
  const req = request(name, args);
  const prepared = await prepareToolRequest(ctx as never, req);
  if (prepared) return { prepared, plans: [...plans], request: req, ctx };
  const outcome = await gateToolCall(ctx as never, req, undefined).catch(
    (error: Error) => error.message,
  );
  return { outcome, plans: [...plans], request: req, ctx };
}

beforeEach(() => {
  plans.length = 0;
  vi.mocked(recordAuditEvent).mockClear();
});

describe("browser_cdp approvals", () => {
  it("runs a read method as browser_snapshot runs, in every mode", async () => {
    for (const mode of ["ask", "auto", "never"] as const) {
      const { plans: planned, request: req } = await decide(
        "browser_cdp",
        { method: "DOM.getDocument", params: { depth: 1 } },
        { mode },
      );
      expect(planned, mode).toEqual(["allow"]);
      expect(req.heldForApproval).toBe(false);
    }
  });

  it("asks a person every time before a method that acts on the page, over an Always allow rule", async () => {
    for (const options of [
      { mode: "ask" as const },
      { mode: "auto" as const },
      { mode: "ask" as const, rule: "always_allow" as const },
      { mode: "auto" as const, rule: "always_allow" as const },
    ]) {
      const decided = await decide(
        "browser_cdp",
        { method: "Runtime.evaluate", params: { expression: "document.title" } },
        options,
      );
      expect(decided.plans, JSON.stringify(options)).toEqual(["ask"]);
      expect(decided.outcome).toBe("asks the user");
      expect(decided.request).toMatchObject({ heldForApproval: true, personEveryTime: true });
      expect(decided.request.fleetSummary).toEqual({
        title: "Run Runtime.evaluate on the page?",
        lines: ["expression: document.title"],
        onceOnly: true,
      });
    }
  });

  it("refuses a method that acts on the page in Never ask, where nobody would be asked", async () => {
    const decided = await decide(
      "browser_cdp",
      { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 1, y: 1 } },
      { mode: "never" },
    );
    expect(decided.plans).toEqual(["deny"]);
    expect(decided.outcome).toMatchObject({
      result: { error: expect.stringContaining("never asks") },
    });
  });

  it("refuses a denied method before any card, rule or mode, and records the refusal", async () => {
    for (const options of [
      { mode: "ask" as const },
      { mode: "auto" as const },
      { mode: "never" as const },
      { mode: "never" as const, rule: "always_allow" as const },
    ]) {
      const browser = await pageWithDialog();
      const decided = await decide(
        "browser_cdp",
        { method: "Network.getAllCookies" },
        { ...options, browser },
      );
      expect(decided.prepared, JSON.stringify(options)).toEqual({
        error: expect.stringContaining("refuses Network.getAllCookies"),
      });
      expect(decided.plans).toEqual([]);
      expect(browser.cdpCalls).toEqual([]);
    }
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        metadata: { reason: "cdp_policy", method: "Network.getAllCookies" },
      }),
    );
  });

  it("refuses a malformed method name, and keeps only the method and params it sends", async () => {
    const bad = await decide("browser_cdp", { method: "runtime.evaluate" });
    expect(bad.prepared).toEqual({ error: expect.stringContaining("needs method") });
    const good = await decide("browser_cdp", {
      method: "Page.getFrameTree",
      params: { a: 1 },
      extra: true,
    });
    expect(good.request.args).toEqual({ method: "Page.getFrameTree", params: { a: 1 } });
  });

  it("is blocked by a rule that blocks the tool, and gated in a run a webhook started", async () => {
    const blocked = await decide("browser_cdp", { method: "DOM.getDocument" }, { rule: "deny" });
    expect(blocked.plans).toEqual(["deny"]);
    const webhook = await decide(
      "browser_cdp",
      { method: "DOM.getDocument" },
      { trigger: "webhook" },
    );
    expect(webhook.plans).toEqual(["ask"]);
  });
});

describe("browser_dialog approvals", () => {
  it.each(["confirm", "prompt"])(
    "asks a person every time before accepting a %s, showing its message",
    async (type) => {
      for (const mode of ["ask", "auto"] as const) {
        const browser = await pageWithDialog({ type, message: "Place the order for $5?" });
        const decided = await decide(
          "browser_dialog",
          { action: "accept", ...(type === "prompt" ? { prompt_text: "Ada" } : {}) },
          { mode, browser },
        );
        expect(decided.plans, mode).toEqual(["ask"]);
        expect(decided.request.args).toEqual({
          action: "accept",
          ...(type === "prompt" ? { prompt_text: "Ada" } : {}),
          dialogApproval: { type, message: "Place the order for $5?" },
        });
        expect(decided.request.fleetSummary).toEqual({
          title: "Accept the dialog on example.test?",
          lines: ["Place the order for $5?", ...(type === "prompt" ? ["Answer: Ada"] : [])],
          onceOnly: true,
        });
      }
    },
  );

  it("never accepts a confirm in Never ask, where nobody would be asked", async () => {
    const browser = await pageWithDialog({ type: "confirm", message: "Delete?" });
    const decided = await decide(
      "browser_dialog",
      { action: "accept" },
      { mode: "never", browser },
    );
    expect(decided.plans).toEqual(["deny"]);
  });

  it("drops an approval the model wrote itself", async () => {
    const browser = await pageWithDialog({ type: "confirm", message: "Delete?" });
    const decided = await decide(
      "browser_dialog",
      { action: "accept", dialogApproval: { type: "confirm", message: "Something else" } },
      { browser },
    );
    expect(decided.request.args).toEqual({
      action: "accept",
      dialogApproval: { type: "confirm", message: "Delete?" },
    });
  });

  it("refuses an approved replay that carries no approval while a confirm is open", async () => {
    const browser = await pageWithDialog({ type: "confirm", message: "Delete?" });
    const ctx = harness(browser);
    const req = request("browser_dialog", { action: "accept" }, "browser_dialog");
    expect(await prepareToolRequest(ctx as never, req)).toEqual({
      error: expect.stringContaining("has not approved"),
    });
  });

  it("dismisses anything, and accepts an alert or Leave site? dialog, without asking", async () => {
    for (const [args, dialog] of [
      [{ action: "dismiss" }, { type: "confirm", message: "Delete?" }],
      [{ action: "accept" }, { type: "beforeunload", message: "" }],
      [{ action: "accept" }, { type: "alert", message: "Saved" }],
      [{ action: "accept" }, undefined],
    ] as const) {
      const browser = await pageWithDialog(dialog);
      const decided = await decide("browser_dialog", args, { browser });
      expect(decided.plans, JSON.stringify(dialog)).toEqual(["allow"]);
      expect(decided.request.heldForApproval).toBe(false);
    }
  });

  it("is gated in a run a webhook started, as browser_act is", async () => {
    const decided = await decide("browser_dialog", { action: "dismiss" }, { trigger: "webhook" });
    expect(decided.plans).toEqual(["ask"]);
  });
});

describe("the page the run last saw", () => {
  it.each([
    ["browser_dialog", { action: "dismiss" }, true],
    ["browser_cdp", { method: "Runtime.evaluate", params: { expression: "1" } }, true],
    ["browser_cdp", { method: "DOM.getDocument" }, false],
  ] as const)("%s %j marks it uncertain: %s", async (name, args, uncertain) => {
    const browser = await pageWithDialog({ type: "confirm", message: "Delete?" });
    const ctx = harness(browser);
    // As the call runs once a person approved it.
    vi.mocked(recordEffect).mockResolvedValueOnce({
      effect: { id: "effect-1", status: "approved" },
      duplicate: true,
    } as never);
    const req = request(name, args, name);
    await prepareToolRequest(ctx as never, req);
    const outcome = await gateToolCall(ctx as never, req, undefined).catch(
      (error: Error) => error.message,
    );
    expect(ctx.state.pageUrlUncertain, JSON.stringify(outcome)).toBe(uncertain);
  });
});

describe("browserControlTool", () => {
  const call = (name: string, args: Record<string, unknown>) => ({
    name,
    args,
    finish: async (result: unknown) => result,
  });
  const text = (result: unknown) => JSON.stringify(result);

  it("answers the open dialog with the approval the request step wrote", async () => {
    const browser = await pageWithDialog({ type: "confirm", message: "Delete?" });
    const ctx = harness(browser);
    const result = await browserControlTool(
      ctx as never,
      call("browser_dialog", {
        action: "accept",
        dialogApproval: { type: "confirm", message: "Delete?" },
      }) as never,
    );
    expect(text(result)).toContain('"answered":true');
    expect(ctx.computer.checkpoint.markDirty).toHaveBeenCalled();
    expect(browser.sessions.peek("c1::b1")?.dialogAnswers).toEqual([
      { type: "confirm", message: "Delete?", action: "accept" },
    ]);
  });

  it("sends a read method and hides the run's secrets in what it returns", async () => {
    const browser = await pageWithDialog();
    browser.cdpResults.set("DOM.getDocument", { root: { nodeName: "fake-run-secret-9" } });
    const ctx = harness(browser);
    ctx.secrets.push("fake-run-secret-9");
    const result = await browserControlTool(
      ctx as never,
      call("browser_cdp", { method: "DOM.getDocument" }) as never,
    );
    expect(text(result)).not.toContain("fake-run-secret-9");
    expect(text(result)).toContain("[redacted]");
    expect(ctx.computer.checkpoint.markDirty).not.toHaveBeenCalled();
  });

  it("waits for the person who has the screen, as the other page tools do", async () => {
    const browser = await pageWithDialog();
    const ctx = harness(browser);
    ctx.computer.heldForTakeover = true;
    const result = await browserControlTool(
      ctx as never,
      call("browser_cdp", { method: "DOM.getDocument" }) as never,
    );
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(browser.cdpCalls).toEqual([]);
  });
});
