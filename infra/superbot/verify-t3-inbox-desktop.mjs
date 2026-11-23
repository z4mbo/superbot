import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { startFakeT3 } from "./fake-t3.test-support.mjs";

const exec = promisify(execFile);
const bundled = "superbot-t3-code-inbox-v1";
const proposePrompt = "Propose coding work: add a regression test for the empty input case.";
const proposeReply = "I proposed the request. The operator can start it from the T3 Code inbox.";
const proposed = {
  title: "Add an empty input regression test",
  brief:
    "Add a regression test for the empty input case in the parser. Run the parser tests and report the result.",
};
const typed = {
  title: "Tidy the README setup section",
  brief: "Shorten the setup section of the README and check that every command still runs.",
};

/**
 * The bundled T3 Code inbox in the desktop fixture: a granted bot proposes a request through
 * the worker's app tool, a person adds another, and the operator starts one from the desktop
 * against a loopback T3 that implements T3's OAuth and MCP tools.
 */
export async function prepareT3Inbox({ rpc, followThread, owner, ownerId, origin, grantedBot }) {
  const { id: installationId, plugin } = await rpc(
    "pluginRegistry/install",
    { versionId: bundled },
    owner,
  );
  assert.equal(plugin.slug, "t3-code-inbox");
  assert.equal(plugin.status, "approved");
  await rpc(
    "pluginRegistry/setGrants",
    { installationId, botId: grantedBot.id, partIds: ["requests", "request-guide"] },
    owner,
  );
  await rpc("autoReview/set", { mode: "ask" }, owner);
  const records = (partId) =>
    rpc("pluginRegistry/appRecords", { installationId, partId, limit: 50 }, owner);

  const steps = [
    {
      expect(request) {
        assert(
          request.messages.some(
            ({ role, content }) =>
              role === "user" && JSON.stringify(content).includes(proposePrompt),
          ),
        );
        assert(
          !request.tools.some(({ function: tool }) =>
            tool.name.startsWith("marketplace__add_record_dispatches_"),
          ),
          "The bot is never offered the operator's receipts",
        );
      },
      response(request) {
        const tool = request.tools.find(({ function: info }) =>
          info.name.startsWith("marketplace__add_record_requests_"),
        );
        assert(tool, "The granted bot can propose a request");
        return {
          type: "tool",
          id: "fixture_t3_propose",
          name: tool.function.name,
          arguments: { values: proposed },
        };
      },
    },
    { expect() {}, response: { type: "text", text: proposeReply } },
  ];

  let fake;
  return {
    steps,
    /** The bot proposes a request and the owner approves the write card. */
    async propose() {
      const bot = { botId: grantedBot.id };
      const { cursor } = await rpc("threads/get", bot, owner);
      const { nextEvent, close } = await followThread(bot, owner, cursor);
      try {
        const { runId } = await rpc("threads/send", { ...bot, text: proposePrompt }, owner);
        for (;;) {
          const event = await nextEvent();
          if (event?.runId !== runId) continue;
          if (event.type === "run.completed" || event.type === "run.failed") {
            assert.equal(event.type, "run.completed");
            break;
          }
          if (event.type !== "thread.message.created") continue;
          const card = event.payload.blocks.find(
            ({ kind, approvalEffectId }) => kind === "ask" && approvalEffectId,
          );
          if (card) {
            assert.equal(
              (await records("requests")).items.length,
              0,
              "Nothing is saved before approval",
            );
            await rpc(
              "threads/answer",
              { ...bot, runId, messageId: event.payload.messageId, answer: "allow" },
              owner,
            );
          }
        }
      } finally {
        await close();
      }
      await rpc(
        "pluginRegistry/addAppRecord",
        { installationId, partId: "requests", operationId: randomUUID(), values: typed },
        owner,
      );
      const { items } = await records("requests");
      assert.deepEqual(
        items.map(({ values }) => values),
        [typed, proposed],
      );
      console.log(
        "PASS a granted bot proposed a coding request after the owner approved its write card",
      );
      fake = await startFakeT3();
      console.log(`Fixture T3 MCP URL: ${fake.url}`);
      console.log(
        "In the desktop: Store > Installed > T3 Code inbox > Open, connect T3, pick a project, start one request.",
      );
    },
    /** After the desktop closed: one thread per started request, one receipt each, safe replays. */
    async check() {
      try {
        const requests = (await records("requests")).items;
        const receipts = (await records("dispatches")).items;
        const launches = fake.launches();
        assert(receipts.length >= 1, "Start a request from the desktop before closing it");
        assert.equal(fake.seen.registrations[0]?.client_name, "Superbot T3 Code inbox");
        const operations = new Set(launches.map(({ args }) => args.clientRequestId));
        assert.equal(operations.size, receipts.length, "one T3 request ID per started request");
        assert.equal(
          fake.emulator.threads.size,
          receipts.length,
          "one T3 thread per started request",
        );
        for (const receipt of receipts) {
          const request = requests.find(({ id }) => id === receipt.values["request-id"]);
          assert(request, "a receipt names a request in the inbox");
          const launch = launches.find(
            ({ args }) =>
              fake.emulator.threads.get(receipt.values["thread-id"])?.title === args.title,
          );
          assert.deepEqual(launch.args, {
            projectId: launch.args.projectId,
            title: request.values.title,
            message: request.values.brief,
            runtimeMode: "approval-required",
            interactionMode: "default",
            clientRequestId: launch.args.clientRequestId,
          });
          const thread = fake.emulator.threads.get(receipt.values["thread-id"]);
          assert.equal(thread.projectId, launch.args.projectId);
          assert.equal(
            receipt.values["thread-link"],
            `https://app.example.test/threads/env-1/${thread.threadId}`,
          );
          const replay = await rpc(
            "pluginRegistry/addAppRecord",
            {
              installationId,
              partId: "dispatches",
              operationId: launch.args.clientRequestId,
              values: receipt.values,
            },
            owner,
          );
          assert.equal(replay.id, receipt.id, "replaying a receipt returns the saved record");
          await rpc(
            "pluginRegistry/addAppRecord",
            {
              installationId,
              partId: "dispatches",
              operationId: launch.args.clientRequestId,
              values: { ...receipt.values, status: "completed" },
            },
            { ...owner, status: 409 },
          );
        }
        assert.equal((await records("dispatches")).items.length, receipts.length);
        console.log(
          "PASS the desktop started the confirmed request once in T3, saved its receipt, and refused a conflicting receipt",
        );
      } finally {
        fake?.close();
        await exec("cmdkey.exe", [
          `/delete:${origin}/ ${ownerId}.com.superbot.t3-code-inbox`,
        ]).catch(() => {});
      }
    },
  };
}
