import type { ComputerRef } from "@rakazo/adapter-kit";
import { encodeCardSecret, encodeLoginSecret } from "@rakazo/contracts";
import { installAuditEventStore, runCardKind, runLoginKind } from "@rakazo/db";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeBrowserProvider } from "../../browser/fake-browser.js";
import { pageBrowserSessionKey } from "../../browser/page-browser-session.js";
import type * as ComputerLifecycleModule from "../../computers/computer-lifecycle.js";
import { encodeRunLogin } from "../../secrets/bot-secrets.js";
import { EncryptedSecretStore } from "../../secrets/secrets.js";
import type { VaultSecretFixture } from "../../secrets/vault/vault-leak.test-support.js";
import {
  expectNoVaultSecrets,
  findVaultSecretLeaks,
} from "../../secrets/vault/vault-leak.test-support.js";
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

// Fixture values only: the test card numbers every processor documents and made-up passwords.
const SAVED_CARD = { number: "4242424242424242", expMonth: 8, expYear: 2030, cvc: "123" };
const ONCE_CARD = { number: "5555555555554444", expMonth: 9, expYear: 2031, cvc: "737" };
const SAVED_PASSWORD = "fixture-pass-9f3";
const ONCE_PASSWORD = "fixture-once-7c1";
const USERNAME = "fixture-user@example.test";
const FIXTURE: VaultSecretFixture = {
  cardNumbers: [SAVED_CARD.number, ONCE_CARD.number],
  cvcs: [SAVED_CARD.cvc, ONCE_CARD.cvc],
  passwords: [SAVED_PASSWORD, ONCE_PASSWORD],
};

const SITE = "https://shop.example.test";
const CHECKOUT = `${SITE}/checkout`;
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
const SAVED_AT = new Date("2026-11-01T10:00:00.000Z");
const SENT_AT = new Date("2026-11-25T10:00:00.000Z");

/**
 * A checkout whose page text prints both cards in every way a page prints one, and both
 * passwords, as a page that echoes what was typed would. The CVC is never printed: a page
 * never shows it, and a filled field's value is never in a snapshot.
 */
const PAGE = `<!doctype html><html><head><title>Checkout</title></head><body>
  <p>Signed in as ${USERNAME}</p>
  <p>Echo ${SAVED_PASSWORD} and ${ONCE_PASSWORD}</p>
  <p>Card 4242 4242 4242 4242 · 4242-4242-4242-4242 · 4242424242424242</p>
  <p>Once 5555 5555 5555 4444 · 5555-5555-5555-4444 · 5555555555554444</p>
  <input aria-label="Email" type="email" />
  <input aria-label="Password" type="password" />
  <input aria-label="Card number" autocomplete="cc-number" />
  <input aria-label="Expiry" autocomplete="cc-exp" />
  <input aria-label="CVC" autocomplete="cc-csc" type="password" />
  </body></html>`;

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

const put = (plaintext: string, recordId?: string) =>
  secretStore.put(
    plaintext,
    { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
    recordId ? { recordId } : { ephemeral: true },
  );

/** Matches a row against the plain fields, `startsWith`, `in` and `OR` of a where. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Record<string, unknown>[]).some((or) => matches(row, or));
    if (key === "AND")
      return (value as Record<string, unknown>[]).every((and) => matches(row, and));
    if (!(key in row)) return true;
    if (value && typeof value === "object" && "startsWith" in value)
      return String(row[key]).startsWith(String(value.startsWith));
    if (value && typeof value === "object" && "in" in value)
      return (value.in as unknown[]).includes(row[key]);
    if (value && typeof value === "object") return true;
    return row[key] === value;
  });
}

type ExecuteTool = (
  name: string,
  args: Record<string, unknown>,
  executionId: string,
) => Promise<unknown>;

/**
 * One run that types a saved login, a saved card, and a card and a login a Secure form sent for
 * this run only, then reads the page, the vault and a file. Everything the model was handed and
 * everything the run wrote is returned, with what the page's fields hold afterwards.
 */
async function runCheckout(options: { reply?: string; leakRedaction?: boolean } = {}) {
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
  const vault = [
    {
      ...(await put(encodeCardSecret(SAVED_CARD), "card-1")),
      id: "card-1",
      userId: scope.userId,
      spaceId: null,
      name: "visa",
      title: "Visa ·· 4242",
      origin: "",
      auth: { type: "card" },
      policy: "allow",
      alsoOn: [],
      updatedAt: SAVED_AT,
      createdAt: SAVED_AT,
    },
    {
      ...(await put(
        encodeLoginSecret({
          fields: [
            { label: "Username", value: USERNAME, hidden: false },
            { label: "Password", value: SAVED_PASSWORD, hidden: true },
          ],
        }),
        "login-1",
      )),
      id: "login-1",
      userId: scope.userId,
      spaceId: null,
      name: "shop_login",
      title: "shop.example.test",
      origin: SITE,
      auth: { type: "login" },
      policy: "allow",
      alsoOn: [],
      updatedAt: SAVED_AT,
      createdAt: SAVED_AT,
    },
  ];
  // What two Secure forms sent with Save to Vault off: kept under the run, never in the vault.
  const secrets = [
    {
      ...(await put(encodeCardSecret(ONCE_CARD))),
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: runCardKind(run.id, "once_card"),
      createdAt: SENT_AT,
    },
    {
      ...(await put(
        encodeRunLogin(
          SITE,
          encodeLoginSecret({
            fields: [
              { label: "Username", value: "once-user@example.test", hidden: false },
              { label: "Password", value: ONCE_PASSWORD, hidden: true },
            ],
          }),
        ),
      )),
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: runLoginKind(run.id, "once_login"),
      createdAt: SENT_AT,
    },
  ];
  // The person approved typing each card into this checkout, as the approval card asked.
  const cardFill = (card: string, savedAt: Date) => ({
    actions: (["number", "expiry", "cvc"] as const).map((field) => ({
      kind: "fill_card",
      card,
      site: CHECKOUT,
      field,
    })),
    cardApproval: { card, site: SITE, title: card, savedAt: savedAt.toISOString() },
  });
  const effects = [
    {
      id: "effect-saved-card",
      runId: run.id,
      spaceId: run.spaceId,
      kind: "browser_act",
      status: "approved",
      idempotencyKey: "approved-saved-card",
      request: cardFill("visa", SAVED_AT),
    },
    {
      id: "effect-once-card",
      runId: run.id,
      spaceId: run.spaceId,
      kind: "browser_act",
      status: "approved",
      idempotencyKey: "approved-once-card",
      request: cardFill("once_card", SENT_AT),
    },
  ];
  const browser = new FakeBrowserProvider();
  for (const bot of [run.botId, COMPUTER.botId]) {
    const session = browser.sessions.get(pageBrowserSessionKey(COMPUTER, { botId: bot }));
    session.load(CHECKOUT, PAGE);
    // Refs e1 to e5 are the inputs, as a snapshot the bot took before the run resumed named them.
    session.snapshot();
  }
  /** The page's refs by field, from one fresh snapshot, as the bot reads them. */
  const refs = () => {
    const session = browser.sessions.get(pageBrowserSessionKey(COMPUTER, { botId: run.botId }));
    const { elements = [] } = session.snapshot();
    return (label: string) => elements.find((element) => element.name === label)?.ref;
  };
  // Refs are read just before each call, as the bot reads them from the page it last saw.
  const toolCalls: Array<{ name: string; args: () => Record<string, unknown> }> = [
    { name: "browser_act", args: () => ({ actions: cardFill("visa", SAVED_AT).actions }) },
    { name: "browser_act", args: () => ({ actions: cardFill("once_card", SENT_AT).actions }) },
    {
      name: "browser_act",
      args: () => {
        const ref = refs();
        return {
          actions: [
            { kind: "fill_secret", ref: ref("Email"), secret: "shop_login", field: "Username" },
            {
              kind: "fill_secret",
              ref: ref("Password"),
              secret: "shop_login",
              field: "Password",
            },
          ],
        };
      },
    },
    {
      name: "browser_act",
      args: () => ({
        actions: [
          { kind: "fill_secret", ref: refs()("Password"), secret: "once_login", field: "Password" },
        ],
      }),
    },
    { name: "browser_snapshot", args: () => ({}) },
    { name: "list_secrets", args: () => ({}) },
    { name: "read_file", args: () => ({ path: "receipt.txt" }) },
  ];
  const calls: unknown[] = [];
  const toolResults: Array<{ name: string; result: unknown }> = [];
  const requests: unknown[] = [];
  const redacting: string[] = [];
  const runtimeRun = vi.fn(async function* (request: {
    executeTool?: ExecuteTool;
    secrets?: readonly string[];
  }) {
    // The whole request the model is built from: system prompt, history, the new turn and every
    // tool's definition. `secrets` is the runtime's own list of values to redact, which it never
    // sends; it is checked apart, below.
    const { secrets: live, ...sent } = request;
    requests.push(JSON.parse(JSON.stringify(sent)));
    for (const [index, call] of toolCalls.entries()) {
      toolResults.push({
        name: call.name,
        result: await request
          .executeTool?.(call.name, call.args(), `exec-${index}`)
          .catch((error: unknown) => ({ thrown: (error as Error).message })),
      });
    }
    redacting.push(...(live ?? []));
    const reply = options.reply ?? "Paid and signed in.";
    yield { type: "text-delta" as const, text: reply };
    yield { type: "done" as const, text: reply };
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
          name: "Shopper",
          title: "Shopper",
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
      message: { create: async ({ data }: { data: object }) => ({ id: "message-1", ...data }) },
      task: { findUniqueOrThrow: async () => ({ id: run.taskId, prompt: "Pay at the checkout" }) },
      vaultCredential: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          vault.find((row) => matches(row, where)) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          vault.filter((row) => matches(row, where)),
      },
      secret: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          secrets.find((row) => matches(row, where)) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          secrets.filter((row) => matches(row, where)),
        count: async ({ where }: { where: Record<string, unknown> }) =>
          secrets.filter((row) => matches(row, where)).length,
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
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          effects.filter((effect) => matches(effect, where)),
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          effects.find((effect) => matches(effect, where)) ?? null,
        findUnique: async ({ where }: { where: Record<string, unknown> }) =>
          effects.find((effect) => matches(effect, where)) ?? null,
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
  };
  const receipt = `Card ${SAVED_CARD.number} paid; also ${ONCE_CARD.number}; pass ${SAVED_PASSWORD}`;
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    browser,
    sandbox: {
      describe: () => ({ id: "e2b", capabilities: { graphical: true } }),
      releaseScreen: vi.fn(async () => undefined),
      readFile: vi.fn(async () => new TextEncoder().encode(receipt)),
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
  // What the page's fields hold now: the fills reached the page, though the model never saw them.
  const page = browser.sessions.get(pageBrowserSessionKey(COMPUTER, { botId: run.botId }));
  const typed = (page as unknown as { dom: { window: { document: Document } } }).dom.window
    .document;
  const value = (label: string) =>
    typed.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value;
  return {
    places: {
      "model request": requests,
      "tool results": toolResults,
      "thread events": events.append.mock.calls,
      "finalized reply": events.finalizeRun.mock.calls,
      "paused cards": events.pauseRunForInput.mock.calls,
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
    redacting,
    page: {
      number: value("Card number"),
      cvc: value("CVC"),
      password: value("Password"),
      email: value("Email"),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  installAuditEventStore(undefined);
});

describe("a run that fills saved and one-time cards and logins", () => {
  it("types every value into the page and hands the model none of them", async () => {
    const { places, toolResults, page, redacting } = await runCheckout();
    // Each fill went through: the last card typed is the one-time one, the last password too.
    expect(toolResults.slice(0, 4).map(({ result }) => JSON.stringify(result))).toEqual(
      Array.from({ length: 4 }, () => expect.stringContaining('\\"ok\\":true')),
    );
    expect(page.number).toBe(ONCE_CARD.number);
    expect(page.cvc).toBe(ONCE_CARD.cvc);
    expect(page.password).toBe(ONCE_PASSWORD);
    expect(page.email).toBe(USERNAME);
    // The model's whole request, every tool result, what the run wrote and logged: none holds
    // a card number in any printed form, a security code, or a password.
    expectNoVaultSecrets(places, FIXTURE);
    // The page's echo of them reached the model only as [redacted], as the run hides each value
    // the moment it is typed, and the one-time ones from the start.
    expect(JSON.stringify(toolResults)).toContain("[redacted]");
    expect(redacting).toEqual(
      expect.arrayContaining([SAVED_CARD.number, ONCE_CARD.number, SAVED_PASSWORD, ONCE_PASSWORD]),
    );
  });

  it("records the one-time fills, and the saved items' uses, without a value", async () => {
    const { audit } = await runCheckout();
    const actions = (audit as Array<{ action: string; targetLabel: string | null }>).map(
      (row) => `${row.action} ${row.targetLabel}`,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "credential.used visa",
        "credential.used shop_login",
        "vault.fill_completed once_card",
        "vault.fill_completed once_login",
      ]),
    );
    expectNoVaultSecrets({ audit }, FIXTURE);
  });

  it("hides a card number or password the model itself writes in its reply", async () => {
    const { places } = await runCheckout({
      reply: `Paid with 4242 4242 4242 4242 and ${ONCE_PASSWORD}.`,
    });
    expectNoVaultSecrets(places, FIXTURE);
  });

  it("would fail on a leak: the same check finds each value in an unredacted result", async () => {
    const { places } = await runCheckout();
    // Negative control: the very context the run produced, with one tool result that redaction
    // missed, is reported for every value and form it holds.
    const leaked = {
      ...places,
      "tool results": [
        ...(places["tool results"] as unknown[]),
        {
          name: "browser_snapshot",
          result: `4242-4242-4242-4242 cvc ${SAVED_CARD.cvc} ${encodeURIComponent(SAVED_PASSWORD)}`,
        },
      ],
    };
    expect(() => expectNoVaultSecrets(leaked, FIXTURE)).toThrow(/Vault secrets leaked/);
    expect(findVaultSecretLeaks(leaked, FIXTURE)).toEqual([
      'card number "4242-4242-4242-4242" in tool results',
      'security code "123" in tool results',
      `password "${SAVED_PASSWORD}" in tool results`,
    ]);
  });
});
