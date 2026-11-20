import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const alpha = "Alpha fixture private history";
const beta = "Beta fixture private history";
const continuation = "Continue the alpha fixture";
const alphaReply = "Alpha fixture reply";
const betaReply = "Beta fixture reply";
const continuedReply = "Alpha continued fixture reply";

export const conversationSteps = [
  [alpha, alphaReply, [alpha], [beta]],
  [beta, betaReply, [beta], [alpha, alphaReply]],
  [continuation, continuedReply, [continuation, alpha, alphaReply], [beta, betaReply]],
].map(([prompt, text, includes, excludes]) => ({
  expect(request) {
    assert(
      request.messages.some(
        (entry) => entry.role === "user" && JSON.stringify(entry.content).includes(prompt),
      ),
    );
    const context = JSON.stringify(request.messages);
    for (const value of includes) assert(context.includes(value), value);
    for (const value of excludes) assert(!context.includes(value), value);
  },
  response: { type: "text", text },
}));

export async function checkBotConversations({
  rpc,
  post,
  signup,
  space,
  scopedOwner,
  scopedObserver,
  first,
  second,
  chat,
}) {
  const bot = { botId: first.id };
  const direct = await rpc("threads/get", bot, scopedObserver);
  const [one, two] = await Promise.all([
    rpc("threads/createBotConversation", bot, scopedOwner),
    rpc("threads/createBotConversation", bot, scopedObserver),
  ]);
  assert.equal(one.botId, two.botId);
  assert.equal(new Set([one.threadId, two.threadId, direct.threadId]).size, 3);
  const target = (conversation) => ({ ...bot, threadId: conversation.threadId });
  const a = target(one);
  const b = target(two);
  assert.deepEqual(
    new Set(
      (await rpc("threads/listBotConversations", bot, scopedObserver)).map(
        ({ threadId }) => threadId,
      ),
    ),
    new Set([a.threadId, b.threadId]),
  );
  const empty = await rpc("threads/get", a, scopedObserver);
  assert.deepEqual(empty.messages, []);
  assert.deepEqual((await rpc("threads/get", b, scopedOwner)).messages, []);

  for (const [threadId, prompt, reply] of [
    [a.threadId, alpha, alphaReply],
    [b.threadId, beta, betaReply],
    [a.threadId, continuation, continuedReply],
  ]) {
    await chat({ threadId, prompt, reply });
  }

  const texts = (page) =>
    page.messages.flatMap(({ blocks }) => blocks.map(({ text }) => text).filter(Boolean));
  assert.deepEqual(texts(await rpc("threads/get", a, scopedObserver)), [
    alpha,
    alphaReply,
    continuation,
    continuedReply,
  ]);
  assert.deepEqual(texts(await rpc("threads/get", b, scopedObserver)), [beta, betaReply]);
  assert.deepEqual(await rpc("threads/get", bot, scopedObserver), direct);
  await rpc(
    "threads/get",
    { botId: second.id, threadId: a.threadId },
    { ...scopedOwner, status: 404 },
  );
  await rpc("threads/get", { ...bot, threadId: direct.threadId }, { ...scopedOwner, status: 404 });
  const outsider = { ...(await signup("ConversationOutsider")), space, status: 401 };
  await rpc("threads/get", a, outsider);
  await rpc("threads/messages", a, outsider);
  await rpc("threads/listBotConversations", bot, outsider);
  await rpc("threads/createBotConversation", bot, outsider);
  await rpc("threads/send", { ...a, text: alpha }, outsider);
  await post("/rpc/threads/subscribe", { json: { ...a, cursor: empty.cursor } }, outsider);

  const operationId = randomUUID();
  const local = { operationId, text: "Local fixture message", reply: "Local fixture answer" };
  await rpc("threads/appendLocalHistory", { ...a, ...local }, outsider);
  const savedA = await rpc("threads/appendLocalHistory", { ...a, ...local }, scopedObserver);
  const savedB = await rpc("threads/appendLocalHistory", { ...b, ...local }, scopedObserver);
  assert.deepEqual(
    await rpc("threads/appendLocalHistory", { ...a, ...local }, scopedObserver),
    savedA,
  );
  assert(savedA.messageIds.every((id) => !savedB.messageIds.includes(id)));

  const stream = await post(
    "/rpc/threads/subscribe",
    { json: { ...a, cursor: empty.cursor } },
    scopedObserver,
  );
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    let pending = "";
    let sawHostedReply = false;
    let sawLocalReply = false;
    while (!sawLocalReply || !sawHostedReply) {
      const { value, done } = await reader.read();
      assert(!done, "Conversation catch-up ended early");
      pending += value.replaceAll("\r\n", "\n");
      const frames = pending.split("\n\n");
      pending = frames.pop();
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        const event = data && JSON.parse(data.slice(6)).json;
        if (!event || event.type === "heartbeat") continue;
        assert.equal(event.threadId, a.threadId);
        if (event.type !== "thread.message.created") continue;
        const { blocks, messageId } = event.payload;
        if (blocks.some(({ text }) => text === continuedReply)) sawHostedReply = true;
        if (messageId === savedA.messageIds[1]) sawLocalReply = true;
        assert(!savedB.messageIds.includes(messageId));
      }
    }
  } finally {
    await reader.cancel();
  }

  const append = "threads/appendLocalHistory";
  for (let i = 0; i < 49; i++) {
    await rpc(append, { ...b, ...local, operationId: randomUUID() }, scopedOwner);
  }
  const latest = await rpc("threads/messages", b, scopedObserver);
  assert.equal(latest.messages.length, 100);
  assert.notEqual(latest.olderCursor, null);
  const older = await rpc("threads/messages", { ...b, before: latest.olderCursor }, scopedObserver);
  assert.equal(older.threadId, b.threadId);
  assert.deepEqual(texts(older), [beta, betaReply]);
  const update = "threads/updateBotConversation";
  const readRows = (caller) => rpc("threads/listBotConversations", bot, caller);
  const row = async (caller, selected) =>
    (await readRows(caller)).find(({ threadId }) => threadId === selected.threadId);

  const archivedHistory = await rpc("threads/get", a, scopedOwner);
  await Promise.all([
    rpc(update, { ...a, title: "  Fixture shared title  " }, scopedObserver),
    rpc(update, { ...a, pinned: true }, scopedOwner),
  ]);
  const pinned = await row(scopedObserver, a);
  assert.equal(pinned.title, "Fixture shared title");
  assert(pinned.pinnedAt);
  assert.equal(pinned.preview, local.reply);
  assert.deepEqual(await row(scopedOwner, a), pinned);
  assert.equal((await row(scopedOwner, b)).pinnedAt, null);
  const pinnedAgain = await rpc(update, { ...a, pinned: true }, scopedObserver);
  assert.equal(pinnedAgain.pinnedAt, pinned.pinnedAt);

  await rpc(
    append,
    { ...b, operationId: randomUUID(), text: `**${"preview ".repeat(50)}end**` },
    scopedObserver,
  );
  const sibling = await row(scopedOwner, b);
  assert.equal(sibling.preview, "preview ".repeat(20));
  assert(!sibling.archivedAt);

  const archived = await rpc(update, { ...a, archived: true }, scopedObserver);
  assert(archived.archivedAt);
  assert.deepEqual(await row(scopedOwner, a), archived);
  assert.equal((await rpc("threads/head", a, scopedOwner)).threadId, a.threadId);
  assert.deepEqual(
    (await rpc("threads/get", a, scopedObserver)).messages,
    archivedHistory.messages,
  );
  assert.deepEqual(
    (await rpc("threads/messages", a, scopedOwner)).messages,
    archivedHistory.messages,
  );
  const archiveStream = await post(
    "/rpc/threads/subscribe",
    { json: { ...a, cursor: empty.cursor } },
    scopedObserver,
  );
  await archiveStream.body.cancel();

  const missing = { ...scopedOwner, status: 404 };
  await rpc("threads/send", { ...a, text: "Archived hosted send" }, missing);
  await rpc("threads/followUp", { ...a, text: "Archived follow-up" }, missing);
  await rpc(append, { ...a, ...local, operationId: randomUUID() }, missing);
  await rpc("threads/clear", a, missing);
  await rpc(update, { ...bot, threadId: direct.threadId, archived: true }, missing);
  await rpc(update, { ...a, botId: second.id, title: "Wrong bot" }, missing);
  await rpc(update, { ...a, title: "   " }, { ...scopedOwner, status: 400 });
  await rpc(update, { ...a, archived: false }, outsider);

  const restored = await rpc(update, { ...a, archived: false, pinned: false }, scopedOwner);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.pinnedAt, null);
  assert.equal(restored.title, pinned.title);
  assert.deepEqual(await row(scopedObserver, a), restored);
  assert.deepEqual(await row(scopedOwner, b), sibling);
  assert.deepEqual(await rpc("threads/get", bot, scopedObserver), direct);
  assert.deepEqual(
    (await rpc("threads/get", a, scopedObserver)).messages,
    archivedHistory.messages,
  );
  const resumed = await rpc(
    append,
    { ...a, operationId: randomUUID(), text: "Restored local note" },
    scopedObserver,
  );
  assert.equal(resumed.messageIds.length, 1);
  assert.equal((await row(scopedOwner, a)).preview, "Restored local note");
  console.log(
    "PASS shared sibling rename, pin, archive, restore, safe previews, and default chat protection",
  );
  console.log(
    "PASS independent bot conversations preserve hosted context, local turns, paging, reconnect, and Space authorization",
  );
}
