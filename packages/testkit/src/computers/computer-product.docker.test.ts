import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import type { createApp } from "@rakazo/api/app";
import { isTerminal } from "@rakazo/core";
import { createLogger, createTestSink } from "@rakazo/logging";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { discardBotIntroRun } from "../discard-bot-intro.js";
import { sessionCookieHeader } from "../index.js";
import type {
  ModelEmulatorRequest,
  ModelEmulatorResponse,
  ModelEmulatorStep,
} from "../model-emulator.js";
import { startModelEmulator } from "../model-emulator.js";
import { asSystem } from "../system-db.js";
import { computerProductConfig } from "./computer-product.test-support.js";
import {
  installLoginFixture,
  LOGIN_ORIGIN,
  runFixtureCommand,
} from "./computer-product-login.test-support.js";
import { EXPORT_FIXTURE_URL, installContactsFixture } from "./computer-replay-fixture.js";

/**
 * Product path with disposable Postgres, a deterministic Pi model and a real Docker computer.
 * With the local image built by pnpm sandbox:build, run from the repository root:
 * pnpm exec tsx packages/testkit/src/cli/harness.ts --integration --sandbox=docker --spec=computer-product
 */
const enabled =
  process.env.RUN_COMPUTER_PRODUCT_DOCKER === "1" &&
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";
const fixtureKey = "computer-product-fixture-key";
const TYPING_URL = "http://127.0.0.1:8766/";
const TYPED = "hello-superbot";
const TYPING_BACKGROUND = [37, 149, 213] as const;
const LOGIN_VALUE = "synthetic-fixture-password-32cc";
const COMMAND_VALUE = "synthetic-fixture-command-81be";

type Handles = Awaited<ReturnType<typeof createApp>>;
type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Fixture = {
  botId: string;
  threadId: string;
  cookie: string;
  computer: ComputerRef;
  context: AdapterContext;
};

const toolResult = (request: ModelEmulatorRequest, id: string) =>
  request.messages.findLast((message) => message.tool_call_id === id)?.content;
const tool = (id: string, name: string, args: Record<string, unknown>): ModelEmulatorResponse => ({
  type: "tool",
  id,
  name,
  arguments: args,
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function refFor(result: unknown, name: string) {
  const tree = (JSON.parse(String(result)) as { tree?: string }).tree ?? "";
  const line = tree.split("\n").find((entry) => entry.includes(`"${name}"`));
  const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`No browser ref for ${name}: ${tree}`);
  return ref;
}

describe.skipIf(!enabled)("a bot's Docker computer through the product run path", () => {
  let dataDir: string;
  let supervisor: Server;
  let handles: Handles;
  let model: Awaited<ReturnType<typeof startModelEmulator>>;
  let cleanup: { computer: ComputerRef; context: Omit<AdapterContext, "signal"> } | undefined;
  const logs = createTestSink();
  const steps: ModelEmulatorStep[] = [];
  let route: (request: ModelEmulatorRequest) => ModelEmulatorResponse;
  const db = () => asSystem(handles.prisma);

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-computer-product-"));
    // Supervisor settings are read when it is first imported.
    for (const [name, value] of Object.entries({
      DATA_DIR: dataDir,
      SANDBOX_SUPERVISOR_TOKEN: "computer-product-fixture-token-32chars",
      SANDBOX_SCREEN_NETWORK: "published",
      SANDBOX_SCREEN_HOST: "127.0.0.1",
      SANDBOX_CONTROL_VIA_LOOPBACK: "true",
      RAKAZO_COMPUTER_IMAGE: process.env.RAKAZO_COMPUTER_IMAGE || "rakazo/computer:local",
    }))
      vi.stubEnv(name, value);
    const { supervisorApp } = await import("@rakazo/sandbox-supervisor");
    supervisor = serve({ fetch: supervisorApp.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
    await new Promise<void>((resolve) =>
      supervisor.listening ? resolve() : supervisor.once("listening", resolve),
    );
    vi.stubEnv(
      "SANDBOX_SUPERVISOR_URL",
      `http://127.0.0.1:${(supervisor.address() as AddressInfo).port}`,
    );

    steps.push(
      ...Array.from(
        { length: 100 },
        (): ModelEmulatorStep => ({
          expect() {},
          response: (request) =>
            request.tools?.every(
              ({ function: { name } }) => name === "ask_user" || name === "update_bot",
            )
              ? { type: "text", text: "Ready." }
              : route(request),
        }),
      ),
    );
    model = await startModelEmulator({ apiKey: fixtureKey, steps });
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: fixtureOrigin,
      webOrigin: fixtureOrigin,
      dataDir,
      ...computerProductConfig,
      wakeupDriver: "memory",
      signupsEnabled: "true",
      encryptionKey: "computer-product-fixture-encryption-key",
      logger: createLogger({ service: "computer-product", level: "debug", sinks: [logs] }),
    });
  });

  afterEach(async () => {
    if (!cleanup) return;
    const { computer, context } = cleanup;
    cleanup = undefined;
    await handles.sandbox.destroy(computer, { ...context, signal: AbortSignal.timeout(60_000) });
  });

  afterAll(async () => {
    try {
      await handles?.stop();
      if (model) {
        steps.length = model.requests.length;
        model.assertComplete();
      }
    } finally {
      await model?.close();
      if (supervisor) await new Promise<void>((resolve) => supervisor.close(() => resolve()));
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  async function bootComputer(): Promise<Fixture> {
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: fixtureOrigin },
      body: JSON.stringify({
        email: `computer-product-${randomUUID()}@rakazo.test`,
        password: "password12",
        name: "Computer owner",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    await rpc(handles.app, cookie, "models/connect", {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
      apiKey: fixtureKey,
      contextWindow: 160_000,
      maxTokens: 4096,
      supportsImages: true,
    });
    const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
      name: "Operator",
      title: "",
      description: "",
      instructions: "Use the computer as asked.",
      notifyOnFinish: false,
    });
    await discardBotIntroRun(handles, cookie, bot.id, 60_000);
    await rpc(handles.app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: model.model.provider,
      modelId: model.model.id,
    });
    const owner = await db().bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { spaceId: true, userId: true, computer: { select: { homeKey: true } } },
    });
    if (!owner.computer) throw new Error("Fixture bot has no computer");
    const homeKey = owner.computer.homeKey;
    const { containerNameFor } = await import("@rakazo/sandbox-supervisor/computer-spec");
    const containerName = containerNameFor(homeKey);
    const context = {
      operationId: "computer-product",
      traceId: "computer-product",
      spaceId: owner.spaceId,
      userId: owner.userId,
      botId: homeKey,
    };
    // The supervisor can delete by name even if boot's reply or the following read fails.
    cleanup = {
      computer: {
        id: containerName,
        providerRef: containerName,
        botId: homeKey,
        kind: computerProductConfig.sandboxProvider,
      },
      context,
    };
    const booted = await rpc<{ state: string }>(handles.app, cookie, "computer/boot", {
      botId: bot.id,
    });
    const stored = await db().bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { computer: true, thread: true },
    });
    expect(stored.computer?.providerRef).toEqual(expect.any(String));
    const computer: ComputerRef = {
      id: stored.computer!.providerRef!,
      providerRef: stored.computer!.providerRef!,
      botId: stored.computer!.homeKey,
      kind: computerProductConfig.sandboxProvider,
    };
    cleanup.computer = computer;
    expect(booted.state).toBe("running");
    return {
      botId: bot.id,
      threadId: stored.thread!.id,
      cookie,
      computer,
      context: { ...context, signal: AbortSignal.timeout(120_000) },
    };
  }

  async function runTurn({ cookie, botId }: Fixture, text: string) {
    const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", { botId, text });
    const run = await vi.waitFor(
      async () => {
        const run = await db().run.findUniqueOrThrow({ where: { id: sent.runId } });
        if (!isTerminal(run.status) && run.status !== "waiting_input") {
          throw new Error(`Run is still ${run.status}`);
        }
        return run;
      },
      { timeout: 90_000, interval: 200 },
    );
    expect(run).toMatchObject({ status: "completed", error: null });
    return sent.runId;
  }

  async function expectNoVisibleSecret(
    { cookie, botId, threadId, context }: Fixture,
    runId: string,
    toolName: string,
    reply: string,
    value: string,
  ) {
    // Reads through the app's Prisma client also search decrypted history and event payloads.
    const [messages, events, run, effects, audit, security, thread] = await Promise.all([
      db().message.findMany({ where: { threadId } }),
      db().event.findMany({ where: { botId } }),
      db().run.findUniqueOrThrow({ where: { id: runId } }),
      db().externalEffect.findMany({ where: { runId } }),
      db().auditEvent.findMany({ where: { runId } }),
      db().securityEvent.findMany({ where: { userId: context.userId } }),
      rpc(handles.app, cookie, "threads/get", { botId }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent.tool.called",
        runId,
        payload: expect.objectContaining({ name: toolName }),
      }),
    );
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "credential.used",
        metadata: expect.objectContaining({ tool: toolName }),
      }),
    );
    expect(JSON.stringify(thread)).toContain(reply);
    expect(logs.events.length).toBeGreaterThan(0);
    for (const [source, data] of Object.entries({
      model: model.requests,
      messages,
      events,
      run,
      effects,
      audit,
      security,
      thread,
      logs: logs.events,
    })) {
      expect(JSON.stringify(data).includes(value), `Synthetic credential leaked in ${source}`).toBe(
        false,
      );
    }
  }

  it("opens fixture pages, types into the desktop, observes a real screen and stops", async () => {
    const bot = await bootComputer();
    const { computer, context } = bot;
    await installContactsFixture(handles.sandbox, computer, context);
    await handles.sandbox.writeFile(
      computer,
      {
        path: "typing/index.html",
        content: new TextEncoder().encode(
          `<title>typing</title><input id="q" autofocus oninput="document.title=this.value;
          if (this.value === '${TYPED}') document.body.style.background = 'rgb(${TYPING_BACKGROUND.join(",")})'">`,
        ),
      },
      context,
    );
    await runFixtureCommand(
      handles.sandbox,
      computer,
      context,
      "setsid -f python3 -m http.server 8766 -b 127.0.0.1 -d typing > typing.log 2>&1 < /dev/null",
    );
    await vi.waitFor(
      () =>
        runFixtureCommand(handles.sandbox, computer, context, `curl --fail --silent ${TYPING_URL}`),
      { timeout: 10_000 },
    );

    let finalRequest: ModelEmulatorRequest | undefined;
    route = (request) => {
      const done = (id: string) => toolResult(request, id) !== undefined;
      if (!done("local")) return tool("local", "browser_navigate", { url: EXPORT_FIXTURE_URL });
      if (!done("typing")) return tool("typing", "browser_navigate", { url: TYPING_URL });
      if (!done("type"))
        return tool("type", "computer_act", {
          actions: [{ kind: "type", text: TYPED }],
          observe: false,
        });
      if (!done("snapshot")) return tool("snapshot", "browser_snapshot", {});
      if (!done("observe")) return tool("observe", "computer_observe", {});
      finalRequest = request;
      return { type: "text", text: "OPERATOR-DONE" };
    };
    await runTurn(bot, "Open the fixture pages, type into the page, and look at the screen.");
    expect(finalRequest).toBeDefined();
    expect(toolResult(finalRequest!, "local")).toContain("Export contacts");
    expect(toolResult(finalRequest!, "snapshot")).toContain(TYPED);
    // The wire protocol puts a tool result's images in a user message after the tool result batch.
    // Observe was issued by itself, so only the adjacent attachment can belong to that call.
    const observeIndex = finalRequest!.messages.findLastIndex((message) => message.role === "tool");
    expect(finalRequest!.messages[observeIndex]?.tool_call_id).toBe("observe");
    const attachments = finalRequest!.messages.slice(observeIndex + 1);
    const image = JSON.stringify(
      attachments.find((message) => message.role === "user")?.content ?? [],
    ).match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)?.[1];
    expect(image).toBeDefined();
    const screenshot = Buffer.from(image!, "base64");
    const { data, width, height } = PNG.sync.read(screenshot);
    const [red, green, blue] = TYPING_BACKGROUND;
    let fixturePixels = 0;
    for (let pixel = 0; pixel < data.length; pixel += 4) {
      if (data[pixel] === red && data[pixel + 1] === green && data[pixel + 2] === blue)
        fixturePixels++;
    }
    expect(fixturePixels).toBeGreaterThan((width * height) / 4);

    const stopped = await rpc<{ state: string }>(handles.app, bot.cookie, "computer/stop", {
      botId: bot.botId,
    });
    expect(stopped.state).toBe("stopped");
    expect(await handles.sandbox.isRunning?.(computer, context)).toBe(false);
  }, 180_000);

  it("fills a vault login in an HTTPS browser and redacts the site's echo", async () => {
    const bot = await bootComputer();
    const { computer, context, cookie } = bot;
    await installLoginFixture(handles.sandbox, computer, context);
    const login = await rpc<{ name: string }>(handles.app, cookie, "vault/put", {
      destination: { name: "fixture_login", origin: LOGIN_ORIGIN, auth: { type: "login" } },
      value: JSON.stringify({ fields: [{ label: "Password", value: LOGIN_VALUE, hidden: true }] }),
      policy: "allow",
    });
    let finalRequest: ModelEmulatorRequest | undefined;
    const reply = "LOGIN-DONE";
    route = (request) => {
      const opened = toolResult(request, "login-page");
      if (!opened) return tool("login-page", "browser_navigate", { url: `${LOGIN_ORIGIN}/` });
      if (!toolResult(request, "login-fill"))
        return tool("login-fill", "browser_act", {
          actions: [
            {
              kind: "fill_secret",
              ref: refFor(opened, "Password"),
              secret: login.name,
              field: "Password",
            },
          ],
        });
      if (!toolResult(request, "login-submit"))
        return tool("login-submit", "browser_act", {
          actions: [{ kind: "click", ref: refFor(toolResult(request, "login-fill"), "Sign in") }],
        });
      if (!toolResult(request, "login-confirm"))
        return tool("login-confirm", "browser_snapshot", {});
      finalRequest = request;
      return { type: "text", text: reply };
    };
    const runId = await runTurn(bot, `Use the saved login on ${LOGIN_ORIGIN}/ and sign in.`);
    const receipt = await handles.sandbox.readFile(computer, "login-receipt.txt", context);
    expect(Buffer.from(receipt).toString()).toBe(digest(LOGIN_VALUE));
    expect(finalRequest).toBeDefined();
    expect(toolResult(finalRequest!, "login-confirm")).toContain("Signed in");
    expect(toolResult(finalRequest!, "login-confirm")).toContain("Echo: [redacted]");
    await expectNoVisibleSecret(bot, runId, "browser_act", reply, LOGIN_VALUE);
  }, 180_000);

  it("exports a vault command variable and redacts it in shell output and activity", async () => {
    const bot = await bootComputer();
    await rpc(handles.app, bot.cookie, "vault/put", {
      destination: { name: "fixture_command", origin: "", auth: { type: "command" } },
      value: COMMAND_VALUE,
      policy: "allow",
    });
    // The desktop guard directs commands with unresolved shell expansions to a script.
    // Keep the digest in the fixture workspace and exercise redaction on both output streams.
    await handles.sandbox.writeFile(
      bot.computer,
      {
        path: "command-probe.py",
        content: new TextEncoder().encode(
          `import hashlib
import os
import sys
from pathlib import Path

value = os.environ["FIXTURE_COMMAND"]
Path(__file__).with_name("command-receipt.txt").write_text(hashlib.sha256(value.encode()).hexdigest())
print("stdout=" + value)
print("stderr=" + value, file=sys.stderr)
`,
        ),
      },
      bot.context,
    );
    const reply = "SHELL-DONE";
    let result: unknown;
    route = (request) => {
      result = toolResult(request, "vault-shell");
      return result === undefined
        ? tool("vault-shell", "shell", { command: "python3 /home/rakazo/command-probe.py" })
        : { type: "text", text: reply };
    };
    const runId = await runTurn(bot, "Use the saved command variable in the fixture shell.");
    expect(JSON.parse(String(result))).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("stdout=[redacted]"),
      stderr: expect.stringContaining("stderr=[redacted]"),
    });
    const receipt = await handles.sandbox.readFile(
      bot.computer,
      "command-receipt.txt",
      bot.context,
    );
    expect(Buffer.from(receipt).toString()).toBe(digest(COMMAND_VALUE));
    const commands = await rpc<Array<Record<string, unknown>>>(
      handles.app,
      bot.cookie,
      "computer/commands",
      { botId: bot.botId },
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        kind: "shell",
        status: "done",
        exitCode: 0,
        output: expect.stringMatching(/stdout=\[redacted\][\s\S]*stderr=\[redacted\]/),
      }),
    );
    expect(JSON.stringify(commands).includes(COMMAND_VALUE)).toBe(false);
    await expectNoVisibleSecret(bot, runId, "shell", reply, COMMAND_VALUE);
  }, 180_000);
});

async function rpc<T>(app: App, cookie: string, procedure: string, input: unknown = {}) {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(
      `${procedure}: ${body.error?.message ?? response.status} ${JSON.stringify(body).slice(0, 400)}`,
    );
  return body.json as T;
}
