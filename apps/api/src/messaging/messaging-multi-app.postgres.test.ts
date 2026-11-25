import { randomUUID } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import type { MessagingInboundMessage, MessagingSurface } from "@rakazo/adapter-kit";
import { createChildRoutine, MessagingDelivery } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  botChatIdentity,
  createDb,
  createThreadEvents,
  issueMessagingLinkCode,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";
import { createMessagingInboundHandler } from "./messaging-inbound.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

// Two chat apps the server offers. Each person has one account (address) on each.
const APP_A = "test-a";
const APP_B = "test-b";

describe.skipIf(!enabled)("a bot linked to several chat apps (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let delivery: MessagingDelivery;
  let inbound: (event: MessagingInboundMessage) => Promise<void>;
  let router: ReturnType<typeof createRouter>;
  const sent: Array<{ threadId: string; body: string }> = [];
  const people: Array<{ userId: string; spaceId: string }> = [];
  let seq = 10_000;
  const jobs = {
    enqueue: vi.fn(async () => undefined),
    enqueueIn: vi.fn(async () => undefined),
    enqueueManyIn: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    cancelIn: vi.fn(async () => undefined),
    pendingUntil: vi.fn(async () => ({ until: null, own: false })),
    releaseFollowersIn: vi.fn(async () => undefined),
    close: async () => undefined,
  };
  const surface = {
    platforms: () => [],
    openDirectThread: vi.fn(async (provider: string, address: string) =>
      dmThread(provider, address),
    ),
    sendToThread: vi.fn(async ({ threadId, body }: { threadId: string; body: string }) => {
      sent.push({ threadId, body });
      return { handle: `handle-${sent.length}` };
    }),
  } as unknown as MessagingSurface;

  const dmThread = (provider: string, address: string) => `${provider}:dm:${address}`;

  beforeAll(() => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    const events = createThreadEvents(prisma);
    delivery = new MessagingDelivery({
      prisma,
      messaging: surface,
      events,
      jobs,
      artifacts: { get: vi.fn() },
    });
    const handler = createMessagingInboundHandler({
      prisma,
      events,
      jobs,
      delivery,
      sandbox: {
        execute: vi.fn(async function* () {
          yield { type: "exit", code: 0 };
        }),
        releaseScreen: vi.fn().mockResolvedValue(undefined),
      } as never,
      provision: vi.fn(),
      openSignup: false,
    });
    inbound = (event) => runAsSystem("test inbound", () => handler(event));
    router = createRouter({
      prisma,
      events,
      jobs,
      env: {},
      messagingDelivery: delivery,
    } as unknown as RouterDeps);
  });

  afterAll(async () => {
    if (!db) return;
    for (const { userId, spaceId } of people) {
      await system.messagingIdentity.deleteMany({ where: { userId } });
      await system.organization.deleteMany({ where: { id: spaceId } });
      await system.user.deleteMany({ where: { id: userId } });
    }
    await prisma.$disconnect();
    await db.pool.end();
  });

  /** A direct message from `address` on `provider`. */
  const dm = (provider: string, address: string, content: string) =>
    inbound({
      type: "message",
      provider,
      // Handles are unique per run: delivery receipts outlive the fixture.
      handle: `${address}:${randomUUID()}`,
      threadId: dmThread(provider, address),
      isDirect: true,
      from: address,
      fromLabel: null,
      channelName: null,
      participants: [],
      content,
      mediaUrl: null,
    });

  async function call(actor: Actor, path: string, input?: unknown) {
    const { response } = await new RPCHandler(router).handle(
      new Request(`https://api.example.test/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input ?? null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response?.json()) as { json: unknown };
    return { status: response?.status, json: body?.json };
  }

  /**
   * A person whose bot answers app A, then links app B to the same bot from Settings with a
   * code they send from B.
   */
  async function linkedBot() {
    const a = `a-${randomUUID()}`;
    const b = `b-${randomUUID()}`;
    const owner = await runAsSystem("fixture", () =>
      provisionMessagingIdentity(prisma, {
        provider: APP_A,
        address: a,
        dmThreadId: dmThread(APP_A, a),
      }),
    );
    people.push(owner);
    const actor: Actor = {
      spaceId: owner.spaceId,
      userId: owner.userId,
      email: `${owner.userId}@example.test`,
      isDeploymentOwner: false,
    };
    const issued = await call(actor, "messaging/link/start", { botId: owner.botId });
    expect(issued.status).toBe(200);
    await dm(APP_B, b, (issued.json as { code: string }).code);
    const identity = (provider: string, address: string) =>
      system.messagingIdentity.findUniqueOrThrow({
        where: { provider_address: { provider, address } },
      });
    return {
      ...owner,
      actor,
      a,
      b,
      identityA: await identity(APP_A, a),
      identityB: await identity(APP_B, b),
    };
  }

  type Linked = Awaited<ReturnType<typeof linkedBot>>;

  /** The run a direct message from `address` started, by the message's own nonce. */
  async function runFrom(bot: { botId: string }, provider: string, address: string) {
    const runs = await system.run.findMany({
      where: { botId: bot.botId, trigger: "messaging" },
      include: { sourceMessage: { select: { clientNonce: true } } },
      orderBy: { createdAt: "desc" },
    });
    const run = runs.find((candidate) =>
      candidate.sourceMessage?.clientNonce?.startsWith(`messaging:${provider}:${address}:`),
    );
    if (!run) throw new Error(`no run from ${provider}`);
    return run;
  }

  /** The run said `text` and ended. */
  async function answered(
    run: { id: string; threadId: string; botId: string },
    text: string,
    status: "completed" | "failed" = "completed",
  ) {
    seq += 1;
    await system.message.create({
      data: {
        threadId: run.threadId,
        seq,
        role: "bot",
        botId: run.botId,
        runId: run.id,
        blocks: [{ kind: "text", text }],
      },
    });
    await system.run.update({ where: { id: run.id }, data: { status } });
    await delivery.deliverRun(run.id);
  }

  /** A run this bot started itself: the failure of work another bot asked it for. */
  async function botMessageRun(bot: Linked, text: string) {
    const owner = {
      spaceId: bot.spaceId,
      userId: bot.userId,
      botId: bot.botId,
      threadId: bot.threadId,
    };
    const task = await system.task.create({
      data: { ...owner, prompt: "asked", status: "failed" },
    });
    const run = await system.run.create({
      data: { ...owner, taskId: task.id, status: "failed", trigger: "bot_message" },
    });
    await answered(run, text, "failed");
  }

  const sentTo = (provider: string, address: string) =>
    sent.filter((message) => message.threadId === dmThread(provider, address)).map((m) => m.body);

  const userMessages = (threadId: string) =>
    system.message.count({ where: { threadId, role: "user" } });

  it("links a second chat app to a bot without unlinking the first", async () => {
    const bot = await linkedBot();
    expect(bot.identityA.botId).toBe(bot.botId);
    expect(bot.identityB.botId).toBe(bot.botId);
    // The confirmation goes to the app that sent the code.
    expect(sentTo(APP_B, bot.b)).toEqual([expect.stringMatching(/^Linked\./)]);
    expect(sentTo(APP_A, bot.a)).toEqual([]);
    const status = await call(bot.actor, "messaging/status");
    expect(
      (status.json as { identities: Array<{ provider: string; botId: string }> }).identities,
    ).toEqual([
      expect.objectContaining({ provider: APP_A, botId: bot.botId }),
      expect.objectContaining({ provider: APP_B, botId: bot.botId }),
    ]);
  });

  it("brings a message from each app into the bot's one chat", async () => {
    const bot = await linkedBot();
    const before = await userMessages(bot.threadId);
    await dm(APP_A, bot.a, "from A");
    expect((await runFrom(bot, APP_A, bot.a)).threadId).toBe(bot.threadId);
    await answered(await runFrom(bot, APP_A, bot.a), "seen A");
    await dm(APP_B, bot.b, "from B");
    expect((await runFrom(bot, APP_B, bot.b)).threadId).toBe(bot.threadId);
    expect(await userMessages(bot.threadId)).toBe(before + 2);
  });

  it("answers each message in the app it came from, and only there", async () => {
    const bot = await linkedBot();
    await dm(APP_A, bot.a, "question on A");
    await answered(await runFrom(bot, APP_A, bot.a), "answer for A");
    await dm(APP_B, bot.b, "question on B");
    await answered(await runFrom(bot, APP_B, bot.b), "answer for B");

    expect(sentTo(APP_A, bot.a)).toEqual(["answer for A"]);
    expect(sentTo(APP_B, bot.b)).toEqual([expect.stringMatching(/^Linked\./), "answer for B"]);
    // One row per reply part, on its own app's lane: nothing went out twice.
    const rows = await system.messagingOutbound.findMany({
      where: { identityId: { in: [bot.identityA.id, bot.identityB.id] }, kind: "dm" },
      select: { identityId: true, body: true },
    });
    expect(rows.filter((row) => row.body.startsWith("answer"))).toEqual(
      expect.arrayContaining([
        { identityId: bot.identityA.id, body: "answer for A" },
        { identityId: bot.identityB.id, body: "answer for B" },
      ]),
    );
    expect(rows.filter((row) => row.body.startsWith("answer"))).toHaveLength(2);
  });

  it("sends the bot's own messages to the app its owner wrote from last", async () => {
    const bot = await linkedBot();
    await dm(APP_A, bot.a, "earlier on A");
    await answered(await runFrom(bot, APP_A, bot.a), "seen A");
    await dm(APP_B, bot.b, "later on B");
    await answered(await runFrom(bot, APP_B, bot.b), "seen B");
    expect((await runAsSystem("pick", () => botChatIdentity(prisma, bot.botId)))?.id).toBe(
      bot.identityB.id,
    );
    await botMessageRun(bot, "update while you were on B");
    expect(sentTo(APP_B, bot.b)).toContain("update while you were on B");
    expect(sentTo(APP_A, bot.a)).not.toContain("update while you were on B");

    await dm(APP_A, bot.a, "back on A");
    await answered(await runFrom(bot, APP_A, bot.a), "seen A again");
    await botMessageRun(bot, "update while you were on A");
    expect(sentTo(APP_A, bot.a)).toContain("update while you were on A");
    expect(sentTo(APP_B, bot.b)).not.toContain("update while you were on A");
    // Each app keeps its own count of messages since the person last wrote there: A's reply
    // and update since "back on A", and B's reply and the update sent while B was the latest.
    const counts = await system.messagingIdentity.findMany({
      where: { id: { in: [bot.identityA.id, bot.identityB.id] } },
      select: { id: true, outboundSinceInbound: true },
    });
    expect(Object.fromEntries(counts.map((row) => [row.id, row.outboundSinceInbound]))).toEqual({
      [bot.identityA.id]: 2,
      [bot.identityB.id]: 2,
    });
  });

  it("unlinks one app and keeps the other working", async () => {
    const bot = await linkedBot();
    await dm(APP_B, bot.b, "asked on B before unlinking");
    const pending = await runFrom(bot, APP_B, bot.b);

    const unlinked = await call(bot.actor, "messaging/identities/unlink", {
      identityId: bot.identityB.id,
    });
    expect(unlinked.status).toBe(200);
    expect(
      await system.messagingIdentity.findMany({
        where: { botId: bot.botId },
        select: { id: true },
      }),
    ).toEqual([{ id: bot.identityA.id }]);

    // The answer to B stays in the app: it does not move to A.
    await answered(pending, "answer for the unlinked app");
    expect(sent.map((message) => message.body)).not.toContain("answer for the unlinked app");
    // B is now a stranger to this server; A still reaches the bot.
    const before = await userMessages(bot.threadId);
    await dm(APP_B, bot.b, "after unlinking");
    expect(await userMessages(bot.threadId)).toBe(before);
    await dm(APP_A, bot.a, "still here");
    expect(await userMessages(bot.threadId)).toBe(before + 1);
  });

  it("moves one app to another bot and leaves the other app on the first", async () => {
    const bot = await linkedBot();
    const other = await runAsSystem("fixture", async () => {
      const created = await prisma.bot.create({
        data: { spaceId: bot.spaceId, userId: bot.userId, name: "Other", color: "test" },
      });
      const thread = await prisma.thread.create({
        data: { spaceId: bot.spaceId, userId: bot.userId, botId: created.id },
      });
      return { botId: created.id, threadId: thread.id };
    });
    const issued = await call(bot.actor, "messaging/link/start", { botId: other.botId });
    await dm(APP_A, bot.a, (issued.json as { code: string }).code);

    const now = await system.messagingIdentity.findMany({
      where: { id: { in: [bot.identityA.id, bot.identityB.id] } },
      select: { id: true, botId: true },
    });
    expect(Object.fromEntries(now.map((row) => [row.id, row.botId]))).toEqual({
      [bot.identityA.id]: other.botId,
      [bot.identityB.id]: bot.botId,
    });
    const [firstBefore, otherBefore] = [
      await userMessages(bot.threadId),
      await userMessages(other.threadId),
    ];
    await dm(APP_A, bot.a, "to the other bot");
    await dm(APP_B, bot.b, "to the first bot");
    expect(await userMessages(other.threadId)).toBe(otherBefore + 1);
    expect(await userMessages(bot.threadId)).toBe(firstBefore + 1);
  });

  it("refuses a second account on the same app for one bot, and keeps the code for another app", async () => {
    const bot = await linkedBot();
    const code = await runAsSystem("fixture", () =>
      issueMessagingLinkCode(prisma, {
        userId: bot.userId,
        spaceId: bot.spaceId,
        botId: bot.botId,
      }),
    );
    const second = `a2-${randomUUID()}`;
    await dm(APP_A, second, code.code);
    expect(
      await system.messagingIdentity.findUnique({
        where: { provider_address: { provider: APP_A, address: second } },
      }),
    ).toBeNull();
    expect(await system.messagingIdentity.count({ where: { botId: bot.botId } })).toBe(2);
    // Nothing was linked, so the code still links an app the bot does not have yet, once.
    const c = `c-${randomUUID()}`;
    await dm("test-c", c, code.code);
    expect(await system.messagingIdentity.count({ where: { botId: bot.botId } })).toBe(3);
    expect(await system.messagingLinkCode.count({ where: { userId: bot.userId } })).toBe(0);
  });

  it("links one app when two send the same code at once", async () => {
    const bot = await linkedBot();
    const code = await runAsSystem("fixture", () =>
      issueMessagingLinkCode(prisma, {
        userId: bot.userId,
        spaceId: bot.spaceId,
        botId: bot.botId,
      }),
    );
    const [c, d] = [`c-${randomUUID()}`, `d-${randomUUID()}`];
    await Promise.all([dm("test-c", c, code.code), dm("test-d", d, code.code)]);
    const linked = await system.messagingIdentity.findMany({
      where: {
        OR: [
          { provider: "test-c", address: c },
          { provider: "test-d", address: d },
        ],
      },
    });
    expect(linked).toHaveLength(1);
    expect(linked[0]!.botId).toBe(bot.botId);
  });

  it("binds an approved chat routine to the app the card named, not another linked app", async () => {
    const bot = await linkedBot();
    const run = {
      spaceId: bot.spaceId,
      userId: bot.userId,
      botId: bot.botId,
      groupId: null,
      threadId: bot.threadId,
      runId: "approval-run",
    };
    const deps = {
      prisma,
      events: createThreadEvents(prisma),
      jobs: jobs as never,
      runSecrets: [],
    };
    const canonical = {
      botId: bot.botId,
      botName: "Assistant",
      threadId: bot.threadId,
      name: `On B ${randomUUID()}`,
      prompt: "Summarize what arrives",
      timezone: "UTC",
      schedule: {},
      on: { chat: APP_B },
    };
    const created = await runAsTenant(bot.actor, () => createChildRoutine(deps, run, canonical));
    expect(created).toMatchObject({ ok: true, on: { chat: APP_B } });
    const routine = await system.routine.findUniqueOrThrow({
      where: { id: (created as { routineId: string }).routineId },
    });
    expect(routine.messageProvider).toBe(APP_B);

    // Once B is unlinked, a replay of the same approval is refused rather than landing on A.
    await call(bot.actor, "messaging/identities/unlink", { identityId: bot.identityB.id });
    await system.routine.update({ where: { id: routine.id }, data: { active: false } });
    const replay = await runAsTenant(bot.actor, () => createChildRoutine(deps, run, canonical));
    expect(replay).toHaveProperty("error");
    expect(
      await system.routine.count({ where: { botId: bot.botId, messageProvider: APP_A } }),
    ).toBe(0);
  });
});
