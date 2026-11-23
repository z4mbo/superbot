import assert from "node:assert/strict";

export async function checkSearch({
  rpc,
  signup,
  space,
  scopedOwner,
  scopedObserver,
  first,
  group,
}) {
  const search = async (q, actor) => (await rpc("search/query", { q }, actor)).hits;
  const messages = (hits) => hits.filter(({ kind }) => kind === "message");
  const conversations = await rpc("threads/listBotConversations", { botId: first.id }, scopedOwner);

  const [direct] = messages(await search("response is blue", scopedObserver));
  assert.equal(direct?.botId, first.id);
  assert.equal(direct.threadId, undefined);
  const firstThread = await rpc("threads/get", { botId: first.id }, scopedObserver);
  assert(firstThread.messages.some(({ id }) => id === direct.messageId));

  const [other] = messages(await search("Alpha continued fixture reply", scopedObserver));
  assert.equal(other?.botId, first.id);
  assert(conversations.some(({ threadId }) => threadId === other.threadId));
  const otherThread = await rpc(
    "threads/get",
    { botId: first.id, threadId: other.threadId },
    scopedObserver,
  );
  assert(otherThread.messages.some(({ id }) => id === other.messageId));
  assert(!firstThread.messages.some(({ id }) => id === other.messageId));

  const [shared] = messages(await search("response is green", scopedOwner));
  assert.equal(shared?.groupId, group.id);
  assert.equal(shared.threadId, undefined);

  const elsewhere = await search("Alpha continued fixture reply", {
    ...scopedOwner,
    space: undefined,
  });
  assert(!elsewhere.some(({ botId }) => botId === first.id));
  const outsider = { ...(await signup("SearchOutsider")), space, status: 401 };
  await rpc("search/query", { q: "Alpha continued fixture reply" }, outsider);
  console.log(
    "PASS Space search found messages in the first, an additional and a group conversation for members only",
  );
}
