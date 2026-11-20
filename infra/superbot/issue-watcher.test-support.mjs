import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { hostOverMcp } from "@rakazo/testkit/mcp-host";

const args = {
  owner: "example",
  repo: "project",
  orderBy: "CREATED_AT",
  direction: "DESC",
  fields: ["number"],
  perPage: 100,
};
const link = "https://github.com/example/project/issues/42";
const alert = `New issue: ${link}. Who should take it?`;
const assignment = "Ask the Support agent to prepare a plan for issue #42.";
const brief = `Prepare a plan for ${link}.`;
const plan = "Fixture development plan for issue #42.";
const accepted = "The selected agent received the issue.";
const returned = "The development plan is ready.";

async function until(read, matches, label) {
  const deadline = Date.now() + 30_000;
  do {
    const value = await read();
    if (matches(value)) return value;
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

export async function prepareIssueWatcher(rpc, owner, developer) {
  const target = { templateId: "github-issue-watch", version: 1 };
  const { bot, created } = await rpc("bots/createFromTemplate", target, owner);
  assert(created);
  const watcher = { botId: bot.id };
  assert.equal((await rpc("bots/createFromTemplate", target, owner)).bot.id, bot.id);
  assert.deepEqual(await rpc("routines/list", watcher, owner), []);
  const handoffReplies = new Set();
  const steps = [
    {
      expect(request) {
        const text = request.messages.map((entry) => JSON.stringify(entry.content)).join("\n");
        assert(
          text.includes("Leave the decision with the user"),
          "Expected template instructions in the worker prompt",
        );
        assert(text.includes("New: 42"), "Expected the new issue number from the MCP watch");
      },
      response: { type: "text", text: alert },
    },
    {
      expect(request) {
        assert(JSON.stringify(request.messages).includes(assignment));
        assert(request.tools.some((tool) => tool.function.name === "message_bot"));
      },
      response: {
        type: "tool",
        name: "message_bot",
        id: "call_issue_assignment",
        arguments: { bot_id: developer.id, message: brief, intent: "request" },
      },
    },
    ...Array.from({ length: 3 }, () => ({
      expect() {},
      response(request) {
        const messages = request.messages;
        const last = messages.at(-1);
        const text = JSON.stringify(last.content);
        const reply = last.role === "tool" ? accepted : text.includes(plan) ? returned : plan;
        if (reply === plan) assert(JSON.stringify(messages).includes(brief));
        assert(!handoffReplies.has(reply), `Unexpected repeated handoff reply: ${reply}`);
        handoffReplies.add(reply);
        return { type: "text", text: reply };
      },
    })),
  ];

  async function verify(model, observer, followEvents) {
    const modelPin = { modelProvider: model.provider, modelId: model.id };
    await rpc("bots/update", { ...watcher, ...modelPin }, owner);
    await rpc("bots/update", { botId: developer.id, ...modelPin }, owner);
    const issues = [{ number: 41 }];
    let calls = 0;
    const service = await hostOverMcp(
      {
        kind: "github",
        tools: () => [
          {
            name: "list_issues",
            description: "List repository issues",
            readOnly: true,
            inputSchema: { type: "object", properties: {} },
          },
        ],
        call(name, input) {
          assert.equal(name, "list_issues");
          assert.deepEqual(input, args);
          calls++;
          return { ok: true, data: { issues, pageInfo: { hasNextPage: false } } };
        },
      },
      randomUUID(),
    );
    let notices;
    try {
      const server = await rpc(
        "mcp/servers/create",
        {
          slug: "github",
          name: "GitHub fixture",
          transport: "streamable_http",
          endpoint: service.endpoint,
          secret: service.token,
        },
        owner,
      );
      const grant = (botIds) =>
        rpc("mcp/servers/agents", { id: server.id, allBots: false, botIds }, owner);
      await grant([bot.id]);
      const routine = await rpc(
        "routines/create",
        {
          ...watcher,
          ...modelPin,
          name: "Monitor example/project",
          prompt: "Report new issue numbers for example/project and wait for me.",
          active: true,
          notify: true,
          watch: { kind: "tool", tool: "mcp__github__list_issues", args, track: ["number"] },
        },
        owner,
      );
      const status = async () =>
        (await rpc("routines/list", watcher, owner)).find((r) => r.id === routine.id);
      const outcome = (value) =>
        until(
          async () => {
            const row = await status();
            if (row.watchState?.outcome === "failed" && value !== "failed")
              throw new Error(row.watchState.detail);
            return row;
          },
          (r) => r.watchState?.outcome === value,
          `watch ${value}`,
        );
      const checkNow = async () => {
        for (const active of [false, true])
          await rpc("routines/update", { routineId: routine.id, active }, owner);
      };
      const blocks = async (id) =>
        (await rpc("threads/get", { botId: id }, observer)).messages.flatMap((m) => m.blocks);
      const hasText = (text) => (rows) => rows.some((b) => b.kind === "text" && b.text === text);
      await outcome("baseline");
      assert.equal(calls, 1);
      assert(!(await blocks(bot.id)).some((b) => b.text === alert));
      notices = await followEvents("notifications/subscribe", undefined, owner);
      issues.unshift({ number: 42 });
      await checkNow();
      await outcome("changed");
      await until(() => blocks(bot.id), hasText(alert), "issue alert in shared chat");
      await until(
        () => notices.nextEvent(),
        (event) =>
          event.type === "alert" &&
          event.alert.kind === "completion" &&
          event.alert.botId === bot.id &&
          event.alert.body.includes("42"),
        "owner's issue notification",
      );
      assert(!(await blocks(developer.id)).some((b) => b.fromBotId === bot.id));
      await checkNow();
      await outcome("unchanged");
      assert.equal((await blocks(bot.id)).filter((b) => b.text === alert).length, 1);
      await grant([]);
      const before = calls;
      await checkNow();
      assert.equal((await outcome("failed")).active, false);
      assert.equal(calls, before, "Revoked watch must not call the connector");
      await rpc("threads/send", { ...watcher, text: assignment }, owner);
      await until(
        () => blocks(developer.id),
        (rows) =>
          rows.some(
            (b) => b.kind === "bot_message_received" && b.fromBotId === bot.id && b.text === brief,
          ),
        "chosen agent's task",
      );
      await until(() => blocks(bot.id), hasText(returned), "development agent's reply");
      assert.equal(handoffReplies.size, 3);
      console.log(
        "PASS template instructions, outbound GitHub issue polling, one shared alert, grant revocation and user-selected bot handoff",
      );
    } finally {
      await notices?.close();
      await service.close();
    }
  }
  return { steps, verify };
}
