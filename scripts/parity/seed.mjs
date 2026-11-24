#!/usr/bin/env node
// Seeds a running dev server with the roster and conversations a parity fixture describes, so the
// capture script can photograph the same screens as the reference app.
//
//   PARITY_BASE_URL=http://127.0.0.1:5183 \
//   PARITY_FIXTURE=scripts/parity/fixture.example.json \
//   DATABASE_MIGRATION_URL=postgres://… node scripts/parity/seed.mjs
//
// Use a database of its own (never a shared dev database): the script writes rows directly,
// creates one account, and replaces that account's bots and messages on every run.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(path.join(root, "apps/web/package.json"))("@playwright/test");
const { Client } = createRequire(path.join(root, "packages/db/package.json"))("pg");

const baseURL = process.env.PARITY_BASE_URL ?? "http://127.0.0.1:5183";
const fixturePath = path.resolve(
  process.env.PARITY_FIXTURE ?? path.join(root, "scripts/parity/fixture.example.json"),
);
const databaseUrl = process.env.DATABASE_MIGRATION_URL;
if (!databaseUrl) throw new Error("Set DATABASE_MIGRATION_URL to the fixture database.");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const chrome = process.env.PARITY_CHROME ?? "/run/current-system/sw/bin/google-chrome";

const cuid = () =>
  `c${randomBytes(18)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "a")
    .slice(0, 24)}`;

/** "today 13:31" or "-1d 09:05" → a Date relative to now, so separators read "Today 1:31 PM". */
function at(spec, fallback) {
  if (!spec) return fallback;
  const match = /^(today|-(\d+)d)\s+(\d{1,2}):(\d{2})$/.exec(spec);
  if (!match) return new Date(spec);
  const date = new Date();
  if (match[2]) date.setDate(date.getDate() - Number(match[2]));
  date.setHours(Number(match[3]), Number(match[4]), 0, 0);
  return date;
}

const browser = await chromium.launch({ executablePath: chrome });
const context = await browser.newContext({ baseURL });
const page = await context.newPage();
const { email, password, name } = fixture.user;

let response = await page.request.post("/api/auth/sign-in/email", {
  data: { email, password },
  headers: { origin: new URL(baseURL).origin },
});
if (!response.ok()) {
  response = await page.request.post("/api/auth/sign-up/email", {
    data: { email, password, name },
    headers: { origin: new URL(baseURL).origin },
  });
  if (!response.ok()) throw new Error(`sign-up ${response.status()}: ${await response.text()}`);
}

async function rpc(procedure, body) {
  const result = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  const parsed = await result.json();
  if (!result.ok() || parsed.error) {
    throw new Error(`${procedure} ${result.status()}: ${JSON.stringify(parsed.error ?? parsed)}`);
  }
  return parsed.json;
}

// Onboarding creates the space and the first bot; walk it like a person would.
await page.goto("/onboarding");
await page.waitForURL(/\/(workspaces|onboarding|app)/, { timeout: 30_000 });
for (let attempt = 0; attempt < 40 && !/\/app\//.test(page.url()); attempt += 1) {
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  const open = page.getByRole("button", { name: /^Open / }).first();
  if (await skip.isVisible().catch(() => false)) await skip.click();
  else if (await open.isVisible().catch(() => false)) await open.click();
  await page.waitForTimeout(500);
}
if (!/\/app\//.test(page.url())) throw new Error(`onboarding did not reach the app: ${page.url()}`);

const me = await rpc("me", {});
const spaceId = me.spaceId;
const userId = me.id ?? me.userId;
const db = new Client({ connectionString: databaseUrl });
await db.connect();
// The account keeps the fixture's display name, so screenshots never show another one.
await db.query(`UPDATE "user" SET name = $2 WHERE id = $1`, [userId, name]);

const firstBot = await db.query(
  `SELECT id FROM bots WHERE "spaceId" = $1 AND "spawnKey" = 'onboarding:first'`,
  [spaceId],
);
const mainBotId = firstBot.rows[0]?.id;
// Start from a clean roster: everything but the first bot goes, and its history with it.
await db.query(`DELETE FROM bots WHERE "spaceId" = $1 AND id <> $2`, [spaceId, mainBotId]);
await db.query(`DELETE FROM bot_sections WHERE "spaceId" = $1`, [spaceId]);
await db.query(`DELETE FROM runs WHERE "spaceId" = $1`, [spaceId]);

const sectionIds = new Map();
for (const [position, sectionName] of (fixture.sections ?? []).entries()) {
  const id = cuid();
  await db.query(
    `INSERT INTO bot_sections (id, "spaceId", "userId", name, position, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, now(), now())`,
    [id, spaceId, userId, sectionName, position],
  );
  sectionIds.set(sectionName, id);
}

const base = Date.now() - 60 * 60 * 1000;
for (const [index, spec] of fixture.bots.entries()) {
  let botId = mainBotId;
  if (!spec.main) {
    const created = await rpc("bots/create", { name: spec.name, computerMode: "team" });
    botId = created.id;
  }
  const updatedAt = at(spec.updatedAt, new Date(base - index * 60_000));
  await db.query(
    `UPDATE bots SET name = $2, "sectionId" = $3, pinned = $4, "lookShape" = $5, "lookColor" = $6,
       position = $7, "updatedAt" = $8, "modelProvider" = $9, "modelId" = $10, "thinkingLevel" = $11
     WHERE id = $1`,
    [
      botId,
      spec.name,
      spec.section ? sectionIds.get(spec.section) : null,
      Boolean(spec.pinned),
      spec.shape ?? null,
      spec.color ?? null,
      index,
      updatedAt,
      spec.model?.provider ?? null,
      spec.model?.id ?? null,
      spec.model?.thinking ?? null,
    ],
  );
  const thread = await db.query(`SELECT id FROM threads WHERE "botId" = $1`, [botId]);
  const threadId = thread.rows[0].id;
  await db.query(`DELETE FROM messages WHERE "threadId" = $1`, [threadId]);
  await db.query(`DELETE FROM events WHERE "threadId" = $1`, [threadId]);
  const messages = spec.messages ?? (spec.preview ? [{ role: "bot", text: spec.preview }] : []);
  let seq = 0;
  const ids = new Map();
  let clock = new Date(updatedAt.getTime() - messages.length * 60_000);
  for (const message of messages) {
    const id = cuid();
    clock = at(message.at, new Date(clock.getTime() + 20_000));
    await db.query(
      `INSERT INTO messages (id, "threadId", seq, role, blocks, "botId", "authorUserId", "replyToMessageId", "replyQuote", "createdAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        id,
        threadId,
        seq,
        message.role,
        JSON.stringify([{ kind: "text", text: message.text }]),
        message.role === "bot" ? botId : null,
        message.role === "user" ? userId : null,
        message.replyTo ? ids.get(message.replyTo) : null,
        message.quote ?? null,
        clock,
      ],
    );
    if (message.key) ids.set(message.key, id);
    seq += 1;
  }
  await db.query(`UPDATE threads SET "nextMessageSeq" = $2 WHERE id = $1`, [threadId, seq]);
  await db.query(
    `INSERT INTO thread_reads ("threadId", "userId", "spaceId", unread, "lastReadSeq")
     VALUES ($1, $2, $3, false, $4)
     ON CONFLICT ("threadId", "userId") DO UPDATE SET unread = false, "lastReadSeq" = $4`,
    [threadId, userId, spaceId, seq - 1],
  );
  if (spec.working) {
    // A run that is mid-work, with a lease far in the future so no sweep reclaims it, keeps the
    // bot's working state on screen while the capture runs.
    const taskId = cuid();
    await db.query(
      `INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'fixture', 'running', now(), now())`,
      [taskId, spaceId, botId, threadId, userId],
    );
    await db.query(
      `INSERT INTO runs (id, "spaceId", "botId", "threadId", "taskId", "userId", status, trigger,
         "leaseOwner", "leaseExpiresAt", "startedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'running', 'user', 'parity-fixture', now() + interval '1 day', now(), now(), now())`,
      [cuid(), spaceId, botId, threadId, taskId, userId],
    );
  }
  spec.id = botId;
}

// Exactly the fixture's extra workspaces, so Settings has more than one to choose between only
// when asked: with two or more, the roster names each workspace in its section headings.
const wantedWorkspaces = new Set(fixture.workspaces ?? []);
const listed = await rpc("spaces/list", {});
for (const space of listed.spaces) {
  if (space.id !== spaceId && space.canDelete && !wantedWorkspaces.has(space.name)) {
    await rpc("spaces/remove", { spaceId: space.id });
  }
}
for (const workspaceName of wantedWorkspaces) {
  if (!listed.spaces.some((space) => space.name === workspaceName)) {
    await rpc("spaces/create", { name: workspaceName });
  }
}

// A new bot starts an introduction run; with no model behind the fixture those would stay open.
await db.query(
  `DELETE FROM runs WHERE "spaceId" = $1 AND "leaseOwner" IS DISTINCT FROM 'parity-fixture'`,
  [spaceId],
);
await db.query(
  `DELETE FROM tasks t WHERE t."spaceId" = $1 AND NOT EXISTS (SELECT 1 FROM runs r WHERE r."taskId" = t.id)`,
  [spaceId],
);
await db.end();
await browser.close();
process.stdout.write(
  `${JSON.stringify({ spaceId, bots: Object.fromEntries(fixture.bots.map((bot) => [bot.key ?? bot.name, bot.id])) }, null, 2)}\n`,
);
