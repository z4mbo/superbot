import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_HEALTH_PATH, CLOUD_SESSION_PATH } from "@rakazo/contracts";
import { asSystem } from "@rakazo/db";
import { expect, it } from "vitest";
import { createApp } from "../app.js";
import type { CloudWebSettings } from "./cloud-settings.js";
import {
  createTestIssuer,
  TEST_ISSUER,
  TEST_JWKS_URL,
  TEST_SITE,
} from "./cloud-token.test-support.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";

async function startApp(cloudWeb: CloudWebSettings | undefined, cloudWebFetch: typeof fetch) {
  return createApp({
    databaseUrl: databaseUrl!,
    dataDir: await mkdtemp(join(tmpdir(), "rakazo-cloud-web-")),
    sandboxProvider: "fake",
    agentRuntime: "scripted",
    wakeupDriver: "memory",
    signupsEnabled: "true",
    webOrigin: origin,
    authUrl: origin,
    cloudWeb,
    cloudWebFetch,
  });
}

/** Valid for the next minute by the real clock, as the server checks it. */
function freshClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iat: now - 1, nbf: now - 1, exp: now + 60, ...overrides };
}

it.skipIf(!databaseUrl)(
  "signs a hosted page's token in as the mapped local account, everywhere a session is read",
  async () => {
    const issuer = createTestIssuer();
    // The fixture database may hold other accounts, so the entry names its local account.
    const email = `cloud-owner-${Date.now()}@example.test`;
    const handles = await startApp(
      {
        origins: [TEST_SITE],
        issuer: TEST_ISSUER,
        jwksUrl: TEST_JWKS_URL,
        allowedEmails: new Map([
          ["cloud-owner@example.test", email],
          ["cloud-stranger@example.test", "nobody@example.test"],
        ]),
        serverName: "Cloud test",
      },
      issuer.fetch,
    );
    const system = asSystem(handles.prisma);
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, password: "test-password-123", name: "Cloud owner" }),
      });
      expect(signup.status).toBeLessThan(400);
      const user = await system.user.findUniqueOrThrow({ where: { email } });
      const fromHosted = (path: string, init: RequestInit = {}) =>
        handles.app.request(path, {
          ...init,
          headers: {
            origin: TEST_SITE,
            authorization: `Bearer ${issuer.token(
              freshClaims({ email: "Cloud-Owner@example.test", sid: `sess-${user.id}` }),
            )}`,
            ...(init.headers as Record<string, string>),
          },
        });

      // An authenticated RPC procedure.
      const me = await fromHosted("/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { json: { email: string } }).json.email).toBe(email);
      expect(me.headers.get("access-control-allow-origin")).toBe(TEST_SITE);
      expect(me.headers.has("access-control-allow-credentials")).toBe(false);

      // The auth library's own session route, with no session credential handed out.
      const session = await fromHosted("/api/auth/get-session");
      expect(session.status).toBe(200);
      const body = (await session.json()) as {
        user: { id: string; email: string };
        session: Record<string, unknown>;
      };
      expect(body.user).toMatchObject({ id: user.id, email });
      expect(body.session).not.toHaveProperty("token");
      expect(session.headers.has("set-cookie")).toBe(false);
      expect(session.headers.has("set-auth-token")).toBe(false);

      const cloudSession = await fromHosted(CLOUD_SESSION_PATH);
      expect(cloudSession.status).toBe(200);
      expect(await cloudSession.json()).toEqual({
        user: { id: user.id, email, name: "Cloud owner" },
      });

      // The sign-up session and one local session reused by every request above.
      expect(await system.session.count({ where: { userId: user.id } })).toBe(2);

      // A refused token is answered, not served as an anonymous request.
      const refused = await handles.app.request("/rpc/me", {
        method: "POST",
        headers: {
          origin: TEST_SITE,
          authorization: `Bearer ${issuer.token(freshClaims({ email: "cloud-stranger@example.test" }))}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ json: null }),
      });
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ code: "no_local_account" });

      // Signing out from the hosted page ends that session; the next request opens it again.
      const signOut = await fromHosted("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(signOut.status).toBe(200);
      expect(await system.session.count({ where: { userId: user.id } })).toBe(1);
      expect((await fromHosted(CLOUD_SESSION_PATH)).status).toBe(200);
      expect(await system.session.count({ where: { userId: user.id } })).toBe(2);
    } finally {
      await handles.stop();
    }
  },
);

it.skipIf(!databaseUrl)("treats a cloud token as before when cloud web is off", async () => {
  const issuer = createTestIssuer();
  const handles = await startApp(undefined, issuer.fetch);
  try {
    const headers = {
      origin: TEST_SITE,
      authorization: `Bearer ${issuer.token(freshClaims())}`,
      "content-type": "application/json",
    };
    const me = await handles.app.request("/rpc/me", {
      method: "POST",
      headers,
      body: JSON.stringify({ json: null }),
    });
    expect(me.status).toBe(401);
    expect(me.headers.has("access-control-allow-origin")).toBe(false);
    expect((await handles.app.request(CLOUD_SESSION_PATH, { headers })).status).toBe(404);
    const health = await handles.app.request(CLOUD_HEALTH_PATH);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, name: "Superbot", cloudEnabled: false });
    expect(issuer.fetched).toEqual([]);
  } finally {
    await handles.stop();
  }
});
