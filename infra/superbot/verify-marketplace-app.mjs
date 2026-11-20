import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const date = "2026-01-20";
const breakfast = { meal: "Fixture breakfast", kcal: 480, date };
const snack = { meal: "Fixture snack", kcal: 220, date };
const listPrompt = "Read today's fixture kcal total.";
const addPrompt = "Add the fixture snack to my meal diary.";
const ungrantedPrompt = "Try the meal diary from the other fixture bot.";
const stalePrompt = "Add a second fixture snack to my meal diary.";
const revokedPrompt = "Try the meal diary after access was removed.";
const listReply = "The fixture total is 480 kcal.";
const addReply = "The fixture snack is recorded.";
const blockedReply = "The fixture meal diary is unavailable.";

function expectPrompt(request, prompt) {
  assert(
    request.messages.some(
      ({ role, content }) => role === "user" && JSON.stringify(content).includes(prompt),
    ),
    prompt,
  );
}

function toolResult(request, id) {
  const result = request.messages.find(({ tool_call_id }) => tool_call_id === id);
  assert(result, `Missing worker tool result for ${id}`);
  const content = typeof result.content === "string" ? result.content : result.content[0].text;
  return JSON.parse(content);
}

export async function prepareMarketplaceApp({
  rpc,
  followThread,
  owner,
  publisher,
  grantedBot,
  otherBot,
}) {
  const partId = "meals";
  const { id: versionId } = await rpc(
    "pluginRegistry/submit",
    {
      slug: "fixture-meal-diary",
      version: 1,
      manifest: {
        schemaVersion: 1,
        name: "Fixture meal diary",
        description: "Keep meal names, dates, and calorie totals.",
        parts: [
          {
            id: partId,
            kind: "app",
            fields: [
              { id: "meal", label: "Meal", type: "text", required: true },
              { id: "kcal", label: "Calories", type: "number", required: true },
              { id: "date", label: "Date", type: "date", required: true },
            ],
            summaryField: "kcal",
          },
        ],
      },
    },
    publisher,
  );
  await rpc("pluginRegistry/review", { versionId, decision: "approved" }, owner);
  const { id: installationId } = await rpc("pluginRegistry/install", { versionId }, owner);
  const target = { installationId, partId };
  const record = await rpc(
    "pluginRegistry/addAppRecord",
    { ...target, values: breakfast, operationId: randomUUID() },
    owner,
  );
  await rpc(
    "pluginRegistry/addAppRecord",
    { ...target, values: { ...breakfast, date: "2026-01-19" }, operationId: randomUUID() },
    owner,
  );
  const setGrant = (partIds) =>
    rpc("pluginRegistry/setGrants", { installationId, botId: grantedBot.id, partIds }, owner);
  await setGrant([partId]);
  await rpc("autoReview/set", { mode: "ask" }, owner);

  let listTool;
  let snackId;
  const tool = (request, prefix) => {
    const matching = request.tools.filter(({ function: info }) => info.name.startsWith(prefix));
    assert.equal(matching.length, 1, `Expected one app tool matching ${prefix}`);
    return matching[0].function.name;
  };
  const expectBlocked = (request, id) => {
    const result = request.messages.find(({ tool_call_id }) => tool_call_id === id);
    assert(result, "The worker must return a refusal for an unavailable app tool");
    assert(!JSON.stringify(result.content).includes(breakfast.meal));
    assert(!JSON.stringify(result.content).includes("total"));
  };
  const expectNotOffered = (request) => {
    assert(!request.tools.some(({ function: info }) => info.name === listTool));
    assert(
      !request.tools.some(({ function: info }) =>
        info.name.startsWith("marketplace__add_record_meals_"),
      ),
    );
  };
  const blockedSteps = (prompt, id) => [
    {
      expect(request) {
        expectPrompt(request, prompt);
        expectNotOffered(request);
      },
      response: () => ({ type: "tool", id, name: listTool, arguments: { date } }),
    },
    {
      expect: (request) => expectBlocked(request, id),
      response: { type: "text", text: blockedReply },
    },
  ];
  const proposeAdd = (prompt, id) => ({
    expect: (request) => expectPrompt(request, prompt),
    response: (request) => ({
      type: "tool",
      id,
      name: tool(request, "marketplace__add_record_meals_"),
      arguments: { values: snack },
    }),
  });
  const steps = [
    {
      expect: (request) => expectPrompt(request, listPrompt),
      response(request) {
        listTool = tool(request, "marketplace__list_records_meals_");
        return { type: "tool", id: "fixture_meal_list", name: listTool, arguments: { date } };
      },
    },
    {
      expect(request) {
        assert.deepEqual(toolResult(request, "fixture_meal_list"), {
          items: [record],
          total: 480,
          nextAfter: null,
        });
      },
      response: { type: "text", text: listReply },
    },
    proposeAdd(addPrompt, "fixture_meal_add"),
    {
      expect(request) {
        const result = toolResult(request, "fixture_meal_add");
        assert.deepEqual(result.values, snack);
        snackId = result.id;
        assert(snackId);
      },
      response: { type: "text", text: addReply },
    },
    ...blockedSteps(ungrantedPrompt, "fixture_meal_ungranted"),
    proposeAdd(stalePrompt, "fixture_meal_stale"),
    {
      expect(request) {
        expectPrompt(request, stalePrompt);
        expectNotOffered(request);
      },
      response: { type: "text", text: blockedReply },
    },
    ...blockedSteps(revokedPrompt, "fixture_meal_revoked"),
  ];

  const read = () => rpc("pluginRegistry/appRecords", { ...target, date }, owner);
  async function checkAdd(text, beforeApproval, reply, outcome = "run.completed") {
    const bot = { botId: grantedBot.id };
    const { cursor } = await rpc("threads/get", bot, owner);
    const { nextEvent, close } = await followThread(bot, owner, cursor);
    try {
      const { runId } = await rpc("threads/send", { ...bot, text }, owner);
      let answered = false;
      let sawReply = false;
      for (;;) {
        const event = await nextEvent();
        if (event?.runId !== runId) continue;
        if (event.type === "run.completed" || event.type === "run.failed") {
          assert.equal(event.type, outcome, text);
          break;
        }
        if (event.type !== "thread.message.created") continue;
        const { messageId, blocks } = event.payload;
        const card = blocks.find(
          ({ kind, approvalEffectId }) => kind === "ask" && approvalEffectId,
        );
        if (card) {
          assert(!answered, "Expected one approval card");
          assert.deepEqual(
            card.actions.map(({ id }) => id),
            ["allow", "deny"],
          );
          await beforeApproval();
          await rpc("threads/answer", { ...bot, runId, messageId, answer: "allow" }, owner);
          answered = true;
        }
        if (blocks.some(({ kind, text }) => kind === "text" && text === reply)) sawReply = true;
      }
      assert(answered && sawReply, "Expected a completed approval and reply");
    } finally {
      await close();
    }
  }
  return {
    steps,
    async verify(chat) {
      await chat({ agent: grantedBot, prompt: listPrompt, reply: listReply });
      await checkAdd(
        addPrompt,
        async () => assert.deepEqual((await read()).items, [record]),
        addReply,
      );
      const updated = await read();
      assert.equal(updated.total, 700);
      assert.equal(updated.items.length, 2);
      assert.deepEqual(updated.items.find(({ id }) => id === snackId)?.values, snack);

      await chat({ agent: otherBot, prompt: ungrantedPrompt, reply: blockedReply });
      await checkAdd(stalePrompt, () => setGrant([]), blockedReply, "run.failed");
      assert.deepEqual(await read(), updated);
      await chat({ agent: grantedBot, prompt: revokedPrompt, reply: blockedReply });
      assert.deepEqual(await read(), updated);
      console.log(
        "PASS app records were shared between RPC and the granted bot. Ungranted tools and approval after revocation left records unchanged.",
      );
    },
  };
}
