import type * as Core from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordEffect } from "../lifecycle/run-effects.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";

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
// Whether a check-in offer can be shown is tested beside it; here every offer can.
vi.mock("../../tasks/check-in-offer.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkInOfferRefusal: vi.fn(async () => undefined),
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
    personEveryTime: false,
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
      personEveryTime: false,
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
      personEveryTime: false,
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
      personEveryTime: false,
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

describe("gateToolCall: background processes", () => {
  const planFor = async (name: string, args: Record<string, unknown>, trigger = "user") => {
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
      personEveryTime: false,
    } as unknown as ToolRequest;
    const ctx = {
      deps: { prisma: {} },
      run: { id: "run-1", userId: "user-1", spaceId: "space-1", trigger },
      runId: "run-1",
      bot: { id: "bot-1", name: "Helper" },
      thread: { id: "thread-1" },
      context: { signal: new AbortController().signal },
      source: { ownerStartedRun: trigger === "user" },
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
    await expect(prepareToolRequest(ctx as never, request)).resolves.toBeUndefined();
    await gateToolCall(ctx as never, request, undefined).catch(() => undefined);
    return [...plans];
  };

  it("asks before stopping a process, and starts one as it runs a shell command", async () => {
    expect(await planFor("process_manage", { action: "kill", id: "0123456789ab" })).toEqual([
      "ask",
    ]);
    const shell = await planFor("shell", { command: "npm run dev" });
    expect(await planFor("process_manage", { action: "start", command: "npm run dev" })).toEqual(
      shell,
    );
    expect(await planFor("process_manage", { action: "list" })).toEqual(shell);
  });

  it("gates starting a process in a run outside text started, as shell", async () => {
    const shell = await planFor("shell", { command: "npm run dev" }, "webhook");
    expect(shell).toEqual(["ask"]);
    expect(
      await planFor("process_manage", { action: "start", command: "npm run dev" }, "webhook"),
    ).toEqual(shell);
  });

  it("gates edit_file as write_file", async () => {
    for (const trigger of ["user", "webhook"]) {
      expect(
        await planFor("edit_file", { path: "a.txt", old_string: "a", new_string: "b" }, trigger),
      ).toEqual(await planFor("write_file", { path: "a.txt", content: "b" }, trigger));
    }
  });
});

describe("gateToolCall: task threads", () => {
  const run = async (
    name: string,
    args: Record<string, unknown>,
    options: { owned?: boolean; neverAsk?: boolean } = {},
  ) => {
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
      personEveryTime: false,
    } as unknown as ToolRequest;
    const findFirst = vi.fn(async () =>
      options.owned === false ? null : { id: "task-1", conversationTitle: "Venue shortlist" },
    );
    const ctx = {
      deps: { prisma: { thread: { findFirst } } },
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
        loadAutoReviewPreference: async () => ({
          enabled: false,
          skipApprovals: Boolean(options.neverAsk),
        }),
      },
    };
    const prepared = await prepareToolRequest(ctx as never, request);
    if (prepared) return { prepared, plans: [...plans], request, findFirst };
    const outcome = await gateToolCall(ctx as never, request, undefined).catch(
      (error: Error) => error.message,
    );
    return { outcome, plans: [...plans], request, findFirst };
  };

  it("asks before stopping a task, with a card that names it", async () => {
    const stop = await run("stop_task", { threadId: "task-1" });
    expect(stop.plans).toEqual(["ask"]);
    expect(stop.outcome).toBe("asks the user");
    expect(stop.request.fleetSummary).toEqual({ title: "Stop task “Venue shortlist”?", lines: [] });
    expect(stop.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "space-1",
          userId: "user-1",
          conversationBotId: "bot-1",
          parentThreadId: "thread-1",
          id: "task-1",
        },
      }),
    );
  });

  it("shows no card for a thread this conversation did not start", async () => {
    const stop = await run("stop_task", { threadId: "elsewhere" }, { owned: false });
    expect(stop.prepared).toMatchObject({ error: expect.stringContaining("started no open task") });
    expect(stop.plans).toEqual([]);
  });

  it("starts, follows up and lists task threads without a card", async () => {
    for (const [name, args] of [
      ["delegate", { brief: "Shortlist venues" }],
      ["follow_up", { threadId: "task-1", message: "Add parking" }],
      ["link_to_thread", {}],
    ] as const) {
      const { plans: planned, prepared } = await run(name, args);
      expect(prepared, name).toBeUndefined();
      expect(planned, name).not.toContain("ask");
    }
  });

  it("never accepts a check-in for the person in Never ask", async () => {
    const offer = await run(
      "offer_check_in",
      { subject: "Launch brief", prompt: "Look for comments.", delayMinutes: 60 },
      { neverAsk: true },
    );
    expect(offer.plans).toEqual(["deny"]);
    expect(JSON.stringify(offer.outcome)).toContain("needs the person's answer");
  });
});

describe("gateToolCall: media understanding", () => {
  const gateFor = async (name: string, args: Record<string, unknown>) => {
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
      personEveryTime: false,
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
        searchResultUrls: new Set<string>(),
        loadTrustedSites: async () => new Set<string>(),
        loadApprovalRules: async () => [],
        loadAutoReviewPreference: async () => ({ enabled: false, skipApprovals: false }),
      },
    };
    const outcome = await gateToolCall(ctx as never, request, undefined).catch(
      (error: Error) => error.message,
    );
    return { plans: [...plans], outcome: JSON.stringify(outcome) ?? "" };
  };

  it("reads a workspace file or an attachment without a url, as read_file does", async () => {
    const read = await gateFor("read_file", { path: "photo.png" });
    for (const name of ["vision_analyze", "video_analyze"]) {
      for (const args of [{ path: "photo.png" }, { attachment: "attachments/abc.png" }]) {
        const analyzed = await gateFor(name, args);
        expect(analyzed.outcome).not.toContain("url must be");
        expect(analyzed.plans).toEqual(read.plans);
      }
    }
  });

  it("gates a url on a site the run was not given, as web_fetch does", async () => {
    const url = "https://images.example.test/cat.png";
    const fetched = await gateFor("web_fetch", { url });
    for (const name of ["vision_analyze", "video_analyze"]) {
      expect((await gateFor(name, { url })).plans).toEqual(fetched.plans);
      expect((await gateFor(name, { url: "not a url" })).outcome).toContain("url must be");
    }
  });
});
