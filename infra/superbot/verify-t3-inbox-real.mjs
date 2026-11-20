import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

/**
 * Checks the desktop's T3 Code inbox bridge against a running, disposable T3 Code server.
 * The owner signs in to that server's web session with the one-time pairing link it printed at
 * startup, then approves the sign-in on T3's consent API with Supervised access, as the owner
 * clicking Approve on T3's page would. Prints no pairing token, state, code or access token.
 *
 * Usage: node infra/superbot/verify-t3-inbox-real.mjs PROBE_EXE MCP_URL SERVER_LOG PROJECT_TITLE
 * SERVER_LOG is the disposable server's output, which holds its `/pair#token=` link.
 *
 * By default it stops before launching: a launch starts a turn on a provider the server can run,
 * and a provider CLI can reach this computer's signed-in account even when the server has its
 * own profile directories. Pass --launch only for a server whose providers are
 * known to be signed out or fake.
 */
const launch = process.argv.includes("--launch");
const [probe, mcpUrl, serverLog, projectTitle] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--launch");
assert(
  probe && mcpUrl && serverLog && projectTitle,
  "Usage: PROBE_EXE MCP_URL SERVER_LOG PROJECT_TITLE",
);
const credential = /\/pair#token=([A-Za-z0-9_.~-]+)/.exec(await readFile(serverLog, "utf8"))?.[1];
assert(credential, "the disposable server printed its pairing link");
const origin = new URL(mcpUrl).origin;
const directory = await mkdtemp(join(tmpdir(), "t3-inbox-real-"));
const child = spawn(resolve(probe), [], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const transcript = [];
async function ask(command) {
  child.stdin.write(`${JSON.stringify(command)}\n`);
  const { value } = await lines.next();
  transcript.push(value);
  return JSON.parse(value);
}
let cookie = "";
async function t3(path, body) {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(cookie && { cookie }) },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const issued = response.headers.getSetCookie().map((line) => line.split(";")[0]);
  if (issued.length) cookie = issued.join("; ");
  return { status: response.status, body: await response.json().catch(() => null) };
}

let tokenText;
try {
  const begun = await ask({ cmd: "begin_sign_in", url: mcpUrl });
  assert.equal(begun.ok, true, begun.message);
  const authorizationUrl = new URL(begun.authorizationUrl);
  assert.equal(authorizationUrl.origin, origin);
  const authorization = Object.fromEntries(
    [
      "response_type",
      "client_id",
      "redirect_uri",
      "code_challenge",
      "code_challenge_method",
      "state",
      "resource",
    ].map((key) => [key, authorizationUrl.searchParams.get(key)]),
  );
  const page = await fetch(authorizationUrl, { redirect: "manual" });
  console.log(
    `INFO authorize answered ${page.status} -> ${new URL(page.headers.get("location") ?? "/", origin).pathname}`,
  );

  const owner = await t3("/api/auth/browser-session", { credential });
  assert.equal(
    owner.status,
    200,
    JSON.stringify(owner.body?.message ?? owner.body?._tag ?? owner.status),
  );
  assert(cookie, "T3 set a browser session cookie");
  const details = await t3("/oauth/mcp/approval", authorization);
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.equal(details.body.clientName, "Superbot T3 Code inbox");
  assert.equal(details.body.redirectHost, new URL(authorization.redirect_uri).host);
  console.log(
    `PASS real T3 discovery, registration and authorization: the approval page names "${details.body.clientName}" and callback ${details.body.redirectHost}`,
  );

  assert(details.body.csrfToken, "the signed-in owner gets a one-click approval");
  assert(
    details.body.oneClickAccess?.includes("approval-required"),
    JSON.stringify(details.body.oneClickAccess),
  );
  const decided = await t3("/oauth/mcp/decision", {
    authorization,
    decision: {
      _tag: "browser-session",
      access: "approval-required",
      csrfToken: details.body.csrfToken,
    },
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.body?.message ?? decided.body));
  const back = new URL(decided.body.redirectTo);
  assert.equal(`${back.origin}${back.pathname}`, authorization.redirect_uri);
  assert.equal(
    back.searchParams.get("iss")?.replace(/\/$/, ""),
    origin,
    "T3 names itself as the issuer",
  );
  const callback = await fetch(back);
  assert.equal(callback.status, 200);
  const finished = await ask({ cmd: "finish_sign_in" });
  assert.equal(finished.ok, true, finished.message);
  assert(!finished.debug.includes(credential));
  console.log(
    "PASS the owner approved Supervised access on T3's consent API; the issuer check and PKCE exchange passed",
  );

  const listed = await ask({ cmd: "projects" });
  assert.equal(listed.ok, true, listed.message);
  const project = listed.projects.find(({ title }) => title === projectTitle);
  assert(
    project,
    `the disposable project is listed (${listed.projects.map(({ title }) => title).join(", ")})`,
  );
  console.log(
    `PASS t3_project_list returned ${listed.projects.length} project(s), including the disposable one`,
  );
  if (!launch) {
    console.log(
      "STOP before t3_thread_launch: pass --launch for a server with only signed-out or fake providers",
    );
    process.exitCode = 0;
  } else {
    const scope = {
      server: "http://127.0.0.1:1",
      space: "space-real-check",
      installation: "install-real-check",
      dir: directory,
    };
    const record = randomUUID();
    const request = {
      cmd: "start",
      ...scope,
      record,
      project: project.id,
      title: "Superbot inbox check",
      brief: "List the files in this project and report them. Do not change anything.",
    };
    const first = await ask(request);
    if (!first.ok) {
      console.log(`INFO first start: ${first.kind}: ${first.message}`);
      for (const file of await readdir(directory)) {
        if (file.endsWith(".dispatch.json"))
          console.log("INFO the plan was kept for a retry with the same request ID");
      }
    }
    assert.equal(first.ok, true, first.message);
    const receipt = first.receipt;
    const link = new URL(receipt["thread-link"]);
    console.log(
      `PASS t3_thread_launch started a Supervised thread: status ${receipt.status}, link ${link.protocol}//${link.host}${link.pathname.replace(/[^/]+$/, "<thread>")}`,
    );

    const replayed = await ask(request);
    assert.deepEqual(replayed, first, "a repeat with a saved receipt returns it");
    for (const file of await readdir(directory)) {
      if (file.endsWith(".receipt.json")) await rm(join(directory, file));
    }
    const relaunched = await ask(request);
    assert.equal(relaunched.ok, true, relaunched.message);
    assert.equal(relaunched.operationId, first.operationId);
    assert.equal(
      relaunched.receipt["thread-id"],
      receipt["thread-id"],
      "T3 returned the same thread for the same request ID",
    );
    console.log(
      "PASS a lost receipt was retried with the same clientRequestId and T3 returned the original thread",
    );

    const moved = await ask({ ...request, project: `${project.id}-other` });
    assert.equal(moved.kind, "IntentConflict");
    console.log(`THREAD ${receipt["thread-id"]}`);
  }

  tokenText = credential;
  for (const text of [
    ...transcript,
    ...(await Promise.all(
      (await readdir(directory)).map((file) => readFile(join(directory, file), "utf8")),
    )),
  ]) {
    assert(!text.includes(tokenText), "the pairing credential stays out of output and files");
  }
  console.log("PASS no pairing credential or token reached the probe output or local ledger");
} finally {
  child.stdin.end();
  await new Promise((done) => child.once("close", done));
  await rm(directory, { recursive: true, force: true });
}
