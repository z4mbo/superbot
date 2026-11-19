import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

function loopbackOrigin(value) {
  const url = new URL(value);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
  assert.equal(url.href, `${url.origin}/`);
  return url.origin;
}

const [, , appArg, mailArg, fixtureFlag] = process.argv;
assert.equal(fixtureFlag, "--disposable", "Run only against a freshly started fixture.");
const origin = loopbackOrigin(appArg);
const mail = loopbackOrigin(mailArg);
const stamp = randomUUID();

async function post(path, body, options = {}) {
  return fetch(new URL(path, origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(options.cookie && { cookie: options.cookie }),
      ...(options.spaceId && { "x-rakazo-space-id": options.spaceId }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout ?? 15_000),
  });
}

async function rpc(path, input, options, status = 200) {
  const response = await post(`/rpc/${path}`, { json: input }, options);
  assert.equal(response.status, status, path);
  return (await response.json()).json;
}

async function signup(name) {
  const email = `${name.toLowerCase()}-${stamp}@example.test`;
  const response = await post("/api/auth/sign-up/email", {
    name,
    email,
    password: randomUUID(),
  });
  assert.equal(response.status, 200, "Password signup");
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert(cookie, "Signup returned a session cookie");
  return { email, cookie };
}

async function mailMessages(path) {
  const response = await fetch(new URL(`/api/v1/${path}`, mail), {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, "Mail capture API");
  return response.json();
}

assert.equal((await mailMessages("messages")).total, 0, "Start with an empty mail capture");
const owner = await signup("Owner");
const guest = await signup("Guest");
const outsider = await signup("Outsider");

const verification = (await mailMessages("messages")).messages.find(
  (message) =>
    message.To.some((recipient) => recipient.Address === owner.email) &&
    /^Verify your /i.test(message.Subject),
);
assert(verification, "Captured the owner's verification email");
const verificationText = (await mailMessages(`message/${verification.ID}`)).Text;
const verificationUrl = new URL(verificationText.match(/https?:\/\/\S+/)[0]);
assert.equal(verificationUrl.origin, origin);
assert.equal(verificationUrl.pathname, "/api/auth/verify-email");
const verified = await fetch(verificationUrl, {
  headers: { cookie: owner.cookie },
  redirect: "manual",
  signal: AbortSignal.timeout(5_000),
});
assert.equal(verified.status, 302);
assert.equal(new URL(verified.headers.get("location"), origin).searchParams.has("error"), false);

const { id: spaceId } = await rpc("spaces/create", { name: "Shared fixture" }, owner);
const { id: privateId } = await rpc("spaces/create", { name: "Private fixture" }, owner);
const { url: shareUrl } = await rpc("spaces/invites/create", { spaceId: privateId }, owner);
assert.equal(new URL(shareUrl).origin, origin);
const invite = await rpc("spaces/invites/create", { spaceId, email: guest.email }, owner);
assert.equal(invite.emailed, true);
const url = new URL(invite.url);
assert.equal(url.origin, origin);
assert.match(url.pathname, /^\/invite\/[A-Za-z0-9_-]+$/);
const captured = (await mailMessages("messages")).messages.find(
  (message) =>
    message.To.some((recipient) => recipient.Address === guest.email) &&
    /invited you/i.test(message.Subject),
);
assert(captured, "Captured the invite at the intended email address");
assert((await mailMessages(`message/${captured.ID}`)).Text.includes(url.href));
const token = url.pathname.split("/").at(-1);

await rpc("spaces/members/list", { spaceId }, outsider, 404);
await rpc("spaces/invites/preview", { token }, guest);
const stream = await post(
  "/rpc/notifications/subscribe",
  { json: {} },
  {
    ...owner,
    spaceId,
    timeout: 15_000,
  },
);
assert.equal(stream.status, 200);
assert.match(stream.headers.get("content-type"), /text\/event-stream/);
const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
let frames = "";
async function awaitRosterSignal(count) {
  while ([...frames.matchAll(/"type":"roster"/g)].length < count) {
    const { done, value } = await reader.read();
    assert.equal(done, false, "Realtime stream ended before its roster signal");
    frames += value;
  }
}
try {
  await awaitRosterSignal(1);
  assert.deepEqual(await rpc("spaces/invites/accept", { token }, guest), { spaceId });
  await awaitRosterSignal(2);
} finally {
  await reader.cancel();
}
await rpc("spaces/invites/accept", { token }, outsider, 404);
await rpc("spaces/members/list", { spaceId: privateId }, guest, 404);
const ownerRoster = await rpc("spaces/members/list", { spaceId }, owner);
const guestRoster = await rpc("spaces/members/list", { spaceId }, guest);
assert.equal(ownerRoster.canManage, true);
assert.equal(guestRoster.canManage, false);
assert.deepEqual(guestRoster.members, ownerRoster.members);
assert.deepEqual(guestRoster.members.map((member) => member.role).sort(), ["member", "owner"]);
await rpc("spaces/invites/create", { spaceId }, guest, 403);

const shareToken = new URL(shareUrl).pathname.split("/").at(-1);
assert.deepEqual(await rpc("spaces/invites/accept", { token: shareToken }, outsider), {
  spaceId: privateId,
});

console.log(
  "Password sessions, captured email, shared Space permissions and realtime stream passed.",
);
