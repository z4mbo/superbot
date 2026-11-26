import type * as Core from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordEffect } from "../lifecycle/run-effects.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";

const plans = vi.hoisted(() => [] as string[]);
const reviewOnly = vi.hoisted(() => [] as (boolean | undefined)[]);
vi.mock("@rakazo/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    planActionGate: (input: Parameters<typeof core.planActionGate>[0]) => {
      const plan = core.planActionGate(input);
      plans.push(plan);
      reviewOnly.push(input.reviewOnly);
      return plan;
    },
  };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
}));
// Recording the effect a person answers is where an ask begins; the test stops there.
vi.mock("../lifecycle/run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => {
    throw new Error("asks the user");
  }),
}));

const loginUse = {
  kind: "login" as const,
  login: "work",
  site: "https://login.example.test",
  title: "login.example.test",
  fields: ["Password"],
  savedAt: "2026-09-01T00:00:01.000Z",
};

function gate(options: {
  trigger?: string;
  neverAsk?: boolean;
  rule?: "always_allow" | "deny";
  asks?: boolean;
}) {
  const args = { actions: [{ kind: "fill_secret", ref: "e1", secret: "work", field: "Password" }] };
  const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
  const request: ToolRequest = {
    name: "browser_act",
    args,
    executionId,
    connectorCall: { tool: "browser_act", args, executionId, route: undefined },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: "browser_act",
    fleetSummary: undefined,
    heldForApproval: false,
    settingsChange: false,
    ignoresAllowRules: false,
    purchase: undefined,
    cardUse: undefined,
    loginUse: options.asks === false ? undefined : loginUse,
  };
  const ctx = {
    deps: { prisma: {} },
    run: { id: "run-1", userId: "user-1", spaceId: "space-1", trigger: options.trigger ?? "user" },
    runId: "run-1",
    bot: { id: "bot-1", name: "Helper" },
    thread: { id: "thread-1" },
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun: true },
    tools: { connector: new Map(), connectedPlugins: [] },
    state: {
      tainted: false,
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () =>
        options.rule
          ? [{ effect: options.rule, matchKind: "tool", matchValue: "browser_act" }]
          : [],
      loadAutoReviewPreference: async () => ({
        enabled: false,
        skipApprovals: Boolean(options.neverAsk),
      }),
    },
  };
  return gateToolCall(ctx as never, request, undefined).then(
    (outcome) => outcome,
    (error: Error) => error.message,
  );
}

describe("gateToolCall: a login that asks first", () => {
  beforeEach(() => {
    plans.length = 0;
  });

  it("asks the user every time in Ask and Auto, even over an Always allow rule", async () => {
    for (const options of [{}, { rule: "always_allow" as const }]) {
      plans.length = 0;
      expect(await gate(options)).toBe("asks the user");
      expect(plans).toEqual(["ask"]);
    }
  });

  it("runs it without asking in Never ask", async () => {
    plans.length = 0;
    await gate({ neverAsk: true });
    expect(plans).toEqual(["allow"]);
  });

  it("asks in a webhook run too, where the card expires if nobody answers", async () => {
    plans.length = 0;
    expect(await gate({ trigger: "webhook" })).toBe("asks the user");
    expect(plans).toEqual(["ask"]);
  });

  it("is refused by a rule that blocks the tool", async () => {
    expect(await gate({ rule: "deny" })).toEqual({
      result: { error: expect.stringContaining("is blocked in this space") },
    });
  });
});

describe("gateToolCall: typing into a page after outside content, in Auto", () => {
  const typed = (
    state: { pageUrl?: string; pageUrlUncertain?: boolean },
    actions: Record<string, unknown>[] = [{ kind: "fill", ref: "e2", text: "12 Rua Nova" }],
  ) => {
    const args = { actions };
    const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
    const request = {
      name: "browser_act",
      args,
      executionId,
      connectorCall: { tool: "browser_act", args, executionId, route: undefined },
      effectRequest: args,
      replayEffectToolName: "browser_act",
      heldForApproval: false,
      settingsChange: false,
      ignoresAllowRules: false,
    } as unknown as ToolRequest;
    const ctx = {
      deps: { prisma: {}, autoReview: {} },
      run: { id: "run-1", userId: "user-1", spaceId: "space-1", trigger: "user" },
      runId: "run-1",
      bot: { id: "bot-1", name: "Helper" },
      thread: { id: "thread-1" },
      context: { signal: new AbortController().signal },
      source: { ownerStartedRun: true },
      tools: { connector: new Map(), connectedPlugins: [] },
      state: {
        ...state,
        tainted: true,
        effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
      },
      trust: {
        searchResultUrls: new Set<string>(),
        loadTrustedSites: async () => new Set(["example.com"]),
        loadApprovalRules: async () => [],
        loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
      },
    };
    return gateToolCall(ctx as never, request, undefined).catch(() => undefined);
  };

  beforeEach(() => {
    reviewOnly.length = 0;
  });

  it("leaves typing on a site the run was given alone, and judges it once a desktop action may have moved the page", async () => {
    await typed({ pageUrl: "https://shop.example.com/address" });
    await typed({ pageUrl: "https://shop.example.com/address", pageUrlUncertain: true });
    await typed({ pageUrl: "https://forms.example.net/" });
    expect(reviewOnly).toEqual([false, true, true]);
  });

  it("judges typing after a click in the same call, which can leave the page", async () => {
    await typed({ pageUrl: "https://shop.example.com/address" }, [
      { kind: "fill", ref: "e2", text: "12 Rua Nova" },
      { kind: "click", ref: "e3" },
    ]);
    await typed({ pageUrl: "https://shop.example.com/address" }, [
      { kind: "click", ref: "e9" },
      { kind: "fill", ref: "e2", text: "12 Rua Nova" },
    ]);
    expect(reviewOnly).toEqual([false, true]);
  });
});

describe("gateToolCall: a nightly memory review", () => {
  it("leaves out a save a rule would ask about, with no card, pause or push", async () => {
    vi.mocked(recordEffect).mockResolvedValueOnce({
      effect: { id: "effect-1", status: "intended" },
      duplicate: false,
    } as never);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const pauseRunForInput = vi.fn();
    const args = { path: "MEMORY.md", content: "- Dates as YYYY-MM-DD.\n" };
    const executionId = "memory-review-1";
    const request = {
      name: "save_shared_memory",
      args,
      executionId,
      connectorCall: { tool: "save_shared_memory", args, executionId, route: undefined },
      effectRequest: args,
      replayEffectToolName: "save_shared_memory",
      heldForApproval: false,
      settingsChange: false,
      ignoresAllowRules: false,
    } as unknown as ToolRequest;
    const ctx = {
      deps: {
        prisma: {
          attempt: { count: async () => 1 },
          externalEffect: { findMany: async () => [], updateMany },
        },
        events: { pauseRunForInput },
      },
      run: {
        id: "run-1",
        userId: "user-1",
        spaceId: "space-1",
        trigger: "routine",
        clientNonce: "nightly-memory-review:bot-1:2026-11-24",
      },
      runId: "run-1",
      bot: { id: "bot-1", name: "Helper" },
      thread: { id: "thread-1" },
      context: { signal: new AbortController().signal },
      source: { ownerStartedRun: false },
      tools: { connector: new Map(), connectedPlugins: [] },
      state: {
        tainted: false,
        approval: { pausePending: false },
        effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
      },
      trust: {
        loadApprovalRules: async () => [
          { effect: "require_approval", matchKind: "tool", matchValue: "save_shared_memory" },
        ],
        loadAutoReviewPreference: async () => ({ enabled: false, skipApprovals: false }),
        receivedOutsideMessage: async () => false,
      },
    };
    const outcome = await gateToolCall(ctx as never, request, undefined);
    expect(outcome).toEqual({ result: { error: expect.stringContaining("never asks") } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "effect-1", status: "intended" },
      data: { status: "denied", result: { refused: "unattended" } },
    });
    expect(pauseRunForInput).not.toHaveBeenCalled();
    expect(ctx.state.approval.pausePending).toBe(false);
  });
});

describe("gateToolCall: deleting saved state from chat", () => {
  const planFor = async (name: string, args: Record<string, unknown>) => {
    plans.length = 0;
    const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
    const request = {
      name,
      args,
      executionId,
      connectorCall: { tool: name, args, executionId, route: undefined },
      effectRequest: args,
      replayEffectToolName: name,
      heldForApproval: false,
      settingsChange: false,
      ignoresAllowRules: false,
    } as unknown as ToolRequest;
    const ctx = {
      deps: { prisma: {} },
      run: { id: "run-1", userId: "user-1", spaceId: "space-1", trigger: "user" },
      runId: "run-1",
      bot: { id: "bot-1", name: "Helper" },
      thread: { id: "thread-1" },
      context: { signal: new AbortController().signal },
      source: { ownerStartedRun: true },
      tools: { connector: new Map(), connectedPlugins: [] },
      state: {
        tainted: false,
        effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
      },
      trust: {
        loadApprovalRules: async () => [],
        loadAutoReviewPreference: async () => ({ enabled: false, skipApprovals: false }),
      },
    };
    await gateToolCall(ctx as never, request, undefined).catch(() => undefined);
    return plans;
  };

  it("asks before deleting a shared memory document or removing an MCP server", async () => {
    expect(await planFor("delete_shared_memory", { path: "team.md" })).toEqual(["ask"]);
    expect(await planFor("remove_mcp_server", { name: "Linear" })).toEqual(["ask"]);
  });
});
