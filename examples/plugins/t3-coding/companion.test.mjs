import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { saveOnce } from "./inbox.mjs";
import manifest from "./manifest.json" with { type: "json" };

async function listen(t, handler) {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    try {
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) body += chunk;
      await handler(request, response, JSON.parse(body));
    } catch (error) {
      response.writeHead(500).end();
      t.diagnostic(error.message);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function json(response, body) {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function command(args, session) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./companion.mjs", import.meta.url)), ...args],
    { stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 },
  );
  const result = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    result.stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    result.stderr += chunk;
  });
  child.stdin.end(session);
  const [exitCode] = await once(child, "close");
  return { ...result, exitCode };
}

test("the inbox dispatches only an explicitly selected record and replays its durable receipt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "t3-inbox-fixture-"));
  t.after(() => rm(directory, { recursive: true }));
  const projectId = "fixture-project";
  const title = "Check the fixture tests";
  const brief = "Run the fixture tests and report the result.";
  const olderId = randomUUID();
  const recentId = randomUUID();
  const installationId = "fixture-install";
  const space = "fixture-space";
  const ownerSession = "fixture-owner.signature";
  const t3Token = "fixture-oauth-grant";
  const threadLink = "https://app.t3.codes/threads/fixture-env/fixture-thread";
  const launches = new Map();
  const calls = [];
  const receipts = new Map();
  let failReceipt = true;
  const t3 = await listen(t, (request, response, rpc) => {
    assert.equal(request.url, "/mcp");
    assert.equal(request.headers.authorization, `Bearer ${t3Token}`);
    const result = (value) => json(response, { jsonrpc: "2.0", id: rpc.id, result: value });
    if (rpc.method === "initialize") {
      result({
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-t3", version: "1" },
      });
    } else if (rpc.method === "notifications/initialized") {
      response.writeHead(202).end();
    } else {
      assert.equal(rpc.method, "tools/call");
      assert.equal(rpc.params.name, "t3_thread_launch");
      const args = rpc.params.arguments;
      calls.push(args);
      assert.deepEqual(args, {
        projectId,
        title,
        message: brief,
        runtimeMode: "approval-required",
        interactionMode: "default",
        clientRequestId: args.clientRequestId,
      });
      if (!launches.has(args.clientRequestId)) {
        launches.set(args.clientRequestId, {
          projectId,
          link: threadLink,
          threadId: "fixture-thread",
          runId: "fixture-run",
          status: "starting",
        });
        response.destroy();
        return;
      }
      const entry = launches.get(args.clientRequestId);
      result({
        structuredContent: entry,
        content: [{ type: "text", text: JSON.stringify(entry) }],
      });
    }
  });
  const server = await listen(t, (request, response, { json: input }) => {
    assert.equal(request.headers["x-rakazo-space-id"], space);
    const result = (value) => json(response, { json: value });
    const owner = request.headers.authorization === `Bearer ${ownerSession}`;
    if (request.url === "/rpc/pluginRegistry/installations") {
      const plugin = { slug: "t3-code-inbox", version: 1, status: "approved", manifest };
      result({ items: owner ? [{ id: installationId, plugin }] : [], nextAfter: null });
    } else if (request.url === "/rpc/pluginRegistry/appRecords") {
      assert(owner);
      assert.equal(input.installationId, installationId);
      assert.equal(input.partId, "requests");
      const record = input.after
        ? { id: olderId, values: { title, brief } }
        : {
            id: recentId,
            values: { title: "Another request", brief: "Do not start this request." },
          };
      if (input.after) assert.equal(input.after, recentId);
      result({ items: [record], nextAfter: input.after ? null : recentId, total: null });
    } else {
      assert.equal(request.url, "/rpc/pluginRegistry/addAppRecord");
      assert(owner);
      assert.equal(input.installationId, installationId);
      assert.equal(input.partId, "dispatches");
      assert(launches.has(input.operationId));
      if (failReceipt) {
        failReceipt = false;
        response.writeHead(503).end();
        return;
      }
      const previous = receipts.get(input.operationId);
      if (previous) assert.deepEqual(previous.values, input.values);
      const record = previous ?? { id: randomUUID(), values: input.values };
      receipts.set(input.operationId, record);
      result(record);
    }
  });
  await saveOnce(directory, "t3-auth.json", { url: `${t3}/mcp`, token: t3Token });

  const options = [
    "--server",
    server,
    "--session-stdin",
    "--space",
    space,
    "--installation",
    installationId,
    "--state-dir",
    directory,
  ];
  const start = ["dispatch", ...options, "--record", olderId, "--project", projectId];
  const list = await command(["list", ...options], ownerSession);
  assert.equal(list.exitCode, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).items[0].id, recentId);
  assert.equal(JSON.parse(list.stdout).nextAfter, recentId);
  const noApproval = await command(["dispatch", ...options, "--project", projectId], ownerSession);
  assert.equal(noApproval.exitCode, 1);
  const other = await command(start, "fixture-other.signature");
  assert.equal(other.exitCode, 1);
  assert.match(other.stderr, /unavailable to this account/);
  assert.equal(calls.length, 0);

  const lost = await command(start, ownerSession);
  assert.equal(lost.exitCode, 1);
  assert.match(lost.stderr, /did not return a receipt/);
  assert.equal(launches.size, 1);
  const wrongProject = await command([...start.slice(0, -1), "other-project"], ownerSession);
  assert.equal(wrongProject.exitCode, 1);
  assert.match(wrongProject.stderr, /different dispatch intent/);
  assert.equal(calls.length, 1);

  const failedWrite = await command(start, ownerSession);
  assert.equal(failedWrite.exitCode, 1);
  assert.equal(JSON.parse(failedWrite.stdout).savedToInbox, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  await rm(join(directory, "t3-auth.json"));
  const recovered = await command(start, ownerSession);
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.deepEqual(JSON.parse(recovered.stdout), {
    savedToInbox: true,
    receipt: {
      "request-id": olderId,
      "thread-id": "fixture-thread",
      "run-id": "fixture-run",
      "thread-link": threadLink,
      status: "starting",
    },
  });
  const replay = await command(start, ownerSession);
  assert.equal(replay.exitCode, 0, replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout), JSON.parse(recovered.stdout));
  assert.equal(receipts.size, 1);
  assert.equal(calls.length, 2);
  for (const run of [list, noApproval, other, lost, wrongProject, failedWrite, recovered, replay]) {
    assert(!run.stdout.includes(t3Token) && !run.stderr.includes(t3Token));
    assert(!run.stdout.includes(ownerSession) && !run.stderr.includes(ownerSession));
  }
});
