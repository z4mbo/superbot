import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { DelegatedSessionInput } from "@rakazo/auth";
import { CLOUD_API_VERSION, CLOUD_HEALTH_PATH, CLOUD_SESSION_PATH } from "@rakazo/contracts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalAccountDirectory } from "./cloud-accounts.js";
import type { CloudWebSettings } from "./cloud-settings.js";
import {
  createTestIssuer,
  TEST_ISSUER,
  TEST_JWKS_URL,
  TEST_NOW_SECONDS,
  TEST_SITE,
} from "./cloud-token.test-support.js";
import { createCloudWeb, mountCloudHealth } from "./cloud-web.js";

const TRUSTED = "https://own-web.example.test";
const PREVIEW = "https://hosted-git-main.example.test";
const EXPOSED = ["x-rakazo-build", "x-voice-id"];
const owner = { id: "user-owner", email: "person@example.test", name: "Person" };

const settings: CloudWebSettings = {
  origins: [TEST_SITE, "https://hosted-*.example.test"],
  issuer: TEST_ISSUER,
  jwksUrl: TEST_JWKS_URL,
  allowedEmails: new Map([
    ["person@example.test", null],
    ["nobody@example.test", "missing@example.test"],
  ]),
  serverName: "Home",
};

const directory: LocalAccountDirectory = {
  byEmail: async (email) => (email === owner.email ? { ...owner, usable: true } : null),
  firstTwo: async () => [
    { ...owner, usable: true },
    { id: "user-2", email: "two@example.test", name: "Two", usable: true },
  ],
};

/** The trusted CORS the API already has, unchanged. */
const trustedCors = () =>
  cors({
    origin: (origin) => (origin === TRUSTED ? origin : ""),
    credentials: true,
    exposeHeaders: EXPOSED,
  });

function setup(options: { refuseSession?: boolean } = {}) {
  const issuer = createTestIssuer();
  const sessions: DelegatedSessionInput[] = [];
  const cloud = createCloudWeb({
    settings,
    prisma: {} as never,
    directory,
    delegatedSession: async (input) => {
      sessions.push(input);
      return options.refuseSession
        ? null
        : { bearer: `local-${input.userId}.c2lnbmVk`, sessionId: "session-1" };
    },
    trustedOrigin: (origin) => origin === TRUSTED,
    exposeHeaders: EXPOSED,
    clientIp: () => "203.0.113.9",
    fetch: issuer.fetch,
    now: () => TEST_NOW_SECONDS * 1000,
  });
  const app = new Hono();
  app.use("*", cloud.cors(trustedCors()));
  mountCloudHealth(app, { name: "Home", version: "20261101000000", cloudEnabled: true });
  app.use("*", cloud.signIn);
  cloud.mount(app);
  // Stands in for every route that reads the session: shows what it received.
  app.on(["GET", "POST"], ["/echo", "/api/auth/sign-out"], async (c) =>
    c.json(
      {
        authorization: c.req.header("authorization") ?? null,
        cookie: c.req.header("cookie") ?? null,
        body: c.req.method === "POST" ? await c.req.text() : null,
      },
      200,
      { "set-cookie": "session_token=local; HttpOnly", "set-auth-token": "local-bearer" },
    ),
  );
  return { app, issuer, sessions };
}

const preflight = (origin: string, extra: Record<string, string> = {}) => ({
  method: "OPTIONS",
  headers: {
    origin,
    "access-control-request-method": "POST",
    "access-control-request-headers": "authorization,content-type,x-rakazo-space-id,sentry-trace",
    ...extra,
  },
});

const headersOf = (response: Response) => Object.fromEntries(response.headers.entries());

describe("cloud web CORS", () => {
  it("answers a preflight from an allowed site without credentials", async () => {
    const { app } = setup();
    for (const origin of [TEST_SITE, PREVIEW]) {
      const response = await app.request("/rpc/me", preflight(origin));
      expect(response.status).toBe(204);
      expect(headersOf(response)).toMatchObject({
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,HEAD,PUT,POST,DELETE,PATCH",
        "access-control-allow-headers": "authorization,content-type,x-rakazo-space-id,sentry-trace",
        "access-control-max-age": "600",
      });
      expect(response.headers.get("vary")).toContain("Origin");
      expect(response.headers.has("access-control-allow-credentials")).toBe(false);
      expect(response.headers.has("access-control-allow-private-network")).toBe(false);
    }
  });

  it("allows a private network request only when the preflight asks", async () => {
    const { app } = setup();
    const response = await app.request(
      "/rpc/me",
      preflight(TEST_SITE, { "access-control-request-private-network": "true" }),
    );
    expect(response.headers.get("access-control-allow-private-network")).toBe("true");
    const denied = await app.request(
      "/rpc/me",
      preflight("https://evil.example.test", { "access-control-request-private-network": "true" }),
    );
    expect(denied.headers.has("access-control-allow-private-network")).toBe(false);
  });

  it("lets an allowed site read the health answer and the exposed headers", async () => {
    const { app } = setup();
    const response = await app.request(CLOUD_HEALTH_PATH, { headers: { origin: TEST_SITE } });
    expect(response.status).toBe(200);
    expect(headersOf(response)).toMatchObject({
      "access-control-allow-origin": TEST_SITE,
      "access-control-expose-headers": EXPOSED.join(","),
      "cache-control": "no-store",
    });
    expect(response.headers.get("vary")).toContain("Origin");
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
    expect(await response.json()).toEqual({
      ok: true,
      name: "Home",
      version: "20261101000000",
      cloudEnabled: true,
      cloudApi: CLOUD_API_VERSION,
    });
  });

  it("answers any other origin exactly as before", async () => {
    const { app } = setup();
    const before = new Hono();
    before.use("*", trustedCors());
    before.get("/echo", (c) => c.json({}));
    for (const origin of [
      "https://evil.example.test",
      TRUSTED,
      "https://hosted.example.test.evil",
    ]) {
      for (const init of [preflight(origin), { headers: { origin } }]) {
        const now = await app.request("/echo", init);
        const then = await before.request("/echo", init);
        expect(now.status, origin).toBe(then.status);
        const corsHeaders = (response: Response) =>
          Object.fromEntries(
            [...response.headers].filter(([name]) => name.startsWith("access-control-")),
          );
        expect(corsHeaders(now), origin).toEqual(corsHeaders(then));
      }
    }
    // The server's own web origin keeps its credentialed CORS.
    const own = await app.request("/echo", { headers: { origin: TRUSTED } });
    expect(own.headers.get("access-control-allow-credentials")).toBe("true");
    expect(own.headers.get("access-control-allow-origin")).toBe(TRUSTED);
  });
});

describe("cloud web sign-in", () => {
  it("swaps a valid cloud token for the local session's bearer", async () => {
    const { app, issuer, sessions } = setup();
    const response = await app.request("/echo", {
      method: "POST",
      headers: {
        origin: TEST_SITE,
        authorization: `Bearer ${issuer.token()}`,
        cookie: "session_token=someone-else",
        "content-type": "application/json",
        "user-agent": "Test Browser",
      },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorization: "Bearer local-user-owner.c2lnbmVk",
      cookie: null,
      body: '{"hello":"world"}',
    });
    // The local session never reaches the browser.
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("set-auth-token")).toBe(false);
    expect(response.headers.get("access-control-allow-origin")).toBe(TEST_SITE);
    expect(sessions).toEqual([
      {
        userId: "user-owner",
        key: `cloud-web\0${TEST_ISSUER}\0sess_1`,
        userAgent: "Test Browser",
        ipAddress: "203.0.113.9",
      },
    ]);
  });

  it("reuses the session it found for the same sign-in", async () => {
    const { app, issuer, sessions } = setup();
    for (let index = 0; index < 3; index += 1) {
      const response = await app.request("/echo", {
        headers: { authorization: `Bearer ${issuer.token({ jti: String(index) })}` },
      });
      expect(response.status).toBe(200);
    }
    expect(sessions).toHaveLength(1);
    await app.request("/echo", {
      headers: { authorization: `Bearer ${issuer.token({ sid: "sess_2" })}` },
    });
    expect(sessions.map((session) => session.key)).toEqual([
      `cloud-web\0${TEST_ISSUER}\0sess_1`,
      `cloud-web\0${TEST_ISSUER}\0sess_2`,
    ]);
  });

  it("looks the session up again after signing out through it", async () => {
    const { app, issuer, sessions } = setup();
    const authorization = `Bearer ${issuer.token()}`;
    await app.request("/api/auth/sign-out", { method: "POST", headers: { authorization } });
    await app.request("/echo", { headers: { authorization } });
    expect(sessions).toHaveLength(2);
  });

  it("answers a refused token with its reason and never as an anonymous request", async () => {
    const { app, issuer } = setup();
    const cases: [string, string][] = [
      [issuer.token({ exp: TEST_NOW_SECONDS - 60 }), "token_invalid"],
      [issuer.token({ azp: "https://evil.example.test" }), "token_invalid"],
      ["a.b.", "token_invalid"],
      [issuer.token({ email_verified: false }), "email_unverified"],
      [issuer.token({ email: "stranger@example.test" }), "account_not_allowed"],
      [issuer.token({ email: "nobody@example.test" }), "no_local_account"],
    ];
    for (const [token, code] of cases) {
      const response = await app.request("/echo", {
        headers: { origin: TEST_SITE, authorization: `Bearer ${token}` },
      });
      expect(response.status, code).toBe(401);
      expect(await response.json(), code).toEqual({ code });
      expect(response.headers.get("access-control-allow-origin")).toBe(TEST_SITE);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("refuses an account the session rules turn away", async () => {
    const { app, issuer } = setup({ refuseSession: true });
    const response = await app.request("/echo", {
      headers: { authorization: `Bearer ${issuer.token()}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "no_local_account" });
  });

  it("answers 503 while the issuer's keys cannot be fetched", async () => {
    const { app, issuer } = setup();
    issuer.fail(true);
    const response = await app.request("/echo", {
      headers: { authorization: `Bearer ${issuer.token()}` },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("leaves other credentials alone", async () => {
    const { app } = setup();
    const response = await app.request("/echo", {
      headers: { authorization: "Bearer session-token.c2lnbmF0dXJl", cookie: "a=b" },
    });
    expect(await response.json()).toEqual({
      authorization: "Bearer session-token.c2lnbmF0dXJl",
      cookie: "a=b",
      body: null,
    });
    expect(response.headers.has("set-cookie")).toBe(true);
  });

  it("names the local account the token signs in as", async () => {
    const { app, issuer } = setup();
    const response = await app.request(CLOUD_SESSION_PATH, {
      headers: { origin: TEST_SITE, authorization: `Bearer ${issuer.token()}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: owner });
    const anonymous = await app.request(CLOUD_SESSION_PATH);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ code: "token_invalid" });
    const localBearer = await app.request(CLOUD_SESSION_PATH, {
      headers: { authorization: "Bearer session-token.c2lnbmF0dXJl" },
    });
    expect(localBearer.status).toBe(401);
  });

  it("answers health without checking a stale token", async () => {
    const { app, issuer } = setup();
    const response = await app.request(CLOUD_HEALTH_PATH, {
      headers: { authorization: `Bearer ${issuer.token({ exp: 1 })}` },
    });
    expect(response.status).toBe(200);
  });
});

describe("cloud web sign-in on the Node server", () => {
  const servers: ReturnType<typeof serve>[] = [];
  // The server installs its own Request and Response globals, as it does in production.
  const { Request: GlobalRequest, Response: GlobalResponse } = globalThis;
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
    Object.defineProperty(globalThis, "Request", { value: GlobalRequest });
    Object.defineProperty(globalThis, "Response", { value: GlobalResponse });
  });

  it("keeps a streamed upload body when it swaps the credential", async () => {
    const { app, issuer } = setup();
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const chunks = ["part-1;", "part-2;", "part-3"];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
        else controller.close();
      },
    });
    const response = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      headers: { authorization: `Bearer ${issuer.token()}`, "content-type": "text/plain" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorization: "Bearer local-user-owner.c2lnbmVk",
      cookie: null,
      body: "part-1;part-2;part-3",
    });
  });
});
