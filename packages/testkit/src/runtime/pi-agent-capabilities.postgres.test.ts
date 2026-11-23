import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { createApp } from "@rakazo/api/app";
import { deferred } from "@rakazo/core/test-async";
import * as database from "@rakazo/db";
import { createLogger, createTestSink } from "@rakazo/logging";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { discardBotIntroRun } from "../discard-bot-intro.js";
import { sessionCookieHeader } from "../index.js";
import type {
  ModelEmulatorRequest,
  ModelEmulatorResponse,
  ModelEmulatorStep,
} from "../model-emulator.js";
import { startModelEmulator } from "../model-emulator.js";
import { asSystem } from "../system-db.js";

/**
 * Agent capabilities end to end: the real API, executor, Pi runtime and Postgres, with a
 * deterministic model that answers by bot and turn. It checks execution and the rules applied
 * to each tool call, not whether a model would choose these actions.
 */
type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Handles = Awaited<ReturnType<typeof createApp>>;
type Session = { cookie: string; userId: string };

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";
const fixtureKey = "capabilities-fixture-key";
/** Obviously fake. It must reach the destination and nowhere a model, thread or log can see. */
const VAULT_VALUE = "synthetic-vault-value-7f3a";

/** Every request goes to one router, which answers by the bot's role marker and turn. */
function routedSteps(
  route: (request: ModelEmulatorRequest) => ModelEmulatorResponse,
  beforeReply: (request: ModelEmulatorRequest) => void | Promise<void>,
) {
  return Array.from(
    { length: 400 },
    (): ModelEmulatorStep => ({
      expect: beforeReply,
      response: route,
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, cost: 0.00012 },
    }),
  );
}

const text = (content: unknown) =>
  typeof content === "string" ? content : JSON.stringify(content);
const systemText = (request: ModelEmulatorRequest) => text(request.messages[0]?.content);
const offered = (request: ModelEmulatorRequest) =>
  (request.tools ?? []).map((tool) => tool.function.name);
/** The latest person or bot message that started this turn, and the tool results since. */
function turn(request: ModelEmulatorRequest) {
  const index = request.messages.findLastIndex((message) => message.role === "user");
  const results = new Map<string, string>();
  for (const message of request.messages.slice(index + 1)) {
    if (message.role === "tool" && message.tool_call_id)
      results.set(message.tool_call_id, text(message.content));
  }
  return { prompt: text(request.messages[index]?.content), results };
}
/** Tools offered directly, plus the deferred built-ins find_tool's description names. */
const discoverable = (request: ModelEmulatorRequest) => [
  ...offered(request),
  ...text(request.tools?.find((tool) => tool.function.name === "find_tool")?.function)
    .split(/[^a-z_]+/)
    .filter((word) => word.includes("_")),
];
/** A deferred built-in is found, then used, as find_tool and use_tool ask. */
function deferredCall(
  results: Map<string, string>,
  id: string,
  name: string,
  args: Record<string, unknown>,
): ModelEmulatorResponse | undefined {
  if (!results.has(`${id}-find`))
    return { type: "tool", id: `${id}-find`, name: "find_tool", arguments: { names: [name] } };
  if (!results.has(id))
    return { type: "tool", id, name: "use_tool", arguments: { name, arguments: args } };
  return undefined;
}
const isIntro = (request: ModelEmulatorRequest) =>
  offered(request).every((name) => name === "ask_user" || name === "update_bot");

describe.skipIf(!databaseAvailable)("agent capabilities through the Pi runtime", () => {
  let handles: Handles;
  let dataDir: string;
  let model: Awaited<ReturnType<typeof startModelEmulator>>;
  let steps: ModelEmulatorStep[];
  const routes = new Map<string, (request: ModelEmulatorRequest) => ModelEmulatorResponse>();
  const toolResults = new Map<string, string>();
  let beforeReply: ((request: ModelEmulatorRequest) => Promise<void>) | undefined;
  const logs = createTestSink();
  const recorded: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  const recorder = createServer((request, response) => {
    recorded.push({ url: request.url ?? "", headers: request.headers });
    // A careless API that echoes the credential back: the bot must not see it.
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ ok: true, path: request.url, echo: request.headers.authorization ?? null }),
    );
  });
  let recorderOrigin = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => recorder.listen(0, "127.0.0.1", resolve));
    recorderOrigin = `http://127.0.0.1:${(recorder.address() as AddressInfo).port}`;
    steps = routedSteps(
      (request) => {
        if (isIntro(request)) return { type: "text", text: "Ready." };
        const role = /FIXTURE-ROLE:(\w+)/.exec(systemText(request))?.[1];
        const route = role ? routes.get(role) : undefined;
        if (!route) {
          console.error(`No route for ${role}: ${systemText(request).slice(0, 600)}`);
          throw new Error(`No route for ${role ?? "an unmarked bot"}`);
        }
        const { results } = turn(request);
        for (const [id, content] of results) toolResults.set(id, content);
        return route(request);
      },
      (request) => beforeReply?.(request),
    );
    model = await startModelEmulator({ apiKey: fixtureKey, steps });
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-capabilities-"));
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: fixtureOrigin,
      webOrigin: fixtureOrigin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      logger: createLogger({ service: "pi-agent-capabilities", level: "debug", sinks: [logs] }),
      encryptionKey: "capabilities-fixture-encryption-key",
    });
    console.log(`capabilities fixture database: ${new URL(process.env.DATABASE_URL!).pathname}`);
  }, 60_000);

  afterAll(async () => {
    try {
      await handles?.stop();
      // The router had spare steps; every request one served must have passed.
      steps.length = model.requests.length;
      model.assertComplete();
    } finally {
      await model?.close();
      await new Promise<void>((resolve) => recorder.close(() => resolve()));
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    }
  });

  const db = () => asSystem(handles.prisma);

  async function signup(name: string): Promise<Session> {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: fixtureOrigin },
      body: JSON.stringify({
        email: `capabilities-${randomUUID()}@rakazo.test`,
        password: "password12",
        name,
      }),
    });
    expect(response.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(response);
    const session = await handles.app.request("/api/auth/get-session", {
      headers: { cookie, origin: fixtureOrigin },
    });
    return { cookie, userId: ((await session.json()) as { user: { id: string } }).user.id };
  }

  async function connectModel(
    session: Session,
    spaceId?: string,
    connection = { baseUrl: model.baseUrl, apiKey: fixtureKey },
  ) {
    await rpc(
      session.cookie,
      "models/connect",
      {
        provider: model.model.provider,
        modelId: model.model.id,
        ...connection,
        contextWindow: 160_000,
        maxTokens: 4096,
      },
      spaceId,
    );
  }

  async function createBot(session: Session, name: string, role: string, spaceId?: string) {
    const bot = await rpc<{ id: string; spaceId: string; threadId: string }>(
      session.cookie,
      "bots/create",
      {
        name,
        title: "",
        description: "",
        instructions: `FIXTURE-ROLE:${role}. Answer briefly.`,
        notifyOnFinish: false,
      },
      spaceId,
    );
    await discardBotIntroRun(handles, session.cookie, bot.id);
    await rpc(
      session.cookie,
      "bots/update",
      { botId: bot.id, modelProvider: model.model.provider, modelId: model.model.id },
      spaceId,
    );
    const stored = await db().bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { spaceId: true, thread: { select: { id: true } } },
    });
    return { id: bot.id, spaceId: stored.spaceId, threadId: stored.thread!.id };
  }

  async function waitForRuns(where: Record<string, unknown>, count: number, timeout = 30_000) {
    await expect
      .poll(
        async () => {
          const runs = await db().run.findMany({ where, select: { status: true, error: true } });
          const failed = runs.find((run) => run.status === "failed");
          if (failed) {
            // The model fixture keeps the assertion that failed the run; show it.
            try {
              model.assertComplete();
            } catch (error) {
              console.error("model fixture failures:", error);
            }
            throw new Error(`run failed: ${JSON.stringify(failed.error)}`);
          }
          return runs.filter((run) => run.status === "completed").length;
        },
        { timeout, interval: 100 },
      )
      .toBeGreaterThanOrEqual(count);
  }

  async function waitForApproval(runId: string) {
    return vi.waitFor(
      async () => {
        const messages = await db().message.findMany({
          where: { runId, role: "bot" },
          select: { id: true, blocks: true },
        });
        const approval = messages.find((message) =>
          JSON.stringify(message.blocks).includes('"approvalEffectId"'),
        );
        if (!approval) throw new Error("Expected an approval card for the tool call");
        return approval;
      },
      { timeout: 20_000 },
    );
  }

  async function threadText(threadId: string) {
    const messages = await db().message.findMany({
      where: { threadId },
      orderBy: { seq: "asc" },
      select: { role: true, blocks: true, botId: true, authorUserId: true },
    });
    return messages;
  }

  async function rpc<T>(
    cookie: string,
    procedure: string,
    input: unknown = {},
    spaceId?: string,
  ): Promise<T> {
    const response = await (handles.app as App).request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: fixtureOrigin,
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
    const body = (await response.json()) as { json?: T; error?: { message?: string } };
    if (response.status >= 400 || body.error)
      throw new Error(
        `${procedure}: ${body.error?.message ?? response.status} ${JSON.stringify(body).slice(0, 500)}`,
      );
    return body.json as T;
  }

  it("spawns one child with its first prompt and refuses creation with fleet management off", async () => {
    const owner = await signup("Spawn owner");
    await connectModel(owner);
    const alpha = await createBot(owner, "Alpha", "spawner");
    const firstPrompt = "CHILD-TASK: check the fixture inventory.";
    const childReply = "CHILD-RESULT: inventory checked.";
    const count = () => db().bot.count({ where: { spaceId: alpha.spaceId } });
    const before = await count();
    const setFleetManagement = (fleetManagement: boolean) =>
      rpc(owner.cookie, "bots/update", { botId: alpha.id, fleetManagement });
    await setFleetManagement(true);
    const offeredSeen: string[][] = [];
    routes.set("spawner", (request) => {
      const { prompt, results } = turn(request);
      offeredSeen.push(discoverable(request));
      const call = prompt.includes("SPAWN-ONE")
        ? deferredCall(results, "spawn-1", "spawn_bot", {
            name: "Researcher",
            description: "Finds primary sources.",
            instructions: "FIXTURE-ROLE:researcher. Cite sources.",
            prompt: firstPrompt,
          })
        : prompt.includes("SPAWN-TWO")
          ? deferredCall(results, "spawn-2", "spawn_bot", { name: "Second researcher" })
          : prompt.includes("SPAWN-REVOKED")
            ? deferredCall(results, "spawn-revoked", "spawn_bot", { name: "Revoked child" })
            : undefined;
      return call ?? { type: "text", text: "Done." };
    });
    routes.set("researcher", (request) => {
      expect(turn(request).prompt).toContain(firstPrompt);
      return { type: "text", text: childReply };
    });

    const first = await rpc<{ runId: string }>(owner.cookie, "threads/send", {
      botId: alpha.id,
      text: "SPAWN-ONE: create a researcher bot.",
    });
    await waitForRuns({ id: first.runId }, 1);
    expect(offeredSeen[0]).toContain("spawn_bot");
    const spawnedResult = JSON.parse(toolResults.get("spawn-1")!);
    expect(spawnedResult).toMatchObject({ ok: true, name: "Researcher" });
    expect(await count()).toBe(before + 1);
    const child = await db().bot.findUniqueOrThrow({
      where: { id: spawnedResult.botId },
      select: {
        spaceId: true,
        userId: true,
        parentBotId: true,
        description: true,
        instructions: true,
        archivedAt: true,
        thread: { select: { id: true } },
      },
    });
    expect(child).toMatchObject({
      spaceId: alpha.spaceId,
      userId: owner.userId,
      parentBotId: alpha.id,
      description: "Finds primary sources.",
      instructions: "FIXTURE-ROLE:researcher. Cite sources.",
      archivedAt: null,
    });
    expect(child.thread?.id).toBeTruthy();
    await waitForRuns({ botId: spawnedResult.botId, trigger: "spawn" }, 1);
    expect(JSON.stringify(await threadText(child.thread!.id))).toContain(childReply);
    const listed = await rpc<Array<{ id: string }>>(owner.cookie, "bots/list");
    expect(listed.map((bot) => bot.id)).toContain(spawnedResult.botId);
    const alphaThread = JSON.stringify(await threadText(alpha.threadId));
    expect(alphaThread).toContain('"kind":"child_bot"');
    expect(await db().event.count({ where: { botId: alpha.id, type: "bot.spawned" } })).toBe(1);

    await setFleetManagement(false);
    const second = await rpc<{ runId: string }>(owner.cookie, "threads/send", {
      botId: alpha.id,
      text: "SPAWN-TWO: create another one.",
    });
    await waitForRuns({ id: second.runId }, 1);
    expect(offeredSeen.at(-1)).not.toContain("spawn_bot");
    expect(toolResults.get("spawn-2-find")).toBeDefined();
    expect(toolResults.get("spawn-2-find")).not.toContain('"name":"spawn_bot"');
    expect(toolResults.get("spawn-2")).toContain("spawn_bot is not available");
    expect(await count()).toBe(before + 1);

    await setFleetManagement(true);
    beforeReply = async (request) => {
      const { prompt, results } = turn(request);
      if (!prompt.includes("SPAWN-REVOKED") || !results.has("spawn-revoked-find")) return;
      expect(discoverable(request)).toContain("spawn_bot");
      expect(results.get("spawn-revoked-find")).toContain("spawn_bot");
      beforeReply = undefined;
      await setFleetManagement(false);
    };
    onTestFinished(() => {
      beforeReply = undefined;
    });
    const revoked = await rpc<{ runId: string }>(owner.cookie, "threads/send", {
      botId: alpha.id,
      text: "SPAWN-REVOKED: create another one.",
    });
    await waitForRuns({ id: revoked.runId }, 1);
    expect(toolResults.get("spawn-revoked")).toContain("spawn_bot is turned off for this bot.");
    expect(await count()).toBe(before + 1);
  }, 90_000);

  it("refuses bot creation when permission is revoked during the approval gate", async () => {
    const owner = await signup("Bot creation owner");
    await connectModel(owner);
    await rpc(owner.cookie, "autoReview/set", { mode: "never" });
    const bot = await createBot(owner, "Bot creator", "gatedspawn");
    const callId = "spawn-during-gate";
    routes.set(
      "gatedspawn",
      (request) =>
        deferredCall(turn(request).results, callId, "spawn_bot", { name: "Revoked child" }) ?? {
          type: "text",
          text: "Done.",
        },
    );

    const resumeGate = deferred();
    const readPreference = database.findAutoReviewPreference;
    const preference = vi
      .spyOn(database, "findAutoReviewPreference")
      .mockImplementation(async (...args) => {
        if (args[1].userId === owner.userId) await resumeGate.promise;
        return readPreference(...args);
      });
    let runId: string;
    try {
      ({ runId } = await rpc<{ runId: string }>(owner.cookie, "threads/send", {
        botId: bot.id,
        text: "Create the fixture child.",
      }));
      await vi.waitFor(
        () =>
          expect(preference).toHaveBeenCalledWith(expect.anything(), {
            userId: owner.userId,
            spaceId: bot.spaceId,
          }),
        { timeout: 20_000 },
      );
      await rpc(owner.cookie, "bots/update", { botId: bot.id, fleetManagement: false });
    } finally {
      resumeGate.resolve();
      preference.mockRestore();
    }
    await waitForRuns({ id: runId }, 1);
    expect(await db().bot.count({ where: { parentBotId: bot.id } })).toBe(0);
    expect(toolResults.get(callId)).toContain("spawn_bot is turned off for this bot.");
  }, 90_000);

  it.each([true, false])(
    "honors fleet management (%s) on a bot_message run",
    async (enabled) => {
      const owner = await signup("Message spawn owner");
      await connectModel(owner);
      await rpc(owner.cookie, "autoReview/set", { mode: "never" });
      const sender = await createBot(owner, "Spawn requester", "spawnrequester");
      const target = await createBot(owner, "Spawn receiver", "spawnreceiver");
      await rpc(owner.cookie, "bots/update", { botId: target.id, fleetManagement: enabled });
      const id = `message-spawn-${enabled}`;
      routes.set("spawnrequester", (request) =>
        turn(request).results.has(`${id}-message`)
          ? { type: "text", text: "Sent." }
          : {
              type: "tool",
              id: `${id}-message`,
              name: "message_bot",
              arguments: { bot_id: target.id, message: "Create a fixture child.", intent: "fyi" },
            },
      );
      routes.set("spawnreceiver", (request) => {
        expect(discoverable(request).includes("spawn_bot")).toBe(enabled);
        return (
          deferredCall(turn(request).results, id, "spawn_bot", { name: "Message child" }) ?? {
            type: "text",
            text: "Done.",
          }
        );
      });
      const count = () => db().bot.count({ where: { spaceId: target.spaceId } });
      const before = await count();
      const sent = await rpc<{ runId: string }>(owner.cookie, "threads/send", {
        botId: sender.id,
        text: "Ask the other bot to create a child.",
      });
      await waitForRuns({ id: sent.runId }, 1);
      await waitForRuns({ botId: target.id, trigger: "bot_message" }, 1);
      expect(await count()).toBe(before + Number(enabled));
      expect(toolResults.get(id)).toContain(enabled ? '"ok":true' : "spawn_bot is not available");
    },
    90_000,
  );

  it("message_bot delivers into the other bot's chat, returns its reply, stops at the hop limit and cannot reach another Space", async () => {
    vi.stubEnv("BOT_MESSAGE_MAX_HOPS", "1");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const owner = await signup("Messaging owner");
    const stranger = await signup("Stranger");
    await connectModel(owner);
    await connectModel(stranger);
    const alpha = await createBot(owner, "Alpha", "sender");
    const beta = await createBot(owner, "Beta", "receiver");
    const otherSpace = await rpc<{ id: string }>(owner.cookie, "spaces/create", {
      name: "Elsewhere",
    }).catch(async (error: unknown) => {
      // Creating a Space can require a verified address; this fixture account has none.
      await db().user.update({ where: { id: owner.userId }, data: { emailVerified: true } });
      if (!(error instanceof Error)) throw error;
      return rpc<{ id: string }>(owner.cookie, "spaces/create", { name: "Elsewhere" });
    });
    await connectModel(owner, otherSpace.id);
    const gamma = await createBot(owner, "Gamma", "outsider", otherSpace.id);
    const delta = await createBot(stranger, "Delta", "outsider");
    expect(gamma.spaceId).not.toBe(alpha.spaceId);
    expect(delta.spaceId).not.toBe(alpha.spaceId);
    const outsiderMessages = async () =>
      db().message.count({ where: { threadId: { in: [gamma.threadId, delta.threadId] } } });
    const outsiderBefore = await outsiderMessages();
    routes.set("outsider", () => ({ type: "text", text: "Outsider should never run." }));

    let betaSawBrief = "";
    routes.set("sender", (request) => {
      const { prompt, results } = turn(request);
      if (prompt.includes("BETA-RESULT")) return { type: "text", text: "ALPHA-GOT-RESULT" };
      if (!results.has("to-gamma"))
        return {
          type: "tool",
          id: "to-gamma",
          name: "message_bot",
          arguments: { bot_id: gamma.id, message: "Hello from another Space." },
        };
      if (!results.has("to-delta"))
        return {
          type: "tool",
          id: "to-delta",
          name: "message_bot",
          arguments: { bot_id: delta.id, message: "Hello from another owner." },
        };
      if (!results.has("to-beta"))
        return {
          type: "tool",
          id: "to-beta",
          name: "message_bot",
          arguments: {
            bot_id: beta.id,
            message: "BRIEF-7: summarise the plan.",
            intent: "request",
          },
        };
      return { type: "text", text: "Briefed Beta." };
    });
    routes.set("receiver", (request) => {
      const { prompt, results } = turn(request);
      betaSawBrief ||= prompt.includes("BRIEF-7") ? prompt : "";
      if (!results.has("beta-back"))
        return {
          type: "tool",
          id: "beta-back",
          name: "message_bot",
          arguments: { bot_id: alpha.id, message: "A new request back.", intent: "request" },
        };
      return { type: "text", text: "BETA-RESULT: the plan has two steps." };
    });

    await rpc(owner.cookie, "threads/send", {
      botId: alpha.id,
      text: "Ask Beta to summarise the plan.",
    });
    // Alpha's turn, Beta's turn, and Alpha's turn woken by Beta's returned result.
    await waitForRuns({ botId: beta.id }, 1);
    await waitForRuns({ botId: alpha.id, trigger: { not: "created" } }, 2);

    expect(toolResults.get("to-gamma")).toMatch(/no bot found/);
    expect(toolResults.get("to-delta")).toMatch(/no bot found/);
    expect(toolResults.get("to-gamma")).not.toContain(gamma.id);
    expect(JSON.parse(toolResults.get("to-beta")!)).toMatchObject({ ok: true, botId: beta.id });
    expect(betaSawBrief).toContain("BRIEF-7");
    expect(toolResults.get("beta-back")).toMatch(/limit reached/);
    const betaThread = JSON.stringify(await threadText(beta.threadId));
    expect(betaThread).toContain("BRIEF-7");
    const alphaThread = JSON.stringify(await threadText(alpha.threadId));
    expect(alphaThread).toContain('"kind":"bot_message_sent"');
    expect(alphaThread).toContain("BETA-RESULT");
    expect(alphaThread).toContain("ALPHA-GOT-RESULT");
    expect(await outsiderMessages()).toBe(outsiderBefore);
    console.log(`message_bot to another Space: ${toolResults.get("to-gamma")}`);
    console.log(`message_bot past the hop limit: ${toolResults.get("beta-back")}`);
  }, 120_000);

  it("a message to another member's bot uses the initiating member's account, model and approvals", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const owner = await signup("Sender owner");
    const member = await signup("Recipient owner");
    const alternateKey = "recipient-model-fixture-key";
    const alternateSteps = Array.from(
      { length: 20 },
      (): ModelEmulatorStep => ({
        expect: (request) => expect(isIntro(request)).toBe(true),
        response: { type: "text", text: "Ready." },
      }),
    );
    const alternate = await startModelEmulator({ apiKey: alternateKey, steps: alternateSteps });
    const recordedBefore = recorded.length;
    onTestFinished(async () => {
      recorded.splice(recordedBefore);
      vi.unstubAllEnvs();
      await alternate.close();
    });
    await db().user.update({ where: { id: owner.userId }, data: { emailVerified: true } });
    const space = await rpc<{ id: string }>(owner.cookie, "spaces/create", {
      name: "Messaging desk",
    });
    const invite = await rpc<{ url: string }>(owner.cookie, "spaces/invites/create", {
      spaceId: space.id,
    });
    expect(
      await rpc(member.cookie, "spaces/invites/accept", {
        token: new URL(invite.url).pathname.split("/").at(-1),
      }),
    ).toEqual({ spaceId: space.id });
    await connectModel(owner, space.id);
    await connectModel(member, space.id, { baseUrl: alternate.baseUrl, apiKey: alternateKey });
    const alpha = await createBot(owner, "Shared Alpha", "sharedsender", space.id);
    const beta = await createBot(member, "Shared Beta", "sharedreceiver", space.id);
    expect(
      await db().bot.findMany({
        where: { spaceId: space.id, id: { in: [alpha.id, beta.id] } },
        select: { id: true, userId: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        { id: alpha.id, userId: owner.userId },
        { id: beta.id, userId: member.userId },
      ]),
    );
    await rpc(owner.cookie, "autoReview/set", { mode: "ask" }, space.id);
    await rpc(member.cookie, "autoReview/set", { mode: "never" }, space.id);
    const destination = {
      name: "shared_fixture_api",
      origin: recorderOrigin,
      auth: { type: "bearer" },
    };
    const senderValue = "synthetic-shared-sender-value";
    const recipientValue = "synthetic-shared-recipient-value";
    await rpc(owner.cookie, "vault/put", { destination, value: senderValue }, space.id);
    await rpc(member.cookie, "vault/put", { destination, value: recipientValue }, space.id);
    const task = "SHARED-BOT-TASK: call the fixture endpoint.";
    const reply = "SHARED-BOT-REPLY: fixture endpoint checked.";
    routes.set("sharedsender", (request) => {
      const { prompt, results } = turn(request);
      if (!prompt.includes("Ask Beta for help.") || results.has("shared-delivery"))
        return { type: "text", text: "Done." };
      return {
        type: "tool",
        id: "shared-delivery",
        name: "message_bot",
        arguments: { bot_id: beta.id, message: task, intent: "request" },
      };
    });
    routes.set("sharedreceiver", (request) => {
      const { prompt, results } = turn(request);
      expect(prompt).toContain(task);
      return (
        deferredCall(results, "shared-vault", "secret_request", {
          name: destination.name,
          url: `${recorderOrigin}/shared-whoami`,
          method: "GET",
        }) ?? { type: "text", text: reply }
      );
    });

    await rpc(
      owner.cookie,
      "threads/send",
      { botId: alpha.id, text: "Ask Beta for help." },
      space.id,
    );
    const where = { spaceId: space.id, botId: beta.id, trigger: "bot_message" };
    const recipient = await vi.waitFor(
      () => db().run.findFirstOrThrow({ where, include: { task: true } }),
      { timeout: 20_000 },
    );
    expect(recipient).toMatchObject({
      userId: owner.userId,
      threadId: beta.threadId,
      task: { userId: owner.userId },
    });
    const card = await waitForApproval(recipient.id);
    const calls = () => recorded.filter(({ url }) => url === "/shared-whoami");
    expect(calls()).toEqual([]);
    const answer = { botId: beta.id, runId: recipient.id, messageId: card.id, answer: "allow" };
    await expect(rpc(member.cookie, "threads/answer", answer, space.id)).rejects.toThrow(
      /no longer awaiting an answer/,
    );
    expect(await db().run.findUniqueOrThrow({ where: { id: recipient.id } })).toMatchObject({
      status: "waiting_input",
    });
    expect(calls()).toEqual([]);
    expect(await rpc(owner.cookie, "threads/answer", answer, space.id)).toEqual({ ok: true });
    await waitForRuns({ id: recipient.id }, 1);

    const recipientRequests = model.requests.filter((request) =>
      systemText(request).includes("FIXTURE-ROLE:sharedreceiver"),
    );
    expect(recipientRequests.length).toBeGreaterThan(0);
    expect(JSON.stringify(recipientRequests)).not.toContain(recipientValue);
    expect(alternate.requests.every(isIntro)).toBe(true);
    alternateSteps.length = alternate.requests.length;
    alternate.assertComplete();
    const usage = await db().usageRecord.findMany({
      where: { spaceId: space.id, parentRunId: recipient.id },
    });
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((row) => row.userId === owner.userId && row.botId === beta.id)).toBe(true);
    expect(usage.some((row) => (row.costUsd ?? 0) > 0)).toBe(true);
    expect(calls()).toEqual([
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${senderValue}` }),
      }),
    ]);
    expect(JSON.parse(toolResults.get("shared-vault") ?? "null")).toMatchObject({
      status: 200,
      body: { ok: true, echo: "[redacted]" },
    });
    await vi.waitFor(async () =>
      expect(await threadText(alpha.threadId)).toContainEqual(
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              kind: "bot_message_received",
              fromBotId: beta.id,
              intent: "result",
              text: reply,
            }),
          ]),
        }),
      ),
    );
    expect(await db().run.count({ where: { ...where, userId: member.userId } })).toBe(0);
  }, 120_000);

  it("stops a bot-to-bot chain after six deliveries with the default hop limit", async () => {
    vi.stubEnv("BOT_MESSAGE_MAX_HOPS", undefined);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const owner = await signup("Chain owner");
    await connectModel(owner);
    const alpha = await createBot(owner, "Chain Alpha", "chainalpha");
    const beta = await createBot(owner, "Chain Beta", "chainbeta");
    for (const [role, target] of [
      ["chainalpha", beta.id],
      ["chainbeta", alpha.id],
    ] as const) {
      routes.set(role, (request) => {
        const { prompt, results } = turn(request);
        const hop = Number(/CHAIN-HOP-(\d+)/.exec(prompt)?.[1]);
        expect(hop).toBeGreaterThanOrEqual(0);
        const id = `chain-send-${hop + 1}`;
        if (results.has(id)) return { type: "text", text: `CHAIN-FINISHED-${hop}` };
        return {
          type: "tool",
          id,
          name: "message_bot",
          arguments: { bot_id: target, message: `CHAIN-HOP-${hop + 1}`, intent: "fyi" },
        };
      });
    }
    await rpc(owner.cookie, "threads/send", { botId: alpha.id, text: "CHAIN-HOP-0" });
    const where = { botId: { in: [alpha.id, beta.id] }, trigger: { not: "created" } };
    await waitForRuns(where, 7);
    for (let hop = 1; hop <= 6; hop++) {
      expect(JSON.parse(toolResults.get(`chain-send-${hop}`) ?? "null")).toMatchObject({
        ok: true,
        botId: hop % 2 === 0 ? alpha.id : beta.id,
      });
      const thread = await threadText(hop % 2 === 0 ? alpha.threadId : beta.threadId);
      expect(thread).toContainEqual(
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              kind: "bot_message_received",
              hop,
              text: `CHAIN-HOP-${hop}`,
            }),
          ]),
        }),
      );
    }
    expect(toolResults.get("chain-send-7")).toMatch(/limit reached/);
    expect(await db().run.count({ where })).toBe(7);
    expect(JSON.stringify(await threadText(beta.threadId))).not.toContain("CHAIN-HOP-7");
  }, 120_000);

  it("runs spawn_bot's first prompt as the requesting member and replies in the new bot's chat", async () => {
    const owner = await signup("Prompt parent owner");
    const member = await signup("Prompt requesting member");
    await db().user.update({ where: { id: owner.userId }, data: { emailVerified: true } });
    const space = await rpc<{ id: string }>(owner.cookie, "spaces/create", { name: "Prompt desk" });
    const invite = await rpc<{ url: string }>(owner.cookie, "spaces/invites/create", {
      spaceId: space.id,
    });
    await rpc(member.cookie, "spaces/invites/accept", {
      token: new URL(invite.url).pathname.split("/").at(-1),
    });
    await connectModel(owner, space.id);
    await connectModel(member, space.id);
    const parent = await createBot(owner, "Prompt parent", "promptparent", space.id);
    const peer = await createBot(owner, "Prompt peer", "promptpeer", space.id);
    const group = await rpc<{ id: string; threadId: string }>(
      owner.cookie,
      "groups/create",
      { name: "Prompt group", botIds: [parent.id, peer.id] },
      space.id,
    );
    const first = "FIRST-PROMPT: check the fixture inventory.";
    const reply = "FIRST-RESULT: inventory checked.";
    routes.set(
      "promptparent",
      (request) =>
        deferredCall(turn(request).results, "spawn-with-prompt", "spawn_bot", {
          name: "Prompt child",
          instructions: "FIXTURE-ROLE:promptchild. Answer briefly.",
          prompt: first,
        }) ?? { type: "text", text: "PARENT-DONE" },
    );
    routes.set("promptchild", (request) => {
      expect(turn(request).prompt).toContain(first);
      return { type: "text", text: reply };
    });
    await rpc(
      member.cookie,
      "threads/send",
      {
        groupId: group.id,
        text: "@Prompt parent Create a bot and give it the inventory task.",
        mentions: [{ kind: "bot", id: parent.id }],
      },
      space.id,
    );
    await waitForRuns({ threadId: group.threadId }, 1);
    const spawned = JSON.parse(toolResults.get("spawn-with-prompt") ?? "null");
    expect(spawned).toMatchObject({ ok: true, name: "Prompt child", threadId: expect.any(String) });
    const where = { spaceId: space.id, botId: spawned.botId, trigger: "spawn" };
    expect(await db().bot.count({ where: { spaceId: space.id, parentBotId: parent.id } })).toBe(1);
    await waitForRuns(where, 1);
    expect(await db().run.findMany({ where, include: { task: true, bot: true } })).toEqual([
      expect.objectContaining({
        spaceId: space.id,
        userId: member.userId,
        threadId: spawned.threadId,
        task: expect.objectContaining({ userId: member.userId, prompt: first }),
        bot: expect.objectContaining({ userId: member.userId, parentBotId: parent.id }),
      }),
    ]);
    const thread = await rpc(member.cookie, "threads/get", { botId: spawned.botId }, space.id);
    expect(JSON.stringify(thread)).toContain(first);
    expect(JSON.stringify(thread)).toContain(reply);
    expect(JSON.stringify(await threadText(group.threadId))).not.toContain(reply);
  }, 120_000);

  it.each([
    { scenario: "allowed", revoked: false, alwaysAllow: false },
    { scenario: "revoked", revoked: true, alwaysAllow: false },
    { scenario: "Always allow", revoked: false, alwaysAllow: true },
  ])(
    "holds webhook bot creation for approval ($scenario)",
    async ({ revoked, alwaysAllow }) => {
      const owner = await signup("Webhook owner");
      await connectModel(owner);
      await rpc(owner.cookie, "autoReview/set", { mode: "ask" });
      const bot = await createBot(owner, "Webhook bot", "webhookfleet");
      await rpc(owner.cookie, "routines/create", {
        botId: bot.id,
        name: "Event intake",
        prompt: "Process the fixture event.",
        webhookEnabled: true,
        active: true,
      });
      const webhook = await rpc<{ path: string; secret: string }>(
        owner.cookie,
        "bots/rotateWebhookSecret",
        { botId: bot.id },
      );
      const childName = "Webhook child";
      const callId = revoked
        ? "webhook-spawn-revoked"
        : alwaysAllow
          ? "webhook-spawn-with-rule"
          : "webhook-spawn";
      const canary = "WEBHOOK-FLEET-CANARY";
      let permissionRevoked = false;
      const webhookRoute = (request: ModelEmulatorRequest): ModelEmulatorResponse => {
        const { prompt, results } = turn(request);
        expect(prompt).toContain(canary);
        if (permissionRevoked) expect(discoverable(request)).not.toContain("spawn_bot");
        return (
          deferredCall(results, callId, "spawn_bot", { name: childName }) ?? {
            type: "text",
            text: "WEBHOOK-DONE",
          }
        );
      };
      routes.set("webhookfleet", webhookRoute);
      if (alwaysAllow) {
        await rpc(owner.cookie, "approvalRules/set", {
          effect: "always_allow",
          matchKind: "tool",
          matchValue: "spawn_bot",
        });
        const ownerCall = "owner-spawn-with-rule";
        routes.set(
          "webhookfleet",
          (request) =>
            deferredCall(turn(request).results, ownerCall, "spawn_bot", {
              name: "Owner child",
            }) ?? {
              type: "text",
              text: "Done.",
            },
        );
        const started = await rpc<{ runId: string }>(owner.cookie, "threads/send", {
          botId: bot.id,
          text: "Create a child bot.",
        });
        await waitForRuns({ id: started.runId }, 1);
        expect(JSON.parse(toolResults.get(ownerCall) ?? "null")).toMatchObject({ ok: true });
        expect(
          (
            await db().message.findMany({
              where: { runId: started.runId },
              select: { blocks: true },
            })
          ).some(({ blocks }) => JSON.stringify(blocks).includes('"approvalEffectId"')),
        ).toBe(false);
        routes.set("webhookfleet", webhookRoute);
      }
      const response = await handles.app.request(webhook.path, {
        method: "POST",
        headers: { authorization: `Bearer ${webhook.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ event: canary }),
      });
      expect(response.status).toBe(200);
      const delivery = (await response.json()) as { runId: string };
      expect(delivery.runId).toEqual(expect.any(String));
      const runId = delivery.runId;
      const children = () => db().bot.findMany({ where: { parentBotId: bot.id, name: childName } });
      const approval = await waitForApproval(runId);
      expect(await db().run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        trigger: "webhook",
        userId: owner.userId,
        status: "waiting_input",
      });
      expect(await children()).toEqual([]);
      if (revoked) {
        await rpc(owner.cookie, "bots/update", { botId: bot.id, fleetManagement: false });
        permissionRevoked = true;
      }
      await rpc(owner.cookie, "threads/answer", {
        botId: bot.id,
        runId,
        messageId: approval.id,
        answer: "allow",
      });
      await vi.waitFor(
        async () => {
          const run = await db().run.findUniqueOrThrow({ where: { id: runId } });
          expect(["completed", "failed"]).toContain(run.status);
        },
        { timeout: 20_000 },
      );
      expect(await db().run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: "completed",
        error: null,
      });
      if (revoked) {
        expect(await db().bot.count({ where: { parentBotId: bot.id } })).toBe(0);
        const reason = "spawn_bot is turned off for this bot.";
        expect(
          await db().externalEffect.findMany({
            where: { runId, kind: "spawn_bot" },
            select: { status: true, result: true },
          }),
        ).toEqual([{ status: "completed", result: { error: reason } }]);
        expect(await db().externalEffect.count({ where: { runId, status: "approved" } })).toBe(0);
        expect(await threadText(bot.threadId)).toContainEqual(
          expect.objectContaining({
            role: "bot",
            blocks: expect.arrayContaining([{ kind: "text", text: reason }]),
          }),
        );
        return;
      }
      expect(await children()).toEqual([
        expect.objectContaining({ name: childName, userId: owner.userId, spaceId: bot.spaceId }),
      ]);
      expect(JSON.parse(toolResults.get(callId) ?? "null")).toMatchObject({ ok: true });
    },
    90_000,
  );

  it("a shared group delivers each member's message to the mentioned bot and keeps who said what", async () => {
    const owner = await signup("Group owner");
    const member = await signup("Group member");
    const outsider = await signup("Group outsider");
    await db().user.update({ where: { id: owner.userId }, data: { emailVerified: true } });
    const space = await rpc<{ id: string }>(owner.cookie, "spaces/create", { name: "Shared desk" });
    const invite = await rpc<{ url: string }>(owner.cookie, "spaces/invites/create", {
      spaceId: space.id,
    });
    const token = new URL(invite.url).pathname.split("/").at(-1)!;
    expect(await rpc(member.cookie, "spaces/invites/accept", { token })).toEqual({
      spaceId: space.id,
    });
    await connectModel(owner, space.id);
    // A run uses the sending member's own model connection, so the member connects one too.
    await connectModel(member, space.id);
    const anya = await createBot(owner, "Anya", "anya", space.id);
    const boris = await createBot(owner, "Boris", "boris", space.id);
    expect([anya.spaceId, boris.spaceId]).toEqual([space.id, space.id]);
    const group = await rpc<{ id: string; threadId: string }>(
      owner.cookie,
      "groups/create",
      { name: "Desk", botIds: [anya.id, boris.id] },
      space.id,
    );
    let borisSpawn = "";
    routes.set("anya", () => ({ type: "text", text: "ANYA-REPLY" }));
    routes.set("boris", (request) => {
      const { prompt, results } = turn(request);
      if (prompt.includes("MEMBER-ASKS")) {
        borisSpawn ||= discoverable(request).includes("spawn_bot") ? "offered" : "not offered";
        const call = deferredCall(results, "member-spawn", "spawn_bot", {
          name: "Member made bot",
        });
        if (call) return call;
      }
      return { type: "text", text: "BORIS-REPLY" };
    });
    await rpc(
      owner.cookie,
      "threads/send",
      {
        groupId: group.id,
        text: "@Anya OWNER-ASKS hello",
        mentions: [{ kind: "bot", id: anya.id }],
      },
      space.id,
    );
    await waitForRuns({ threadId: group.threadId }, 1);
    await rpc(
      member.cookie,
      "threads/send",
      {
        groupId: group.id,
        text: "@Boris MEMBER-ASKS make a bot",
        mentions: [{ kind: "bot", id: boris.id }],
      },
      space.id,
    );
    await waitForRuns({ threadId: group.threadId }, 2);
    const messages = await threadText(group.threadId);
    const find = (needle: string) =>
      messages.find((message) => JSON.stringify(message.blocks).includes(needle));
    expect(find("OWNER-ASKS")).toMatchObject({ role: "user", authorUserId: owner.userId });
    expect(find("MEMBER-ASKS")).toMatchObject({ role: "user", authorUserId: member.userId });
    expect(find("ANYA-REPLY")).toMatchObject({ role: "bot", botId: anya.id });
    expect(find("BORIS-REPLY")).toMatchObject({ role: "bot", botId: boris.id });
    // The member reads the same conversation; someone outside the Space reads nothing.
    const seen = await rpc<{ messages: unknown[] }>(
      member.cookie,
      "threads/get",
      { groupId: group.id },
      space.id,
    );
    expect(JSON.stringify(seen.messages)).toContain("ANYA-REPLY");
    await expect(
      rpc(outsider.cookie, "threads/get", { groupId: group.id }, space.id),
    ).rejects.toThrow();
    // A turn another member started creates a bot as that member, never as the bot's owner,
    // and only where the member could create one themselves.
    expect(borisSpawn).toBe("offered");
    expect(JSON.parse(toolResults.get("member-spawn") ?? "null")).toMatchObject({ ok: true });
    expect(
      await db().bot.findMany({
        where: { spaceId: space.id, parentBotId: boris.id },
        select: { name: true, userId: true },
      }),
    ).toEqual([{ name: "Member made bot", userId: member.userId }]);
    await createBot(member, "Member direct bot", "memberdirect", space.id);
  }, 120_000);

  it("a vault credential reaches its site and no model message, tool record, thread or event", async () => {
    // The operator's opt-in is needed only for this loopback HTTP API credential.
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const owner = await signup("Vault owner");
    await connectModel(owner);
    const bot = await createBot(owner, "Vaulted", "vault");
    const destination = {
      name: "fixture_api",
      origin: recorderOrigin,
      auth: { type: "bearer" as const },
    };
    await rpc(owner.cookie, "vault/put", { destination, value: VAULT_VALUE });
    routes.set("vault", (request) => {
      const { results } = turn(request);
      return (
        deferredCall(results, "vault-call", "secret_request", {
          name: "fixture_api",
          url: `${recorderOrigin}/whoami`,
          method: "GET",
        }) ?? { type: "text", text: "VAULT-DONE" }
      );
    });
    const sent = await rpc<{ runId: string }>(owner.cookie, "threads/send", {
      botId: bot.id,
      text: "VAULT-CANARY call the fixture API.",
    });
    // The owner approves the authenticated request on its card.
    const approval = await waitForApproval(sent.runId);
    expect(recorded).toHaveLength(0);
    await rpc(owner.cookie, "threads/answer", {
      botId: bot.id,
      runId: sent.runId,
      messageId: approval.id,
      answer: "allow",
    });
    await waitForRuns({ id: sent.runId }, 1);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      url: "/whoami",
      headers: expect.objectContaining({ authorization: `Bearer ${VAULT_VALUE}` }),
    });
    const result = toolResults.get("vault-call")!;
    expect(result).toContain('"ok":true');
    expect(result).not.toContain(VAULT_VALUE);
    // Everything the model was sent in this whole file, every stored row this bot touched,
    // decrypted through the app, and the thread as the owner reads it.
    expect(JSON.stringify(model.requests)).not.toContain(VAULT_VALUE);
    expect(JSON.stringify(model.requests)).toContain("VAULT-CANARY");
    const rows = JSON.stringify(
      await Promise.all([
        db().message.findMany({
          where: { threadId: bot.threadId },
          select: { blocks: true, toolHistory: true },
        }),
        db().event.findMany({ where: { botId: bot.id } }),
        db().run.findMany({ where: { botId: bot.id } }),
        db().externalEffect.findMany({ where: { runId: sent.runId } }),
      ]),
    );
    expect(rows).toContain("VAULT-CANARY");
    expect(rows).not.toContain(VAULT_VALUE);
    // The stored tool history is read back decrypted, and holds the call with the echo redacted.
    expect(rows).toContain("secret_request");
    expect(rows).toContain("[redacted]");
    expect(logs.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs.events)).not.toContain(VAULT_VALUE);
    const thread = await rpc<{ messages: unknown[] }>(owner.cookie, "threads/get", {
      botId: bot.id,
    });
    expect(JSON.stringify(thread)).toContain("VAULT-DONE");
    expect(JSON.stringify(thread)).not.toContain(VAULT_VALUE);
    console.log(`vault tool result as the model saw it: ${result}`);
  }, 90_000);
});
