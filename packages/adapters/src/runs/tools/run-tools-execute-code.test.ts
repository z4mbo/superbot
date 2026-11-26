import type { CommandRequest, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";
import { executeCodeTool } from "./run-tools-execute-code.js";

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
vi.mock("../lifecycle/run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => {
    throw new Error("asks the user");
  }),
}));
const commandEnvironment = vi.hoisted(() => ({
  env: { API_TOKEN: "fake-command-variable" } as Record<string, string>,
  unsetEnv: ["OLD"],
  used: [{ id: "item-1" }],
}));
vi.mock("../../secrets/bot-secrets.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  shellCommandEnvironment: vi.fn(
    async (options: { registerRedactions: (values: string[]) => void }) => {
      options.registerRedactions(["fake-command-variable"]);
      return commandEnvironment;
    },
  ),
}));
const vaultUses = vi.hoisted(() => [] as unknown[]);
vi.mock("../assembly/run-context.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordVaultUse: vi.fn(async (_ctx: unknown, tool: string, item: unknown) => {
    vaultUses.push([tool, item]);
  }),
}));

type Options = {
  mode?: "ask" | "auto" | "never";
  trigger?: string;
  tainted?: boolean;
  rule?: "always_allow" | "deny";
  /** The tool the rule is saved for; shell unless given. */
  ruleFor?: string;
};

function gateCtx(options: Options) {
  return {
    deps: {
      autoReview: vi.fn(async () => ({ decision: "ask", reason: "check" })),
      prisma: { externalEffect: { findMany: async () => [] } },
    },
    run: { id: "run-1", userId: "user-1", spaceId: "space-1", trigger: options.trigger ?? "user" },
    runId: "run-1",
    bot: { id: "bot-1", name: "Helper" },
    thread: { id: "thread-1" },
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun: options.trigger === undefined || options.trigger === "user" },
    tools: { connector: new Map(), connectedPlugins: [] },
    state: {
      tainted: Boolean(options.tainted),
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      // A rule saved for shell covers execute_code too.
      loadApprovalRules: async () =>
        options.rule
          ? [{ effect: options.rule, matchKind: "tool", matchValue: options.ruleFor ?? "shell" }]
          : [],
      loadAutoReviewPreference: async () => ({
        enabled: options.mode === "auto",
        skipApprovals: options.mode === "never",
      }),
      receivedOutsideMessage: async () => Boolean(options.tainted),
    },
  };
}

async function planFor(name: string, args: Record<string, unknown>, options: Options) {
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
  const ctx = gateCtx(options);
  const prepared = await prepareToolRequest(ctx as never, request);
  if (prepared) return { prepared };
  const outcome = await gateToolCall(ctx as never, request, undefined).catch(
    (error: Error) => error.message,
  );
  return { plans: [...plans], outcome };
}

describe("execute_code is gated exactly as shell is", () => {
  const cases: Options[] = [];
  for (const mode of ["ask", "auto", "never"] as const)
    for (const trigger of ["user", "webhook", "messaging"])
      for (const tainted of [false, true])
        for (const rule of [undefined, "always_allow" as const, "deny" as const])
          cases.push({ mode, trigger, tainted, rule });

  it.each(cases)("%j", async (options) => {
    const shell = await planFor("shell", { command: "python3 -c 'print(1)'" }, options);
    const code = await planFor("execute_code", { code: "print(1)" }, options);
    expect(code.plans).toEqual(shell.plans);
    // The same outcome, naming its own tool.
    expect(JSON.stringify(code.outcome)).toBe(
      JSON.stringify(shell.outcome).replaceAll("shell", "execute_code"),
    );
  });
});

describe("a rule saved for execute_code", () => {
  it("covers execute_code alone, never shell", async () => {
    const options = { mode: "ask" as const, rule: "deny" as const, ruleFor: "execute_code" };
    expect((await planFor("execute_code", { code: "1" }, options)).plans).toEqual(["deny"]);
    expect((await planFor("shell", { command: "true" }, options)).plans).toEqual(["allow"]);
  });
});

describe("executeCodeTool", () => {
  const computer: ComputerRef = { id: "c1", botId: "bot-1", kind: "docker", providerRef: "c1" };
  const events: Array<Record<string, unknown>> = [];
  const requests: CommandRequest[] = [];

  function handlerCtx(
    options: {
      graphical?: boolean;
      host?: { platform: string; home: string; shell: string };
      answer?: (request: CommandRequest) => ProcessEvent[];
    } = {},
  ) {
    return {
      deps: {
        prisma: {},
        secretStore: {},
        events: {
          append: vi.fn(async (event: { payload: Record<string, unknown> }) => {
            events.push(event.payload);
          }),
        },
        sandbox: {
          async *execute(_computer: ComputerRef, request: CommandRequest) {
            requests.push(request);
            const events = options.answer?.(request) ?? [
              {
                type: "stdout" as const,
                data: `token fake-command-variable\n\n${request.argv[6]}\n{"timedOut":false,"status":0}\n{"result":2}`,
              },
              { type: "exit" as const, code: 0 },
            ];
            for (const event of events) yield event;
          },
        },
      },
      run: { id: "run-1", spaceId: "space-1", botId: "bot-1", userId: "user-1" },
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { id: "thread-1" },
      context: { signal: new AbortController().signal },
      computer: {
        graphical: options.graphical ?? true,
        stored: { id: "c1", kind: "docker" },
        mode: "dedicated",
        hostEnvironment: options.host,
        checkpoint: { markDirty: vi.fn() },
        get: async () => computer,
      },
      secrets: [] as string[],
      state: { reply: { pendingProgress: "", redactor: { finish: () => "" } } },
    };
  }
  const call = (args: Record<string, unknown>) => ({
    name: "execute_code",
    args,
    executionId: "exec-1",
    finish: async (result: unknown) => result,
  });

  beforeEach(() => {
    events.length = 0;
    requests.length = 0;
    vaultUses.length = 0;
  });

  it("runs on the computer with shell's variables, records the command, and redacts them", async () => {
    const ctx = handlerCtx();
    const result = await executeCodeTool(ctx as never, call({ code: "print(1)\n2" }) as never);
    expect(result).toEqual({
      stdout: "token [redacted]\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      result: 2,
    });
    expect(requests[0]).toMatchObject({
      env: { API_TOKEN: "fake-command-variable" },
      unsetEnv: ["OLD"],
      timeoutMs: 40_000,
    });
    expect(requests[0]!.argv.at(-1)).toBe("print(1)\n2");
    expect(events.map((event) => [event.kind, event.status, event.exitCode])).toEqual([
      ["shell", "running", null],
      ["shell", "done", 0],
    ]);
    expect(events[0]!.command).toBe("python3 - <<'EOF'\nprint(1)\n2\nEOF");
    expect(JSON.stringify(events)).not.toContain("fake-command-variable");
    expect(vaultUses).toEqual([["execute_code", { id: "item-1" }]]);
    expect(ctx.computer.checkpoint.markDirty).toHaveBeenCalled();
  });

  it("refuses code naming a desktop process on a desktop the guard protects, and runs nothing", async () => {
    const result = await executeCodeTool(
      handlerCtx() as never,
      call({ code: "import subprocess\nsubprocess.run(['pkill', 'chromium'])" }) as never,
    );
    expect(result).toEqual({ error: expect.stringContaining("desktop-protection guard") });
    expect(requests).toEqual([]);
    // A computer without a desktop has nothing to protect.
    await executeCodeTool(
      handlerCtx({ graphical: false }) as never,
      call({ code: "import subprocess\nsubprocess.run(['pkill', 'worker'])" }) as never,
    );
    expect(requests).toHaveLength(1);
  });

  it("says a Windows computer cannot run it, and runs nothing", async () => {
    const result = await executeCodeTool(
      handlerCtx({
        host: { platform: "win32", home: "C:\\Users\\bot", shell: "powershell.exe" },
      }) as never,
      call({ code: "print(1)" }) as never,
    );
    expect(result).toEqual({ error: expect.stringContaining("Windows") });
    expect(requests).toEqual([]);
  });

  it("refuses an invalid call before reaching the computer", async () => {
    expect(await executeCodeTool(handlerCtx() as never, call({}) as never)).toEqual({
      error: expect.stringContaining("needs code"),
    });
    expect(requests).toEqual([]);
  });

  it("records a missing interpreter as a failed command", async () => {
    const result = await executeCodeTool(
      handlerCtx({
        answer: (request) => [
          {
            type: "stdout",
            data: `\n${request.argv[6]}\n{"timedOut":false,"status":127,"missing":"python3"}\n`,
          },
          { type: "exit", code: 127 },
        ],
      }) as never,
      call({ code: "print(1)" }) as never,
    );
    expect(result).toEqual({ error: expect.stringContaining("no python3") });
    expect(events.at(-1)).toMatchObject({ status: "done", exitCode: 127 });
  });
});
