// A disposable server for checking the desktop's chat against known data: one agent
// conversation long enough to page (three pages across three days), a group of two bots, and
// file messages in both. Everything is synthetic; nothing leaves this computer.
//
//   node --import tsx native/desktop/fixture/chat-parity.mjs POSTGRES_BIN_DIR OUTPUT_DIR
//
// It writes OUTPUT_DIR/fixture.json (the origin and the two accounts) once the data is in
// place, then serves until OUTPUT_DIR/stop exists, and removes everything it made.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startModelEmulator } from "../../../scripts/superbot-test-support.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);
const [, , postgresBin, outputDir] = process.argv;
assert(
  postgresBin && outputDir,
  "Usage: node --import tsx native/desktop/fixture/chat-parity.mjs POSTGRES_BIN_DIR OUTPUT_DIR",
);
const windows = process.platform === "win32";
const pg = (file) => resolve(postgresBin, windows ? `${file}.exe` : file);
const output = resolve(outputDir);
const secret = () => randomBytes(32).toString("hex");
// 112 exchanges are 224 messages: three pages at the server's 100 a page.
const EXCHANGES = Number(process.env.CHAT_PARITY_EXCHANGES ?? 112);

async function loopbackPort() {
  const listener = createServer();
  await new Promise((done, fail) => listener.listen(0, "127.0.0.1", done).once("error", fail));
  const { port } = listener.address();
  await new Promise((done, fail) => listener.close((error) => (error ? fail(error) : done())));
  return port;
}

const [apiPort, dbPort] = await Promise.all([loopbackPort(), loopbackPort()]);
const origin = `http://127.0.0.1:${apiPort}`;
const directory = await mkdtemp(join(tmpdir(), "superbot-chat-parity-"));
const db = join(directory, "pg");
const scratch = join(directory, "tmp");
const inherited = windows
  ? [
      "path",
      "systemroot",
      "windir",
      "comspec",
      "pathext",
      "userprofile",
      "appdata",
      "localappdata",
      "systemdrive",
    ]
  : ["path", "home", "lang"];
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => inherited.includes(key.toLowerCase())),
);
Object.assign(env, {
  NODE_ENV: "test",
  TEMP: scratch,
  TMP: scratch,
  ...(!windows && { TMPDIR: scratch }),
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
});

async function command(file, args, label) {
  try {
    return await exec(file, args, { cwd: root, env, timeout: 100_000, windowsHide: true });
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

async function clearDesktopSession() {
  const service = "com.superbot.rakazo.session";
  const account = `${origin}/`;
  const options = { timeout: 5000 };
  if (windows || process.platform === "darwin") {
    try {
      if (windows) {
        // cmdkey collapses deletion errors to exit 1. Keep the original Win32 status.
        await exec(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Add-Type -Name CredentialManager -Namespace SuperbotFixture -ErrorAction Stop -MemberDefinition @'
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
private static extern bool CredDelete(string target, uint type, uint flags);
public static int DeleteGeneric(string target) {
    const uint generic = 1;
    return CredDelete(target, generic, 0) ? 0 : Marshal.GetLastWin32Error();
}
'@
exit ([SuperbotFixture.CredentialManager]::DeleteGeneric($env:SUPERBOT_FIXTURE_CREDENTIAL_TARGET))`,
          ],
          {
            timeout: 10000,
            windowsHide: true,
            env: { ...process.env, SUPERBOT_FIXTURE_CREDENTIAL_TARGET: `${account}.${service}` },
          },
        );
      } else {
        await exec("security", ["delete-generic-password", "-s", service, "-a", account], options);
      }
    } catch (error) {
      // ERROR_NOT_FOUND on Windows, errSecItemNotFound on macOS.
      if (error.code !== (windows ? 1168 : 44)) throw error;
    }
    return;
  }
  if (process.platform !== "linux") return;

  const attributes = [
    "service",
    service,
    "username",
    account,
    "target",
    "default",
    "application",
    "rust-keyring",
  ];
  try {
    await exec("secret-tool", ["clear", ...attributes], options);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`Remove the Secret Service entry for ${service} with username ${account}.`);
      return;
    }
    if (error.code !== 1 || error.stdout || error.stderr) throw error;
  }
  // clear only deletes unlocked matches. Even a silent status 1 can mean a locked match.
  const { stdout, stderr } = await exec("secret-tool", ["search", "--all", ...attributes], options);
  if (stdout || stderr)
    throw new Error(`Could not clear the Secret Service session for ${account}`);
}

const children = [];
let logs;

async function server(entry) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", logs.fd, logs.fd],
  });
  children.push({ child, done: new Promise((done) => child.once("close", done)) });
}

async function post(path, value, { token, space } = {}) {
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
  if (!result.ok) {
    const payload = await result.json().catch(() => ({}));
    const refusal = payload.json ?? payload;
    throw new Error(
      `${path} returned ${result.status} (${refusal.code ?? "unknown"}: ${refusal.message ?? ""})`,
    );
  }
  return result;
}

async function rpc(path, input, options) {
  return (await (await post(`/rpc/${path}`, { json: input }, options)).json()).json;
}

async function signup(name) {
  const account = {
    name,
    email: `${name.toLowerCase()}-${randomUUID()}@example.test`,
    password: secret(),
  };
  const { user } = await (await post("/api/auth/sign-up/email", account)).json();
  const session = await post("/api/auth/sign-in/email", account);
  const token = session.headers.get("set-auth-token");
  assert(token, "the server issued a session");
  return { ...account, id: user.id, token };
}

/** Sends one message and waits until every run it started has ended. */
async function say(who, target, message) {
  await rpc("threads/send", { ...target, ...message }, who);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const { runs } = await rpc("runs/list", { filter: "active" }, who);
    if (runs.length === 0) return;
    assert(Date.now() < deadline, "a fixture run did not finish");
    await delay(60);
  }
}

async function upload(who, target, name, mimeType, bytes) {
  const input = { ...target, name, mimeType, contentBase64: Buffer.from(bytes).toString("base64") };
  return (await rpc("artifacts/create", input, who)).id;
}

/** What the fixture model answers: a line that names what it was told. */
function answer(request) {
  const said = request.messages.filter((message) => message.role === "user").at(-1)?.content;
  const text = typeof said === "string" ? said : JSON.stringify(said ?? "");
  const note = /Note (\d+)/.exec(text);
  if (note) return `Noted ${note[1]}.`;
  if (text.includes("launch-notes")) return "I have the launch notes.";
  if (text.includes("pixel")) return "I have the picture.";
  return "The fixture heard you.";
}

/**
 * Spreads a thread's messages over three days ending now, a minute apart, with a quiet spell
 * in today's part: enough to see a stamp per day and one after a gap.
 */
async function backdate(database, threadId) {
  const { rows } = await database.query(
    'SELECT "id" FROM "messages" WHERE "threadId" = $1 ORDER BY "seq"',
    [threadId],
  );
  const minute = 60_000;
  const now = Date.now();
  const today = Math.min(24, Math.floor(rows.length / 3));
  const earlier = rows.length - today;
  const firstDay = Math.ceil(earlier / 2);
  const times = rows.map((_, index) => {
    if (index < firstDay) return now - 3 * 24 * 60 * minute + index * minute;
    if (index < earlier) return now - 24 * 60 * minute + (index - firstDay) * minute;
    const fromEnd = rows.length - 1 - index;
    return now - (fromEnd < 6 ? fromEnd + 2 : fromEnd + 40) * minute;
  });
  await database.query(
    `UPDATE "messages" AS message SET "createdAt" = stamped.at
     FROM unnest($1::text[], $2::timestamp[]) AS stamped(id, at) WHERE message."id" = stamped.id`,
    [rows.map((row) => row.id), times.map((time) => new Date(time).toISOString())],
  );
}

const modelKey = secret();
let model;
let database;
let postgresStarted = false;
try {
  await mkdir(scratch);
  await mkdir(output, { recursive: true });
  await rm(join(output, "stop"), { force: true });
  await rm(join(output, "fixture.json"), { force: true });
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
      // PostgreSQL resolves a relative socket directory from its private data directory.
      `-h 127.0.0.1 -p ${dbPort}${windows ? "" : " -k ."}`,
      "-w",
    ],
    "Database startup failed",
  );
  postgresStarted = true;
  await command(process.execPath, ["apps/api/dist/cli/migrate-database.js"], "Migration");
  logs = await open(join(directory, "services.log"), "w");
  await server("apps/worker/src/index.ts");
  await server("apps/api/src/index.ts");
  const ready = AbortSignal.timeout(60_000);
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

  const owner = await signup("Owner");
  const observer = await signup("Observer");
  const space = await rpc("spaces/create", { name: "Chat parity fixture" }, owner);
  const asOwner = { ...owner, space: space.id };
  const asObserver = { ...observer, space: space.id };
  const { url } = await rpc("spaces/invites/create", { spaceId: space.id }, owner);
  await rpc("spaces/invites/accept", { token: new URL(url).pathname.split("/").at(-1) }, observer);

  const agent = await rpc("bots/create", { name: "Fixture agent" }, asOwner);
  const support = await rpc("bots/create", { name: "Support agent" }, asOwner);
  const steps = Array.from({ length: 800 }, () => ({
    expect() {},
    response: (request) => ({ type: "text", text: answer(request) }),
  }));
  model = await startModelEmulator({ apiKey: modelKey, steps });
  const connection = {
    provider: model.model.provider,
    modelId: model.model.id,
    baseUrl: model.baseUrl,
    apiKey: modelKey,
    contextWindow: 160_000,
    maxTokens: 4096,
  };
  // A model connection belongs to an account, so each person who writes connects it.
  for (const person of [asOwner, asObserver]) await rpc("models/connect", connection, person);

  const direct = { botId: agent.id };
  for (let note = 1; note <= EXCHANGES; note += 1) {
    await say(asOwner, direct, { text: `Note ${note}` });
  }
  const notes = await upload(
    asOwner,
    direct,
    "launch-notes.txt",
    "text/plain",
    "Launch notes\n\nSynthetic fixture file.\n",
  );
  await say(asOwner, direct, { text: "Here are the launch-notes.", artifactIds: [notes] });
  // The smallest valid PNG: one transparent pixel.
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const picture = await upload(asOwner, direct, "pixel.png", "image/png", pixel);
  await say(asOwner, direct, { artifactIds: [picture], imageHandling: "file" });

  const group = await rpc(
    "groups/create",
    { name: "Fixture discussion", botIds: [agent.id, support.id] },
    asOwner,
  );
  const shared = { groupId: group.id };
  await say(asOwner, shared, {
    text: "@Fixture agent what is the plan?",
    mentions: [{ kind: "bot", id: agent.id }],
  });
  await say(asObserver, shared, { text: "Sounds good to me." });
  const agenda = await upload(
    asOwner,
    shared,
    "agenda.md",
    "text/markdown",
    "# Agenda\n\n- Fixture\n",
  );
  await say(asOwner, shared, {
    text: "@Support agent the agenda is attached.",
    artifactIds: [agenda],
    mentions: [{ kind: "bot", id: support.id }],
  });

  const { Client } = createRequire(join(root, "packages/db/package.json"))("pg");
  database = new Client({ connectionString: env.DATABASE_MIGRATION_URL });
  await database.connect();
  for (const target of [direct, shared]) {
    const { threadId } = await rpc("threads/head", target, asOwner);
    await backdate(database, threadId);
  }
  await database.end();
  database = undefined;

  const person = ({ name, email, password }) => ({ name, email, password });
  await writeFile(
    join(output, "fixture.json"),
    JSON.stringify(
      {
        origin,
        space: { id: space.id, name: space.name },
        owner: person(owner),
        observer: person(observer),
        agent: { id: agent.id, name: agent.name },
        support: { id: support.id, name: support.name },
        group: { id: group.id, name: group.name },
      },
      null,
      2,
    ),
  );
  console.log(`READY ${origin}`);
  while (!existsSync(join(output, "stop"))) {
    if (children.some(({ child }) => child.exitCode !== null))
      throw new Error("API or worker stopped");
    await delay(500);
  }
} finally {
  for (const { child } of children) child.kill();
  await Promise.all(children.map(({ done }) => done));
  const cleanup = await Promise.allSettled([
    database?.end(),
    logs?.close(),
    model?.close(),
    clearDesktopSession(),
    postgresStarted &&
      controlPostgres(["stop", "-D", db, "-m", "immediate", "-w"], "Database shutdown failed"),
  ]);
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  await rm(join(output, "fixture.json"), { force: true });
  for (const result of cleanup) {
    if (result.status === "rejected") {
      console.error(result.reason.message);
      process.exitCode = 1;
    }
  }
}
