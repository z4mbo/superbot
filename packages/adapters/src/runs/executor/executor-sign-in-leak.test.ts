import type { ComputerRef } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { blocksToAgentHistoryText } from "@rakazo/core";
import { installAuditEventStore } from "@rakazo/db";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeBrowserProvider } from "../../browser/fake-browser.js";
import { pageBrowserSessionKey } from "../../browser/page-browser-session.js";
import type * as ComputerLifecycleModule from "../../computers/computer-lifecycle.js";
import { EncryptedSecretStore } from "../../secrets/secrets.js";
import type { VaultSecretFixture } from "../../secrets/vault/vault-leak.test-support.js";
import {
  expectNoVaultSecrets,
  findVaultSecretLeaks,
} from "../../secrets/vault/vault-leak.test-support.js";
import { SIGN_IN_FILLED } from "../../sign-in-sources/sign-in.prompt.js";
import { SIGN_IN_TIMING } from "../../sign-in-sources/sign-in-requests.js";
import {
  EMULATOR_LOGIN,
  EmulatorSignInSourceProvider,
} from "../../sign-in-sources/sign-in-source-emulator.js";
import { createRunExecutor } from "./executor.js";

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

vi.mock("../../computers/computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  waitForRunComputerLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer: async () => COMPUTER,
}));

// The emulator's fixture login: its extension types these into the page, and nothing else sees them.
const FIXTURE: VaultSecretFixture = {
  passwords: [EMULATOR_LOGIN.username, EMULATOR_LOGIN.password],
  // A one-time code is found as a number of its own, so an id that happens to contain it is not.
  cvcs: [EMULATOR_LOGIN.oneTimeCode],
};

const SITE = "https://login.example.test";
const PAGE = `<!doctype html><html><head><title>Sign in</title></head><body>
  <form><input aria-label="Email" type="email" autocomplete="username" />
  <input aria-label="Password" type="password" />
  <input aria-label="Code" autocomplete="one-time-code" />
  <button>Sign in</button></form></body></html>`;
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
const TIMING = { ...SIGN_IN_TIMING };

/** Every database call, by model and method, so a test can check what was written anywhere. */
function recordingPrisma(models: Record<string, Record<string, unknown>>, calls: unknown[]) {
  const fallback: Record<string, (...args: unknown[]) => unknown> = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, model: string) => {
        if (model === "$transaction") return async (fn: (tx: unknown) => unknown) => fn(prisma);
        if (model === "$queryRaw") return async () => [{ locked: 1 }];
        if (model === "$executeRaw") return async () => 1;
        const methods = models[model] ?? {};
        return new Proxy(methods, {
          get: (target, method: string) => {
            const impl = (target[method] ?? fallback[method]) as
              | ((...args: unknown[]) => unknown)
              | undefined;
            return async (...args: unknown[]) => {
              calls.push([model, method, args]);
              return impl ? impl(...args) : null;
            };
          },
        });
      },
    },
  );
  return prisma;
}

/** Matches a row against the plain fields of a where; operators other than equality pass. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (!(key in row)) return true;
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("not" in value) return row[key] !== value.not;
      if ("gt" in value) return row[key] instanceof Date && row[key] > (value.gt as Date);
      return true;
    }
    return row[key] === value;
  });
}

type ExecuteTool = (
  name: string,
  args: Record<string, unknown>,
  executionId: string,
) => Promise<unknown>;

/**
 * One run on a sign-in page: the bot asks to sign in with the person's connected password
 * manager, the person opens the review and approves it there, the emulator's extension fills the
 * page, and the bot looks at the page. Everything the model was handed, everything the run wrote
 * and logged, and the history the next turn is built from are returned, with the page's fields.
 */
async function runSignIn() {
  // No waiting in a test: the person opens the review at once and the first check answers.
  Object.assign(SIGN_IN_TIMING, { firstCheckMs: 0, checkEveryMs: () => 0 });
  const run = {
    id: "run-1",
    botId: scope.botId,
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: scope.spaceId,
    userId: scope.userId,
    status: "queued",
    trigger: "message",
    routineId: null,
    retryOfRunId: null,
    leaseFence: 0,
  };
  const provider = new EmulatorSignInSourceProvider();
  // The person's connection, sealed as the connect flow seals it.
  const sealed = await secretStore.put(
    JSON.stringify({ secret: "emulator-token:emulator-key:fixture" }),
    { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
    { recordId: "source-secret-1" },
  );
  const source = {
    id: "source-1",
    userId: scope.userId,
    provider: "emulator",
    status: "connected",
    secretId: "source-secret-1",
    refreshAt: null,
    connectExpiresAt: null,
    connectedAt: new Date("2026-11-01T10:00:00.000Z"),
  };
  const secrets = [
    { ...sealed, id: "source-secret-1", userId: scope.userId, kind: "sign_in_source" },
  ];
  const requests: Array<Record<string, unknown>> = [];
  const messages: Array<{ id: string; blocks: MessageBlock[]; botId: string; runId: string }> = [];
  const browser = new FakeBrowserProvider();
  for (const bot of [run.botId, COMPUTER.botId])
    browser.sessions.get(pageBrowserSessionKey(COMPUTER, { botId: bot })).load(`${SITE}/`, PAGE);
  const toolCalls = [
    { name: "sign_in", args: { site: `${SITE}/` } },
    { name: "browser_snapshot", args: {} },
  ];
  const calls: unknown[] = [];
  const toolResults: Array<{ name: string; result: unknown }> = [];
  const modelRequests: unknown[] = [];
  const runtimeRun = vi.fn(async function* (request: { executeTool?: ExecuteTool }) {
    const { secrets: _live, ...sent } = request as { secrets?: unknown };
    modelRequests.push(JSON.parse(JSON.stringify(sent)));
    for (const [index, call] of toolCalls.entries()) {
      toolResults.push({
        name: call.name,
        result: await request
          .executeTool?.(call.name, call.args, `exec-${index}`)
          .catch((error: unknown) => ({ thrown: (error as Error).message })),
      });
    }
    yield { type: "text-delta" as const, text: "Signed in." };
    yield { type: "done" as const, text: "Signed in." };
  });
  const prisma = recordingPrisma(
    {
      spaceMember: { findUnique: async () => ({ id: "member-1" }) },
      run: {
        findUnique: async () => run,
        findUniqueOrThrow: async () => run,
        findFirst: async () => ({ bot: { notifyOnFinish: false }, thread: { groupId: null } }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(run, data);
          return { count: 1 };
        },
      },
      bot: {
        findUniqueOrThrow: async () => ({
          id: run.botId,
          name: "Helper",
          title: "Helper",
          description: "Test assistant",
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
          computerId: "computer-1",
          computerSwitching: false,
          memoryScope: null,
          computer: { id: "computer-1", scope: "dedicated", kind: "e2b", homeKey: "home-1" },
        }),
        findMany: async () => [],
      },
      attempt: {
        create: async () => ({ id: "attempt-1" }),
        updateMany: async () => ({ count: 1 }),
      },
      thread: {
        findUniqueOrThrow: async () => ({
          id: run.threadId,
          groupId: null,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
          nextMessageSeq: 1,
        }),
        update: async () => ({ nextMessageSeq: 1, nextEventSeq: 1 }),
      },
      message: {
        create: async ({ data }: { data: { blocks: MessageBlock[] } }) => {
          const message = { id: `message-${messages.length + 1}`, botId: run.botId, runId: run.id };
          messages.push({ ...message, blocks: data.blocks });
          return { ...message, ...data };
        },
        findFirst: async ({ where }: { where: { id?: string } }) =>
          messages.find((message) => message.id === where.id) ?? null,
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { blocks: MessageBlock[] };
        }) => {
          const message = messages.find((row) => row.id === where.id);
          if (message) message.blocks = data.blocks;
          return message;
        },
      },
      event: {
        create: async ({ data }: { data: { seq: number } }) => ({ ...data, createdAt: new Date() }),
      },
      task: { findUniqueOrThrow: async () => ({ id: run.taskId, prompt: "Sign in to the site" }) },
      signInSource: { findUnique: async () => source },
      signInRequest: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          requests.find((row) => matches(row, where)) ?? null,
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
          requests.find((row) => row.id === where.id),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: `request-${requests.length + 1}`,
            messageId: null,
            openedAt: null,
            ...data,
          };
          requests.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: object }) =>
          Object.assign(requests.find((row) => row.id === where.id) ?? {}, data),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
          const rows = requests.filter((row) => matches(row, where));
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
      },
      secret: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          secrets.find((row) => matches(row, where)) ?? null,
      },
      deploymentSettings: {
        findUnique: async () => ({ defaultModelProvider: "local", defaultModelId: "local-model" }),
      },
      actionAutoReviewPreference: {
        findUnique: async () => ({ enabled: false, skipApprovals: true }),
      },
      userActionAutoReviewPreference: {
        findUnique: async () => ({ enabled: false, skipApprovals: true }),
      },
      externalEffect: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          id: `effect-${data.idempotencyKey}`,
          ...data,
        }),
        updateMany: async () => ({ count: 1 }),
        update: async ({ data }: { data: Record<string, unknown> }) => data,
      },
    },
    calls,
  );
  const logged: unknown[] = [];
  const logger = Logging.getLogger();
  for (const level of ["debug", "info", "warn", "error"] as const)
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logged.push([level, ...args]);
    });
  const audit: unknown[] = [];
  installAuditEventStore({
    auditEvent: {
      createMany: async ({ data }: { data: unknown[] }) => {
        audit.push(...data);
        return { count: data.length };
      },
    },
    space: { findUnique: async () => ({ organizationId: "org-1", name: "Home" }) },
    user: { findUnique: async () => null },
    member: { findUnique: async () => ({ role: "owner" }), findMany: async () => [] },
  } as never);
  const events = {
    append: vi.fn(async () => undefined),
    finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    pauseRunForTakeover: vi.fn(async () => false),
    pauseRunForInput: vi.fn(async () => true),
    notify: vi.fn(async () => undefined),
    // The person opens the card's review: the server marks the card opened and signals the thread,
    // which is what the waiting call follows. Nothing polls.
    follow: vi.fn(async function* () {
      const card = messages.find((message) => message.blocks.some((b) => b.kind === "sign_in"));
      if (!card) return;
      const request = requests[0];
      if (request) request.openedAt = new Date();
      yield {
        type: "thread.message.updated",
        payload: {
          messageId: card.id,
          blocks: card.blocks.map((block) =>
            block.kind === "sign_in" ? { ...block, opened: true } : block,
          ),
        },
      };
    }),
  };
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    browser,
    signInSource: provider,
    sandbox: {
      describe: () => ({ id: "e2b", capabilities: { graphical: true } }),
      releaseScreen: vi.fn(async () => undefined),
      execute: vi.fn(async function* () {
        yield { type: "exit" as const, code: 0 };
      }),
      async *exportWorkspace() {
        yield* [];
      },
    },
    secretStore,
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn() },
    events,
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  const page = browser.sessions.get(pageBrowserSessionKey(COMPUTER, { botId: run.botId }));
  const typed = (page as unknown as { dom: { window: { document: Document } } }).dom.window
    .document;
  const value = (label: string) =>
    typed.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value;
  const stored = messages.flatMap((message) => message.blocks);
  return {
    places: {
      "model request": modelRequests,
      "tool results": toolResults,
      "stored message blocks": stored,
      // What the next turn reads of this one: the transcript as the model's history renders it.
      "next turn's history": blocksToAgentHistoryText(stored),
      "thread events": events.append.mock.calls,
      "finalized reply": events.finalizeRun.mock.calls,
      "database writes": calls.filter(
        (call) =>
          !["findMany", "findFirst", "findUnique", "findUniqueOrThrow", "count"].includes(
            (call as [string, string])[1],
          ),
      ),
      logs: logged,
      "audit log": audit,
    },
    toolResults,
    audit,
    requests,
    stored,
    page: { email: value("Email"), password: value("Password"), code: value("Code") },
  };
}

afterEach(() => {
  Object.assign(SIGN_IN_TIMING, TIMING);
  vi.restoreAllMocks();
  installAuditEventStore(undefined);
});

describe("a run that signs in with the person's password manager", () => {
  it("fills the approved login in the page and hands the model none of it", async () => {
    const { places, toolResults, page, requests, stored, audit } = await runSignIn();
    // The fill reached the page: the extension typed the login the person approved.
    expect(page).toEqual({
      email: EMULATOR_LOGIN.username,
      password: EMULATOR_LOGIN.password,
      code: EMULATOR_LOGIN.oneTimeCode,
    });
    // The bot only learned that the login was filled.
    expect(JSON.stringify(toolResults[0])).toContain(JSON.stringify(SIGN_IN_FILLED).slice(1, -1));
    expect(requests[0]).toMatchObject({ status: "approved", site: SITE });
    expect(stored).toContainEqual(
      expect.objectContaining({ kind: "sign_in", status: "approved", site: SITE }),
    );
    const actions = (audit as Array<{ action: string }>).map((row) => row.action);
    expect(actions.filter((action) => action.startsWith("sign_in"))).toEqual([
      "sign_in.requested",
      "sign_in.approved",
      "sign_in.filled",
    ]);
    // The model's whole request, every tool result (the snapshot too), the stored card and the
    // history the next turn reads, every write, log and audit row: none holds the username, the
    // password or the code.
    expectNoVaultSecrets(places, FIXTURE);
  });

  it("would fail on a leak: the same check finds each value where it was put", async () => {
    const { places } = await runSignIn();
    const leaked = {
      ...places,
      "tool results": [
        ...(places["tool results"] as unknown[]),
        {
          name: "sign_in",
          result: `${EMULATOR_LOGIN.username} ${encodeURIComponent(EMULATOR_LOGIN.password)}`,
        },
      ],
      "next turn's history": `${places["next turn's history"]}\ncode ${EMULATOR_LOGIN.oneTimeCode}`,
    };
    expect(() => expectNoVaultSecrets(leaked, FIXTURE)).toThrow(/Vault secrets leaked/);
    expect(findVaultSecretLeaks(leaked, FIXTURE)).toEqual([
      `password "${EMULATOR_LOGIN.username}" in tool results`,
      `password "${encodeURIComponent(EMULATOR_LOGIN.password)}" in tool results`,
      `security code "${EMULATOR_LOGIN.oneTimeCode}" in next turn's history`,
    ]);
  });
});
