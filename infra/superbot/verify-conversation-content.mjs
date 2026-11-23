import assert from "node:assert/strict";

import { createRequire } from "node:module";

const requireDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));

export async function checkConversationContent({
  rpc,
  migrationUrl,
  scopedOwner,
  scopedObserver,
  first,
  second,
}) {
  const bot = { botId: first.id };
  const conversations = await rpc("threads/listBotConversations", bot, scopedOwner);
  const [one, two] = conversations.map(({ threadId }) => ({ ...bot, threadId }));
  const defaultThread = await rpc("threads/get", bot, scopedOwner);
  const otherSpace = { ...scopedOwner, space: undefined };
  const inbox = (actor, includeDone = false) => rpc("inbox/list", { includeDone }, actor);
  const library = (target, actor = scopedOwner) => rpc("conversationLibrary/list", target, actor);

  const rows = await inbox(scopedOwner);
  const item = rows.find(({ target }) => target.threadId === one.threadId);
  assert(item);
  assert.equal(item.kind, "result");
  assert.equal(item.state, "unread");
  assert.equal(item.target.kind, "botConversation");
  assert(item.messageId);
  assert(rows.some(({ target }) => target.threadId === two.threadId));
  assert(!(await inbox(scopedObserver)).some(({ id }) => id === item.id));
  assert(!(await inbox(otherSpace)).some(({ id }) => id === item.id));
  await rpc("inbox/setState", { id: item.id, state: "done" }, { ...scopedObserver, status: 404 });
  await rpc("inbox/setState", { id: item.id, state: "done" }, { ...otherSpace, status: 404 });
  for (const state of ["read", "done", "unread"]) {
    await rpc("inbox/setState", { id: item.id, state }, scopedOwner);
    const visible = (await inbox(scopedOwner)).find(({ id }) => id === item.id);
    assert.equal(visible?.state, state === "done" ? undefined : state);
    assert.equal((await inbox(scopedOwner, true)).find(({ id }) => id === item.id)?.state, state);
  }

  const file = await rpc(
    "artifacts/create",
    {
      ...bot,
      name: "thread-proof.txt",
      mimeType: "text/plain",
      contentBase64: "Zml4dHVyZQ==",
    },
    scopedObserver,
  );
  const unrelated = await rpc(
    "artifacts/create",
    {
      ...bot,
      name: "unattached.txt",
      mimeType: "text/plain",
      contentBase64: "Zml4dHVyZQ==",
    },
    scopedObserver,
  );
  const hidden = await rpc(
    "artifacts/create",
    {
      ...bot,
      name: "hidden-app.txt",
      mimeType: "text/plain",
      contentBase64: "Zml4dHVyZQ==",
    },
    scopedOwner,
  );
  const pageId = "library-private-page";
  const messageId = "library-synthetic-reference";
  const blocks = [
    { kind: "file", artifactId: file.id, name: "file", size: 7, mimeType: "text/plain" },
    { kind: "page", pageId, title: "Private fixture page", version: 1 },
    { kind: "file", artifactId: hidden.id, name: "hidden", size: 7, mimeType: "text/html" },
    {
      kind: "app",
      artifactId: hidden.id,
      tool: "Fixture app",
      server: "fixture",
      toolArguments: { private: true },
      toolResult: {},
    },
  ];
  const url = new URL(migrationUrl);
  assert(url.hostname === "127.0.0.1" && url.port && url.username === "fixture");
  const { Client } = requireDb("pg");
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    await client.query('UPDATE "artifacts" SET "mimeType" = $1 WHERE "id" = $2', [
      "text/html;profile=mcp-app",
      hidden.id,
    ]);
    await client.query(
      `INSERT INTO "pages" ("id", "spaceId", "userId", "botId", "title", "updatedAt")
       VALUES ($1, $2, $3, $4, 'Private fixture page', now())`,
      [pageId, scopedOwner.space, scopedOwner.id, first.id],
    );
    await client.query(
      `INSERT INTO "messages" ("id", "threadId", "seq", "role", "blocks", "authorUserId", "botId", "runId", "searchTokens")
       SELECT $1, "id", "nextMessageSeq", 'bot', $2::jsonb, $3, $4, $5, ARRAY[]::integer[]
       FROM "threads" WHERE "id" = $6`,
      [messageId, JSON.stringify(blocks), scopedOwner.id, first.id, item.runId, one.threadId],
    );

    await client.query('UPDATE "runs" SET "status" = $1 WHERE "id" = $2', [
      "waiting_input",
      item.runId,
    ]);
    async function seedQuestion(id) {
      await client.query(
        'UPDATE threads SET "nextMessageSeq" = "nextMessageSeq" + 1 WHERE id = $1',
        [one.threadId],
      );
      await client.query(
        `INSERT INTO "messages" ("id", "threadId", "seq", "role", "blocks", "botId", "runId", "searchTokens")
         SELECT $1, "id", "nextMessageSeq", 'bot', $2::jsonb, $3, $4, ARRAY[]::integer[]
         FROM "threads" WHERE "id" = $5`,
        [
          id,
          JSON.stringify([{ kind: "ask", text: "Private question", status: "pending" }]),
          first.id,
          item.runId,
          one.threadId,
        ],
      );
    }
    await seedQuestion("library-first-question");
    const question = (await inbox(scopedOwner)).find((row) => row.runId === item.runId);
    assert.equal(question?.kind, "question");
    assert.equal(question.messageId, "library-first-question");
    assert(!JSON.stringify(question).includes("Private question"));
    assert(!(await inbox(scopedObserver)).some((row) => row.id === question.id));
    await rpc("inbox/setState", { id: question.id, state: "done" }, scopedOwner);
    assert(!(await inbox(scopedOwner)).some((row) => row.id === question.id));
    await seedQuestion("library-second-question");
    const next = (await inbox(scopedOwner)).find((row) => row.runId === item.runId);
    assert.equal(next?.messageId, "library-second-question");
    assert.equal(next.state, "unread");
    assert.notEqual(next.id, question.id);
    await rpc(
      "inbox/setState",
      { id: question.id, state: "read" },
      { ...scopedOwner, status: 404 },
    );
    await client.query('UPDATE "runs" SET "status" = $1 WHERE "id" = $2', [
      "completed",
      item.runId,
    ]);
  } finally {
    await client.end();
  }
  const contents = await library(one);
  assert.deepEqual(
    new Set(contents.map(({ id }) => id)),
    new Set([file.id, pageId, `${messageId}:3`]),
  );
  const found = contents.find(({ id }) => id === file.id);
  assert.equal(found.authorUserId, scopedObserver.id);
  assert.equal(found.messageId, messageId);
  assert(!contents.some(({ id }) => id === unrelated.id || id === hidden.id));
  assert(!JSON.stringify(contents).includes("toolArguments"));
  assert.deepEqual(
    (await library(one, scopedObserver)).map(({ id }) => id),
    [file.id],
  );
  assert.deepEqual(await library(two), []);
  assert.deepEqual(await library(bot), []);
  assert.equal((await rpc("threads/get", bot, scopedOwner)).threadId, defaultThread.threadId);
  await library({ ...one, botId: second.id }, { ...scopedOwner, status: 404 });
  await library(one, { ...otherSpace, status: 404 });

  console.log(
    "PASS conversation Inbox receipts and Library references preserve member and thread scope",
  );
}
