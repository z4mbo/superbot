import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const auth = "http://127.0.0.1:5360";
const api = "http://127.0.0.1:5361";
const { SMOKE_OWNER, SMOKE_GUEST, SMOKE_REVIEWER, SMOKE_PASSWORD } = process.env;
assert(
  [SMOKE_OWNER, SMOKE_GUEST, SMOKE_REVIEWER].every((email) => email?.endsWith("@example.test")),
);
assert(SMOKE_PASSWORD);
const tag = randomUUID().slice(0, 8);

async function post(origin, path, input, { token, space, status = 200 } = {}) {
  const headers = { "content-type": "application/json", origin: "rakazo://" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (space) headers["x-rakazo-space-id"] = space;
  const response = await fetch(origin + path, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, status, path);
  return response;
}

async function login(email) {
  const response = await post(auth, "/api/auth/sign-in/email", { email, password: SMOKE_PASSWORD });
  const token = response.headers.get("set-auth-token");
  assert(token, "Signed bearer token");
  return token;
}

async function rpc(token, route, input = {}, space, status = 200) {
  const response = await post(api, `/rpc/${route}`, { json: input }, { token, space, status });
  return (await response.json()).json;
}

const sessions = [];
try {
  for (const email of [SMOKE_OWNER, SMOKE_GUEST, SMOKE_REVIEWER]) sessions.push(await login(email));
  const [owner, guest, reviewer] = sessions;
  const space = await rpc(owner, "spaces/create", { name: `Smoke ${tag}` });
  const scoped = { spaceId: space.id };
  const list = (token) => rpc(token, "spaces/members/list", scoped);
  const invite = async (input) => {
    const result = await rpc(owner, "spaces/invites/create", { ...scoped, ...input });
    const url = new URL(result.url);
    assert.equal(url.origin, auth);
    assert(url.pathname.startsWith("/invite/"));
    return { token: url.pathname.split("/").at(-1), emailed: result.emailed };
  };
  await rpc(guest, "spaces/members/list", scoped, undefined, 404);
  const cancelled = await invite({});
  await rpc(owner, "spaces/invites/cancel", scoped);
  await rpc(guest, "spaces/invites/accept", { token: cancelled.token }, undefined, 404);
  const link = await invite({ email: SMOKE_GUEST });
  assert.equal(link.emailed, true);
  assert.equal(
    (await rpc(guest, "spaces/invites/preview", { token: link.token })).spaceName,
    space.name,
  );
  assert.equal(
    (await rpc(guest, "spaces/invites/accept", { token: link.token })).spaceId,
    space.id,
  );
  await rpc(reviewer, "spaces/invites/accept", { token: link.token }, undefined, 404);
  assert.equal((await rpc(guest, "spaces/list", {}, space.id)).current.id, space.id);
  assert.equal((await list(owner)).canManage, true);
  const guestView = await list(guest);
  assert.equal(guestView.canManage, false);
  assert.equal(guestView.members.length, 2);
  await rpc(guest, "spaces/invites/create", scoped, undefined, 403);
  const guestId = guestView.members.find(({ email }) => email === SMOKE_GUEST).userId;
  await rpc(owner, "spaces/members/remove", { ...scoped, userId: guestId });
  assert(!(await rpc(guest, "spaces/list")).spaces.some(({ id }) => id === space.id));
  await rpc(guest, "spaces/members/list", scoped, undefined, 404);
  const renewed = await invite({});
  await rpc(guest, "spaces/invites/accept", { token: renewed.token });
  console.log(
    "PASS cross-account invite email, cancellation, acceptance, replay denial, removal and rejoin",
  );

  const slug = `integration-smoke-${tag}`;
  const registry = (token, method, input = {}, spaceId, status) =>
    rpc(token, `pluginRegistry/${method}`, input, spaceId, status);
  const submission = {
    slug,
    version: 1,
    manifest: {
      schemaVersion: 1,
      name: "Smoke skill",
      description: "Synthetic registry skill",
      parts: [{ id: "notes", kind: "skill", instructions: "Summarize fixture notes." }],
    },
  };
  await registry(null, "discover", { slug }, undefined, 401);
  const release = await registry(owner, "submit", submission);
  assert.equal(release.status, "pending");
  assert((await registry(owner, "mine")).items.some(({ id }) => id === release.id));
  assert(!(await registry(guest, "mine")).items.some(({ id }) => id === release.id));
  assert.equal((await registry(guest, "discover", { slug })).items.length, 0);
  await registry(guest, "install", { versionId: release.id }, space.id, 404);
  await registry(guest, "submit", { ...submission, version: 2 }, space.id, 409);
  const review = { versionId: release.id, decision: "approved" };
  await registry(owner, "review", review, undefined, 403);
  console.log(
    "PASS registry authentication, pending publication, publisher ownership and review denial",
  );

  const decision = await registry(reviewer, "review", review);
  assert.equal(decision.status, "approved");
  await registry(reviewer, "review", review, undefined, 409);
  assert.deepEqual(
    (await registry(guest, "discover", { slug })).items.map(({ id }) => id),
    [release.id],
  );
  const rejected = await registry(owner, "submit", { ...submission, version: 2 });
  assert.equal(
    (
      await registry(reviewer, "review", {
        versionId: rejected.id,
        decision: "rejected",
        reason: "Smoke rejection.",
      })
    ).status,
    "rejected",
  );
  assert.deepEqual(
    (await registry(guest, "discover", { slug })).items.map(({ id }) => id),
    [release.id],
  );

  const install = () => registry(guest, "install", { versionId: release.id }, space.id);
  const installed = await install();
  assert.deepEqual((await install()).grants, []);
  assert.equal((await install()).id, installed.id);
  const first = await rpc(guest, "bots/create", { name: `Smoke first ${tag}` }, space.id);
  const second = await rpc(guest, "bots/create", { name: `Smoke second ${tag}` }, space.id);
  const foreign = await rpc(owner, "bots/create", { name: `Smoke owner ${tag}` }, space.id);
  const grant = { installationId: installed.id, botId: first.id, partIds: ["notes"] };
  assert.deepEqual((await registry(owner, "installations", {}, space.id)).items, []);
  assert.deepEqual((await registry(guest, "installations")).items, []);
  await registry(owner, "setGrants", grant, space.id, 404);
  await registry(guest, "setGrants", { ...grant, botId: foreign.id }, space.id, 404);
  await registry(guest, "setGrants", { ...grant, partIds: ["missing"] }, space.id, 400);
  assert.deepEqual((await registry(guest, "setGrants", grant, space.id)).grants, [
    { botId: first.id, partId: "notes" },
  ]);
  assert.equal(
    (await registry(guest, "setGrants", { ...grant, botId: second.id }, space.id)).grants.length,
    2,
  );
  assert.deepEqual(
    (await registry(guest, "setGrants", { ...grant, partIds: [] }, space.id)).grants,
    [{ botId: second.id, partId: "notes" }],
  );
  await registry(owner, "uninstall", { installationId: installed.id }, space.id);
  assert(
    (await registry(guest, "installations", {}, space.id)).items.some(
      ({ id }) => id === installed.id,
    ),
  );
  await registry(guest, "uninstall", { installationId: installed.id }, space.id);
  assert.deepEqual((await registry(guest, "installations", {}, space.id)).items, []);
  await registry(guest, "setGrants", grant, space.id, 404);
  assert.deepEqual((await install()).grants, []);
  console.log(
    "PASS registry review, discovery, idempotent install, scoped per-agent grants and uninstall",
  );

  await rpc(owner, "spaces/members/remove", { ...scoped, userId: guestId });
  await rpc(owner, "spaces/remove", scoped);
} finally {
  for (const token of sessions) await post(auth, "/api/auth/sign-out", {}, { token });
}
