import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { startFakeT3 } from "./fake-t3.mjs";

const [probe] = process.argv.slice(2);
assert(probe, "Usage: node --import tsx infra/superbot/verify-t3-inbox.mjs T3_INBOX_PROBE_EXE");

const fake = await startFakeT3();
const directory = await mkdtemp(join(tmpdir(), "t3-inbox-probe-"));
const child = spawn(resolve(probe), [], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const transcript = [];
async function ask(command) {
  child.stdin.write(`${JSON.stringify(command)}\n`);
  const { value } = await lines.next();
  transcript.push(value);
  return JSON.parse(value);
}

const scope = {
  server: "http://127.0.0.1:1",
  space: "space-fixture",
  installation: "install-fixture",
  dir: directory,
};
const request = (record, overrides = {}) => ({
  cmd: "start",
  ...scope,
  record,
  project: "project-demo",
  title: "Add a regression test",
  brief: "Cover the empty input case and run the relevant tests.",
  ...overrides,
});
const launches = () => fake.launches();

try {
  const signedIn = await ask({ cmd: "sign_in", url: fake.url });
  assert.equal(signedIn.ok, true, signedIn.message);
  assert.equal(signedIn.place, new URL(fake.url).host);
  assert.equal(fake.seen.registrations[0].client_name, "Superbot T3 Code inbox");
  assert.deepEqual(fake.seen.registrations[0].grant_types, ["authorization_code"]);
  assert.equal(fake.seen.tokens, 1);
  console.log(
    "PASS the desktop bridge signed in with T3 OAuth: registration, PKCE S256 and a loopback callback",
  );

  const listed = await ask({ cmd: "projects" });
  assert.deepEqual(
    listed.projects.map(({ id }) => id),
    ["project-other", "project-demo"],
  );

  const first = randomUUID();
  fake.emulator.loseNextResponse = true;
  const lost = await ask(request(first));
  assert.equal(lost.kind, "NoReply");
  assert.equal(launches().length, 1);
  const retried = await ask(request(first));
  assert.equal(retried.ok, true, retried.message);
  assert.equal(launches().length, 2);
  assert.equal(fake.emulator.threads.size, 1, "a lost reply and its retry start one T3 thread");
  const [{ args }, { args: again }] = launches();
  assert.deepEqual(args, {
    projectId: "project-demo",
    title: "Add a regression test",
    message: "Cover the empty input case and run the relevant tests.",
    runtimeMode: "approval-required",
    interactionMode: "default",
    clientRequestId: retried.operationId,
  });
  assert.deepEqual(again, args);
  assert.deepEqual(retried.receipt, {
    "request-id": first,
    "thread-id": "thread-1",
    "run-id": "run-1",
    "thread-link": "https://app.example.test/threads/env-1/thread-1",
    status: "preparing",
  });
  const replayed = await ask(request(first));
  assert.deepEqual(replayed, retried);
  assert.equal(launches().length, 2, "a start with a saved receipt does not call T3");
  console.log(
    "PASS a lost T3 reply was retried with the same request ID and replayed from the saved receipt",
  );

  for (const change of [{ project: "project-other" }, { brief: "Something else entirely." }]) {
    const refused = await ask(request(first, change));
    assert.equal(refused.kind, "IntentConflict");
  }
  assert.equal(launches().length, 2);
  console.log("PASS a retry with another project or brief was refused before reaching T3");

  const second = randomUUID();
  const both = await ask({ ...request(second), cmd: "start_twice" });
  assert(
    both.results.every(({ ok }) => ok),
    JSON.stringify(both.results),
  );
  assert.equal(both.results[0].operationId, both.results[1].operationId);
  assert.deepEqual(both.results[0].receipt, both.results[1].receipt);
  assert.equal(
    fake.emulator.threads.size,
    2,
    "two concurrent starts of one request start one thread",
  );
  console.log("PASS two concurrent starts of one request shared one plan and one T3 thread");

  const third = randomUUID();
  fake.emulator.loseNextResponse = true;
  assert.equal((await ask(request(third))).kind, "NoReply");
  const before = launches().length;
  await ask({ cmd: "use_token", token: "another-grant" });
  assert.equal((await ask(request(third))).kind, "ConnectionConflict");
  assert.equal(launches().length, before, "a retry on another grant does not call T3");
  await ask({ cmd: "use_token", token: fake.emulator.token });
  const recovered = await ask(request(third));
  assert.equal(recovered.ok, true, recovered.message);
  assert.equal(fake.emulator.threads.size, 3);
  console.log(
    "PASS a pending start on one grant was refused on another grant and finished on its own",
  );

  await ask({ cmd: "use_token", token: "revoked-grant" });
  assert.equal((await ask(request(randomUUID()))).kind, "GrantRejected");
  assert.equal((await ask({ cmd: "projects" })).kind, "GrantRejected");
  await ask({ cmd: "use_token", token: fake.emulator.token });
  const missing = await ask(request(randomUUID(), { project: "project-gone" }));
  assert.equal(missing.kind, "Tool");
  assert.match(missing.message, /\(orchestration_error\)/);
  assert.equal(fake.emulator.threads.size, 3);
  console.log(
    "PASS a revoked grant and a missing project returned actionable errors without a thread",
  );

  const saved = await Promise.all(
    (await readdir(directory)).map((file) => readFile(join(directory, file), "utf8")),
  );
  for (const text of [...saved, ...transcript]) {
    assert(!text.includes(fake.emulator.token), "the T3 token stays out of local files and output");
  }
  assert(saved.every((text) => !text.includes("revoked-grant") && !text.includes("another-grant")));
  console.log("PASS no T3 token reached the local ledger or the probe's output");
} finally {
  child.stdin.end();
  await new Promise((done) => child.once("close", done));
  fake.close();
  await rm(directory, { recursive: true, force: true });
}
