import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { startModelEmulator } from "../../scripts/superbot-test-support.mjs";

import { checkBotConversations, conversationSteps } from "./verify-bot-conversations.mjs";
import { checkConversationContent } from "./verify-conversation-content.mjs";
import { prepareMarketplaceApp } from "./verify-marketplace-app.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const exec = promisify(execFile);
const {
  positionals: [postgresBin, executable, desktopExecutable],
  values: {
    "notifications-probe": notificationProbe,
    marketplace,
    "marketplace-app": marketplaceApp,
    roster,
    "local-cli": localCli,
  },
} = parseArgs({
  allowPositionals: true,
  options: {
    "notifications-probe": { type: "string" },
    marketplace: { type: "boolean" },
    "marketplace-app": { type: "boolean" },
    roster: { type: "boolean" },
    "local-cli": { type: "boolean" },
  },
});
assert(
  process.platform === "win32" && postgresBin && executable,
  "Usage: node --import tsx infra/superbot/verify-chat.mjs POSTGRES_BIN_DIR SUPERBOT_EXE [SUPERBOT_DESKTOP_EXE] [--notifications-probe EXE] [--marketplace] [--marketplace-app] [--roster] [--local-cli]",
);
const cli = resolve(executable);
const pg = (file) => resolve(postgresBin, `${file}.exe`);
const prompt = "What is the fixture response?";
const reply = "The fixture response is blue.";
const groupPrompt = "What is the shared fixture response?";
const groupReply = "The shared fixture response is green.";
const skillPrompt = "Read the granted release notes skill.";
const skillInstructions =
  "Group completed changes by feature and fix. Keep the fixture marker mauve-slate.";
const skillReply = "The marketplace skill groups completed changes by feature and fix.";
const secret = () => randomBytes(32).toString("hex");

async function loopbackPort() {
  const listener = createServer();
  await new Promise((done, fail) => listener.listen(0, "127.0.0.1", done).once("error", fail));
  const { port } = listener.address();
  await new Promise((done, fail) => listener.close((error) => (error ? fail(error) : done())));
  return port;
}

const [apiPort, dbPort] = await Promise.all([loopbackPort(), loopbackPort()]);
const origin = `http://127.0.0.1:${apiPort}`;
const reviewerEmail =
  desktopExecutable || marketplace || marketplaceApp
    ? `reviewer-${randomUUID()}@example.test`
    : undefined;
const credentialTarget = `${origin}/.com.superbot.rakazo.session`;
const directory = await mkdtemp(join(tmpdir(), "superbot-chat-"));
const db = join(directory, "pg");
const scratch = join(directory, "tmp");
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    [
      "path",
      "systemroot",
      "windir",
      "comspec",
      "pathext",
      "userprofile",
      "appdata",
      "localappdata",
      "systemdrive",
    ].includes(key.toLowerCase()),
  ),
);
Object.assign(env, {
  SUPERBOT_CONFIG_DIR: join(directory, "client-config"),
  NODE_ENV: "test",
  TEMP: scratch,
  TMP: scratch,
  RAKAZO_ENV_FILE: "none",
  DATABASE_MIGRATION_URL: `postgresql://fixture:${secret()}@127.0.0.1:${dbPort}/postgres`,
  DATABASE_URL: `postgresql://fixture_runtime:${secret()}@127.0.0.1:${dbPort}/postgres`,
  RAKAZO_DB_PACKAGE_DIR: join(root, "packages/db"),
  CHECKPOINT_DISABLE: "1",
  BETTER_AUTH_SECRET: secret(),
  ENCRYPTION_KEY: secret(),
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
  API_PORT: String(apiPort),
  DATA_DIR: join(directory, "data"),
  SIGNUPS_ENABLED: "true",
  SANDBOX_PROVIDER: "fake",
  EMAIL_PROVIDER: "none",
  MCP_ALLOW_PRIVATE_ENDPOINT: "true",
  ...(reviewerEmail && { RAKAZO_ADMIN_EMAILS: reviewerEmail }),
});

async function command(file, args, label, childEnv = env) {
  try {
    return await exec(file, args, {
      cwd: root,
      env: childEnv,
      timeout: 100_000,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`${label} failed (${error.code ?? error.signal ?? "unknown"})`);
  }
}

async function controlPostgres(args, label) {
  const child = spawn(pg("pg_ctl"), args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: "ignore",
    timeout: 30_000,
  });
  const exit = await new Promise((done, fail) => child.once("exit", done).once("error", fail));
  assert.equal(exit, 0, label);
}

const children = [];
let logs;

function observeNotifications({ token, space }) {
  const child = spawn(resolve(notificationProbe), [origin, space], {
    cwd: root,
    env,
    windowsHide: true,
    timeout: 90_000,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const done = new Promise((resolve) => {
    child.once("error", () => resolve(null)).once("close", resolve);
  });
  children.push({ child, done });
  child.stdin.end(`${token}\n`);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    async expect(marker) {
      const line = await lines.next();
      assert.equal(line.value, marker, "Expected Rust observer notification checkpoint");
    },
    async complete() {
      assert.equal(await done, 0, "Rust notification verifier exited successfully");
    },
  };
}

async function server(entry) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", logs.fd, logs.fd],
  });
  children.push({ child, done: new Promise((done) => child.once("close", done)) });
}

async function post(path, value, { token, space, status = 200 } = {}) {
  const result = await fetch(origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "rakazo://",
      ...(token && { authorization: `Bearer ${token}` }),
      ...(space && { "x-rakazo-space-id": space }),
    },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(30_000),
  });
  if (result.status !== status) {
    const payload = await result.json().catch(() => ({}));
    throw new Error(
      path +
        " returned " +
        result.status +
        " (" +
        (payload.json?.code ?? payload.code ?? "unknown") +
        ")",
    );
  }
  return result;
}

async function rpc(path, input, options) {
  return (await (await post(`/rpc/${path}`, { json: input }, options)).json()).json;
}

async function followThread(target, session, cursor) {
  const stream = await post("/rpc/threads/subscribe", { json: { ...target, cursor } }, session);
  assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    close: () => reader.cancel(),
    async nextEvent() {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6)).json;
        } else {
          const { done, value } = await reader.read();
          assert(!done, "Conversation stream ended");
          buffer += value.replaceAll("\r\n", "\n");
        }
      }
    },
  };
}

async function signup(name, reviewerEmail) {
  const body = {
    name,
    email: reviewerEmail ?? `${name.toLowerCase()}-${randomUUID()}@example.test`,
    password: secret(),
  };
  const response = await post("/api/auth/sign-up/email", body);
  const { user } = await response.json();
  if (reviewerEmail) {
    await command(
      process.execPath,
      ["apps/api/dist/cli/bootstrap-owner.js"],
      "Fixture reviewer verification",
      {
        ...env,
        OWNER_EMAIL: body.email,
        OWNER_PASSWORD: body.password,
      },
    );
  }
  const session = await post("/api/auth/sign-in/email", {
    email: body.email,
    password: body.password,
  });
  const token = session.headers.get("set-auth-token");
  assert(token, "Rakazo issued a signed bearer session");
  return { id: user.id, name, token };
}

async function checkCliChat({
  spaceName,
  agent,
  prompt,
  reply,
  picker,
  threadId,
  newConversation,
  childEnv = env,
}) {
  const args = ["--server", origin, "--space", spaceName];
  if (threadId) args.push("chat", agent.name, "--conversation", threadId);
  else if (newConversation) args.push("chat", agent.name, "--new-conversation");
  else if (!picker) args.push(agent.name);
  const child = spawn(cli, args, {
    cwd: root,
    env: childEnv,
    windowsHide: true,
    timeout: 30_000,
  });
  const chunks = [];
  const errors = [];
  child.stdout.setEncoding("utf8").on("data", (chunk) => chunks.push(chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => errors.push(chunk));
  child.stdin.on("error", () => {});
  child.stdin.end(`${picker ? `${picker}\n` : ""}${prompt}\n/quit\n`);
  const exit = await new Promise((done, fail) => child.once("close", done).once("error", fail));
  assert.equal(exit, 0, errors.join("").trim() || "Fixture CLI exited unsuccessfully");
  assert(
    chunks.join("").includes(`${agent.name} > ${reply}`),
    `CLI did not print the expected agent reply: ${chunks.join("").trim()}`,
  );
  assert.equal(errors.join(""), "");
  return chunks.join("");
}

async function checkInstalledLocalChat({ spaceName, owner, scopedOwner, scopedObserver, source }) {
  const agent = await rpc("bots/duplicate", { botId: source.id }, scopedOwner);
  const config = join(directory, "local-cli");
  const bin = join(directory, "fake-bin");
  const scope = createHash("sha256");
  for (const value of [new URL(origin).href, owner.id, scopedOwner.space]) {
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(Buffer.byteLength(value)));
    scope.update(size).update(value);
  }
  const modelDir = join(config, "local-models", scope.digest("hex"));
  const botHash = createHash("sha256").update(agent.id).digest("hex");
  const profile = join(modelDir, "claude");
  await mkdir(profile, { recursive: true });
  await mkdir(bin);
  await command(
    "rustc.exe",
    ["native/features/tests/fixtures/local_cli.rs", "-o", join(bin, "claude.exe")],
    "Build synthetic local CLI",
  );
  await writeFile(join(profile, "fake-signed-in"), "");
  await writeFile(
    join(modelDir, `bot-${botHash}.json`),
    JSON.stringify({
      provider: "claude",
      id: "fixture-chat",
      label: "Local fixture model",
    }),
  );
  const { PATH: path, Path: mixedPath, ...childEnv } = env;
  Object.assign(childEnv, {
    PATH: `${bin};${path ?? mixedPath ?? ""}`,
    SUPERBOT_CONFIG_DIR: config,
  });
  const { stdout } = await command(
    cli,
    ["--server", origin, "--space", spaceName, "list"],
    "List fixture agents",
    childEnv,
  );
  const picker =
    stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("  "))
      .findIndex((line) => line.trim() === agent.name) + 1;
  assert(picker > 0);
  const run = (prompt, reply, choice) =>
    checkCliChat({ spaceName, agent, prompt, reply, picker: choice, childEnv });
  await run("First local fixture prompt", "First local fixture reply");
  await run("Follow up locally", "Second local fixture reply", picker);

  const target = { botId: agent.id };
  const read = () => rpc("threads/get", target, scopedObserver);
  const first = await read();
  assert.deepEqual(
    first.messages.map(({ role, origin, author, blocks }) => [
      role,
      origin,
      author.id,
      blocks[0].text,
    ]),
    [
      ["user", "First local fixture prompt"],
      ["bot", "First local fixture reply"],
      ["user", "Follow up locally"],
      ["bot", "Second local fixture reply"],
    ].map(([role, text]) => [role, "local_cli", owner.id, text]),
  );

  const pending = { id: randomUUID(), text: "Retry fixture prompt", reply: "Retry fixture reply" };
  const pendingFile = join(modelDir, `pending-${botHash}.json`);
  await writeFile(pendingFile, JSON.stringify(pending));
  const committed = await rpc(
    "threads/appendLocalHistory",
    {
      ...target,
      operationId: pending.id,
      text: pending.text,
      reply: pending.reply,
    },
    scopedOwner,
  );
  await run("/retry", pending.reply);
  await assert.rejects(readFile(pendingFile), { code: "ENOENT" });
  assert.deepEqual(
    (await read()).messages.map(({ id }) => id),
    [...first.messages.map(({ id }) => id), ...committed.messageIds],
  );
  const createLocalConversation = async () => {
    const output = await checkCliChat({
      spaceName,
      agent,
      childEnv,
      newConversation: true,
      prompt: "First local fixture prompt",
      reply: "First local fixture reply",
    });
    return output.match(/^Conversation (\S+)$/m)?.[1];
  };
  const left = await createLocalConversation();
  const right = await createLocalConversation();
  assert(left && right && left !== right);
  const retryKey = createHash("sha256").update(`thread:${left}`).digest("hex");
  const retryFile = join(modelDir, `pending-${retryKey}.json`);
  await writeFile(retryFile, JSON.stringify(pending));
  await checkCliChat({
    spaceName,
    agent,
    childEnv,
    threadId: right,
    prompt: "Follow up locally",
    reply: "Second local fixture reply",
  });
  assert.deepEqual(JSON.parse(await readFile(retryFile, "utf8")), pending);
  await checkCliChat({
    spaceName,
    agent,
    childEnv,
    threadId: left,
    prompt: "/retry",
    reply: pending.reply,
  });
  await assert.rejects(readFile(retryFile), { code: "ENOENT" });
  const load = (threadId) => rpc("threads/get", { ...target, threadId }, scopedObserver);
  const messages = (snapshot) =>
    snapshot.messages.map(({ origin, blocks }) => {
      assert.equal(origin, "local_cli");
      return blocks[0].text;
    });
  const initial = ["First local fixture prompt", "First local fixture reply"];
  assert.deepEqual(messages(await load(left)), [...initial, pending.text, pending.reply]);
  assert.deepEqual(messages(await load(right)), [
    ...initial,
    "Follow up locally",
    "Second local fixture reply",
  ]);
  console.log(
    "PASS named and picker chats ran the selected local CLI and retried shared history without duplication",
  );
}

const modelKey = secret();
let model;
let credentialSaved = false;
let postgresStarted = false;
try {
  await mkdir(scratch);
  const passwordFile = join(directory, "pg-password");
  await writeFile(passwordFile, `${new URL(env.DATABASE_MIGRATION_URL).password}\n`, {
    flag: "wx",
  });
  await command(
    pg("initdb"),
    [
      "-D",
      db,
      "-U",
      "fixture",
      `--pwfile=${passwordFile}`,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
    ],
    "Database initialization",
  );
  await rm(passwordFile);
  await controlPostgres(
    [
      "start",
      "-D",
      db,
      "-l",
      join(directory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${dbPort}`,
      "-w",
    ],
    "Database startup failed",
  );
  postgresStarted = true;
  await command(process.execPath, ["apps/api/dist/cli/migrate-database.js"], "Migration");
  logs = await open(join(directory, "services.log"), "w");
  await server("apps/worker/src/index.ts");
  await server("apps/api/src/index.ts");
  const ready = AbortSignal.timeout(30_000);
  for (;;) {
    if (children.some(({ child }) => child.exitCode !== null))
      throw new Error("API or worker stopped during startup");
    const response = await fetch(`${origin}/ready`, { signal: ready }).catch(() => null);
    const health = await readFile(join(scratch, "rakazo-worker-health.json"), "utf8").catch(
      () => null,
    );
    if (response?.ok && health && JSON.parse(health).reconciled > 0) break;
    await delay(150, undefined, { signal: ready });
  }

  const owner = await signup("Owner", reviewerEmail);
  const observer = await signup("Observer");
  const { id: space, name: spaceName } = await rpc(
    "spaces/create",
    { name: "Shared chat fixture" },
    owner,
  );
  const scopedOwner = { ...owner, space };
  const scopedObserver = { ...observer, space };
  const { url } = await rpc("spaces/invites/create", { spaceId: space }, owner);
  const invite = new URL(url);
  assert.equal(invite.origin, origin);
  await rpc("spaces/invites/accept", { token: invite.pathname.split("/").at(-1) }, observer);

  const notifications = notificationProbe ? observeNotifications(scopedObserver) : undefined;
  await notifications?.expect("READY");
  const first = await rpc("bots/create", { name: "Fixture agent" }, scopedOwner);
  await notifications?.expect("AGENT_CREATED");
  const second = await rpc("bots/create", { name: "Support agent" }, scopedOwner);
  if (notifications) {
    await rpc("bots/update", { botId: second.id, name: "Renamed fixture support" }, scopedOwner);
    await notifications.expect("AGENT_RENAMED");
  }
  const steps = [
    [prompt, reply],
    [groupPrompt, groupReply],
  ].map(([expected, text]) => ({
    expect(request) {
      assert(
        request.messages.some(
          (message) =>
            message.role === "user" && JSON.stringify(message.content).includes(expected),
        ),
      );
    },
    response: { type: "text", text },
  }));
  if (marketplace) {
    const submission = await rpc(
      "pluginRegistry/submit",
      {
        slug: "fixture-release-notes",
        version: 1,
        manifest: {
          schemaVersion: 1,
          name: "Fixture release notes",
          description: "A deterministic release notes skill.",
          parts: [{ id: "release-notes", kind: "skill", instructions: skillInstructions }],
        },
      },
      scopedObserver,
    );
    assert.equal(submission.status, "pending");
    assert.deepEqual(
      (await rpc("pluginRegistry/discover", { slug: submission.slug }, scopedOwner)).items,
      [],
    );
    await post(
      "/rpc/pluginRegistry/review",
      { json: { versionId: submission.id, decision: "approved" } },
      { ...scopedObserver, status: 403 },
    );
    const approved = await rpc(
      "pluginRegistry/review",
      { versionId: submission.id, decision: "approved" },
      scopedOwner,
    );
    assert.equal(approved.status, "approved");
    const { items } = await rpc("pluginRegistry/discover", { slug: submission.slug }, scopedOwner);
    assert.deepEqual(
      items.map(({ id }) => id),
      [approved.id],
    );
    const installation = await rpc(
      "pluginRegistry/install",
      { versionId: approved.id },
      scopedOwner,
    );
    assert.equal(installation.plugin.id, approved.id);
    const granted = await rpc(
      "pluginRegistry/setGrants",
      { installationId: installation.id, botId: first.id, partIds: ["release-notes"] },
      scopedOwner,
    );
    assert.deepEqual(granted.grants, [{ botId: first.id, partId: "release-notes" }]);
    steps.push(
      {
        expect(request) {
          assert(
            request.messages.some(
              ({ role, content }) =>
                role === "user" && JSON.stringify(content).includes(skillPrompt),
            ),
          );
        },
        response(request) {
          const tools = request.tools.filter(({ function: tool }) =>
            tool.name.startsWith("marketplace__release_notes_"),
          );
          assert.equal(
            tools.length,
            1,
            "Expected the granted registry skill to be exposed by the worker",
          );
          return {
            type: "tool",
            id: "call_fixture_skill",
            name: tools[0].function.name,
            arguments: {},
          };
        },
      },
      {
        expect(request) {
          const toolReply = request.messages.find(
            ({ role, tool_call_id }) => role === "tool" && tool_call_id === "call_fixture_skill",
          );
          assert(toolReply, "The real worker must return the granted skill's tool result");
          assert(
            JSON.stringify(toolReply.content).includes(skillInstructions),
            "The tool reply must contain the published skill's exact instructions",
          );
        },
        response: { type: "text", text: skillReply },
      },
    );
  }
  const app = marketplaceApp
    ? await prepareMarketplaceApp({
        rpc,
        followThread,
        owner: scopedOwner,
        publisher: scopedObserver,
        grantedBot: first,
        otherBot: second,
      })
    : undefined;
  steps.push(...(app?.steps ?? []), ...conversationSteps);
  model = await startModelEmulator({ apiKey: modelKey, steps });
  await rpc(
    "models/connect",
    {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
      apiKey: modelKey,
      contextWindow: 160_000,
      maxTokens: 4096,
    },
    scopedOwner,
  );
  await rpc(
    "bots/update",
    { botId: first.id, modelProvider: model.model.provider, modelId: model.model.id },
    scopedOwner,
  );
  if (app) {
    await rpc(
      "bots/update",
      { botId: second.id, modelProvider: model.model.provider, modelId: model.model.id },
      scopedOwner,
    );
  }

  const credential = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "infra/superbot/verify-chat-credential.ps1"),
      origin,
    ],
    { cwd: root, env, windowsHide: true, timeout: 15_000, stdio: ["pipe", "ignore", "inherit"] },
  );
  credential.stdin.end(`${owner.token}\n`);
  const credentialExit = await new Promise((done, fail) =>
    credential.once("close", done).once("error", fail),
  );
  assert.equal(credentialExit, 0, "Fixture credential registration failed");
  credentialSaved = true;
  await checkCliChat({ spaceName, agent: first, prompt, reply });
  console.log(
    "PASS installed Superbot CLI sent a message and printed its deterministic agent reply",
  );

  const group = await rpc(
    "groups/create",
    { name: "Fixture discussion", botIds: [first.id, second.id] },
    scopedOwner,
  );
  const target = { groupId: group.id };
  if (notifications) {
    await notifications.expect("GROUP_CREATED");
    await rpc("groups/update", { ...target, name: "Renamed fixture discussion" }, scopedOwner);
    await notifications.expect("GROUP_RENAMED");
  }
  const snapshot = await rpc("threads/get", target, scopedObserver);
  const { nextEvent, close } = await followThread(target, scopedObserver, snapshot.cursor);
  try {
    const sent = await rpc(
      "threads/send",
      { ...target, text: groupPrompt, mentions: [{ kind: "bot", id: first.id }] },
      scopedOwner,
    );
    let sawUser = false;
    let sawBot = false;
    for (;;) {
      const event = await nextEvent();
      if (event?.type === "thread.message.created") {
        const { author, botId, role, blocks } = event.payload;
        if (role === "user" && blocks.some(({ text }) => text === groupPrompt)) {
          assert.equal(author?.id, owner.id);
          assert.equal(author?.name, owner.name);
          sawUser = true;
        }
        if (role === "bot" && blocks.some(({ text }) => text === groupReply)) {
          assert.equal(botId ?? event.botId, first.id, "Stream identified the responding agent");
          sawBot = true;
        }
      }
      if (event?.runId === sent.runId) {
        assert.notEqual(event.type, "run.failed", "Shared conversation run failed");
        if (event.type === "run.completed") break;
      }
    }
    assert(sawUser && sawBot, "Observer saw both attributed messages");

    const append = "threads/appendLocalHistory";
    const note = { ...target, operationId: randomUUID(), text: "Shared fixture note" };
    const localTurn = {
      ...target,
      operationId: randomUUID(),
      text: "Local fixture prompt",
      reply: "Local fixture reply",
    };
    await rpc(append, note, { status: 401 });
    await rpc(append, note, { ...observer, status: 404 });
    const outsider = await signup("Outsider");
    await rpc(append, note, { ...outsider, space, status: 401 });
    await rpc(append, { ...note, runId: sent.runId }, { ...scopedOwner, status: 400 });

    const [firstNote, retriedNote] = await Promise.all([
      rpc(append, note, scopedOwner),
      rpc(append, note, scopedOwner),
    ]);
    assert.deepEqual(firstNote, retriedNote);
    assert.equal(firstNote.messageIds.length, 1);
    await rpc(append, { ...note, reply: localTurn.reply }, { ...scopedOwner, status: 409 });

    const [firstTurn, retriedTurn] = await Promise.all([
      rpc(append, localTurn, scopedOwner),
      rpc(append, localTurn, scopedOwner),
    ]);
    assert.deepEqual(firstTurn, retriedTurn);
    assert.equal(firstTurn.messageIds.length, 2);
    await rpc(append, { ...localTurn, reply: "Different text" }, { ...scopedOwner, status: 409 });

    const ids = [...firstNote.messageIds, ...firstTurn.messageIds];
    const saved = await rpc("threads/get", target, scopedObserver);
    const expected = [
      ["user", note.text],
      ["user", localTurn.text],
      ["bot", localTurn.reply],
    ];
    const reloaded = saved.messages.filter(({ origin }) => origin === "local_cli");
    assert.deepEqual(
      reloaded.map(({ id }) => id),
      ids,
    );
    assert.equal(reloaded[2].seq, reloaded[1].seq + 1);
    const checkLocalMessage = (message, index) => {
      assert.equal(message.origin, "local_cli");
      assert.equal(message.author.id, owner.id);
      assert.equal(message.author.name, owner.name);
      assert.equal(message.role, expected[index][0]);
      assert.deepEqual(message.blocks, [{ kind: "text", text: expected[index][1] }]);
      assert.equal(message.botId, undefined);
      assert.equal(message.runId, undefined);
    };
    reloaded.forEach(checkLocalMessage);

    let received = 0;
    let lastLocalEventSeq;
    while (received < ids.length) {
      const event = await nextEvent();
      if (!event || event.type === "heartbeat") continue;
      assert.equal(event.type, "thread.message.created");
      assert.equal(event.runId, undefined);
      assert.equal(event.payload.messageId, ids[received]);
      checkLocalMessage(event.payload, received);
      lastLocalEventSeq = event.seq;
      received++;
    }
    assert.equal(saved.cursor, lastLocalEventSeq);

    const directNote = { botId: first.id, operationId: note.operationId, text: note.text };
    const directOwner = await rpc(append, directNote, scopedOwner);
    const directObserver = await rpc(append, directNote, scopedObserver);
    assert.notDeepEqual(directOwner, directObserver);
    const direct = await rpc("threads/get", { botId: first.id }, scopedObserver);
    assert.deepEqual(
      direct.messages
        .filter(({ origin }) => origin === "local_cli")
        .map(({ id, author }) => [id, author.id]),
      [
        [directOwner.messageIds[0], owner.id],
        [directObserver.messageIds[0], observer.id],
      ],
    );
    console.log(
      "PASS local notes and CLI turns retry safely and reload with matching live attribution",
    );
  } finally {
    await close();
  }
  if (marketplace) {
    try {
      await checkCliChat({ spaceName, agent: first, prompt: skillPrompt, reply: skillReply });
    } catch (error) {
      model.assertComplete();
      throw error;
    }
  }
  if (app) {
    try {
      await app.verify((input) => checkCliChat({ spaceName, ...input }));
    } catch (error) {
      try {
        model.assertComplete();
      } catch (modelError) {
        throw new AggregateError([error, modelError], "Marketplace app fixture failed");
      }
      throw error;
    }
  }
  if (localCli) {
    await checkInstalledLocalChat({ spaceName, owner, scopedOwner, scopedObserver, source: first });
  }
  await checkBotConversations({
    rpc,
    post,
    signup,
    space,
    scopedOwner,
    scopedObserver,
    first,
    second,
    chat: (input) => checkCliChat({ spaceName, agent: first, ...input }),
  });
  await checkConversationContent({
    rpc,
    migrationUrl: env.DATABASE_MIGRATION_URL,
    scopedOwner,
    scopedObserver,
    first,
    second,
  });
  model.assertComplete();
  if (marketplace) {
    console.log(
      "PASS a published and granted marketplace skill returned its instructions to the model through the CLI chat",
    );
  }
  if (notifications) {
    await notifications.expect("GROUP_PREVIEW");
    await notifications.complete();
    console.log(
      "PASS the Rust observer refreshed the shared Space after each roster or chat signal",
    );
  }
  console.log(
    "PASS a second signed-in Space member streamed the human and agent messages with matching author IDs",
  );
  if (desktopExecutable) {
    await rpc(
      "pluginRegistry/submit",
      {
        slug: "release-notes",
        version: 1,
        manifest: {
          schemaVersion: 1,
          name: "Release notes",
          description: "Draft release notes from completed issues.",
          parts: [
            {
              id: "summarize",
              kind: "skill",
              instructions:
                "Group completed issues by feature and fix. Use only information in the supplied notes.",
            },
          ],
        },
      },
      scopedObserver,
    );
    const fixtureDesktop = join(directory, "superbot-desktop.exe");
    await copyFile(resolve(desktopExecutable), fixtureDesktop);
    const desktop = spawn(fixtureDesktop, [], {
      cwd: root,
      env: {
        ...env,
        SUPERBOT_CONFIG_DIR: directory,
        SUPERBOT_SERVER: origin,
        SUPERBOT_SKIN: "midnight",
      },
      stdio: "ignore",
      windowsHide: false,
    });
    console.log(`Desktop comparison fixture PID ${desktop.pid}. Close its window to finish.`);
    const code = await new Promise((done, fail) => desktop.once("error", fail).once("close", done));
    assert.equal(code, 0, "Fixture desktop exited successfully");
  }
  if (roster) {
    const existing = await rpc("bots/create", { name: "Roster One" }, scopedOwner);
    const archived = await rpc("bots/create", { name: "Roster Archived" }, scopedOwner);
    await rpc("bots/archive", { botId: archived.id }, scopedOwner);
    const rosterFile = join(directory, "roster.json");
    await writeFile(
      rosterFile,
      JSON.stringify({ names: ["roster one", "Roster Two", " Roster Two ", "Roster Archived"] }),
    );
    const args = ["--server", origin, "--space", space, "import-bots", rosterFile];
    const preview = await command(cli, [...args, "--dry-run"], "Preview roster");
    assert.match(preview.stdout, /2 existing, 1 to import/);
    const active = () => rpc("bots/list", {}, scopedObserver);
    assert.ok(!(await active()).some((bot) => bot.name === "Roster Two"));
    await Promise.all([
      command(cli, args, "First roster import"),
      command(cli, args, "Concurrent roster import"),
    ]);
    const replay = await command(cli, args, "Repeat roster import");
    assert.match(replay.stdout, /3 existing, 0 to import/);
    const visible = await active();
    assert.equal(visible.filter((bot) => bot.name === "Roster Two").length, 1);
    assert.ok(visible.some((bot) => bot.id === existing.id && bot.name === "Roster One"));
    assert.ok(!visible.some((bot) => bot.id === archived.id));
    const stillArchived = await rpc("bots/listArchived", {}, scopedOwner);
    assert.ok(stillArchived.some((bot) => bot.id === archived.id));
    console.log(
      "PASS two concurrent imports and a retry produced one shared bot and preserved the archived bot",
    );
  }
  const logout = await command(cli, ["--server", origin, "logout"], "Fixture CLI logout");
  assert.equal(logout.stdout.trim(), "Signed out.");
  credentialSaved = false;
} finally {
  for (const { child } of children) child.kill();
  await Promise.all(children.map(({ done }) => done));
  const cleanup = await Promise.allSettled([
    credentialSaved &&
      command("cmdkey.exe", [`/delete:${credentialTarget}`], "Fixture credential cleanup"),
    logs?.close(),
    model?.close(),
    postgresStarted &&
      controlPostgres(["stop", "-D", db, "-m", "immediate", "-w"], "Database shutdown failed"),
  ]);
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  for (const result of cleanup) {
    if (result.status === "rejected") {
      console.error(result.reason.message);
      process.exitCode = 1;
    }
  }
}
