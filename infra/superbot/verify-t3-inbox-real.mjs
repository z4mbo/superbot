import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
 * It never calls t3_thread_launch. A launch starts a turn on a provider of the T3 computer, and a
 * provider CLI can use that computer's signed-in account and history even when the server has
 * its own profile directories. Launches are checked only against the fake T3 server.
 */
const [probe, mcpUrl, serverLog, projectTitle] = process.argv.slice(2);
assert(
  probe && mcpUrl && serverLog && projectTitle,
  "Usage: PROBE_EXE MCP_URL SERVER_LOG PROJECT_TITLE",
);
const credential = /\/pair#token=([A-Za-z0-9_.~-]+)/.exec(await readFile(serverLog, "utf8"))?.[1];
assert(credential, "the disposable server printed its pairing link");
const origin = new URL(mcpUrl).origin;
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

  for (const text of transcript) {
    assert(!text.includes(credential), "the pairing credential stays out of the probe output");
  }
  console.log("PASS no pairing credential reached the probe output");
} finally {
  child.stdin.end();
  await new Promise((done) => child.once("close", done));
}
