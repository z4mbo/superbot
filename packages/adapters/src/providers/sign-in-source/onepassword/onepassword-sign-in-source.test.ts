import type { AdapterContext } from "@rakazo/adapter-kit";
import { SignInSourceDisconnected } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { CredentialBrokerSdk } from "./onepassword-sign-in-source.js";
import { OnePasswordSignInSource } from "./onepassword-sign-in-source.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};
const REDIRECT = "https://app.example.test/sign-in-source/callback";
// Characters a parse-and-rebuild would normalize; the link must come back byte for byte.
const APP_LINK = "onepassword://grant-brokered-access?access_request_reference=eyJ%2B%2F~a b";

// Named like the SDK's own error classes, which it tells apart by class name.
class InvalidTokenError extends Error {}
class InsufficientScopeError extends Error {}
class AccessRequestNotFoundError extends Error {}

function fakeSdk() {
  const loginRead = vi.fn(async () => ({ username: "u", password: "fixture-pass-9f3" }));
  const create = vi.fn(async () => ({
    accessRequest: { id: "request-1", entries: [{ id: "entry-1" }] },
    appLink: APP_LINK,
  }));
  const getStatus = vi.fn(async () => ({
    state: "resolved",
    resolved: [
      { entryId: "entry-other", reference: "accounts/a/capability/login/configurations/other" },
      { entryId: "entry-1", reference: "accounts/a/capability/login/configurations/c-1" },
    ],
  }));
  const configs: Array<{ accessToken: string; integrationKey: string }> = [];
  const sdk: CredentialBrokerSdk = {
    createOAuthClient: async (config) => {
      configs.push(config);
      // The real client also has logins.read; it is here so a call to it would be caught.
      return {
        credentialBroker: { accessRequests: { create, getStatus }, logins: { read: loginRead } },
      } as unknown as Awaited<ReturnType<CredentialBrokerSdk["createOAuthClient"]>>;
    },
  };
  return { sdk, create, getStatus, loginRead, configs };
}

function tokenFetch(body: Record<string, unknown> = {}, status = 200) {
  return vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
    Response.json(
      {
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: 900,
        ...body,
      },
      { status },
    ),
  );
}

function provider(
  fetch: ReturnType<typeof tokenFetch> = tokenFetch(),
  sdk = fakeSdk().sdk,
): OnePasswordSignInSource {
  return new OnePasswordSignInSource({
    clientId: "fixture-client",
    clientSecret: "fixture-client-secret",
    fetch: fetch as unknown as typeof globalThis.fetch,
    loadSdk: async () => sdk,
  });
}

const connected = {
  secret: JSON.stringify({
    accessToken: "fixture-access",
    refreshToken: "fixture-refresh",
    integrationKey: "ops_fixture-key",
  }),
  refreshAt: null,
};

describe("password manager sign-in source", () => {
  it("cannot be connected until a client is registered", () => {
    expect(new OnePasswordSignInSource().describe().capabilities.connectable).toBe(false);
    expect(provider().describe().capabilities).toMatchObject({
      connectable: true,
      grantDays: 30,
      approvalLinkSchemes: ["onepassword:"],
    });
  });

  it("starts the documented authorization-code flow with PKCE and a state", async () => {
    const start = await provider().beginConnect({ redirectUri: REDIRECT }, context);
    const url = new URL(start.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://my.1password.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "fixture-client",
      redirect_uri: REDIRECT,
      scope: "brokered-credentials:request-access brokered-credentials:read",
      state: start.state,
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("code_challenge")).not.toBe(start.pending);
  });

  it("exchanges the code with Basic client credentials and keeps the fragment's integration key", async () => {
    const fetch = tokenFetch();
    const credential = await provider(fetch).finishConnect(
      {
        pending: "verifier-1",
        redirectUri: REDIRECT,
        callback: { code: "code-1", state: "s", fragment: { integration_key: "ops_fixture-key" } },
      },
      context,
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.1password.com/v1/oauth/token");
    expect(((init?.headers ?? {}) as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("fixture-client:fixture-client-secret").toString("base64")}`,
    );
    const form = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: REDIRECT,
      code_verifier: "verifier-1",
    });
    expect(JSON.parse(credential.secret)).toEqual({
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      integrationKey: "ops_fixture-key",
    });
  });

  it("keeps the stored integration key on a reconnect that sends none, and needs one otherwise", async () => {
    const again = await provider().finishConnect(
      {
        pending: "v",
        redirectUri: REDIRECT,
        callback: { code: "c", state: "s" },
        previous: connected,
      },
      context,
    );
    expect(JSON.parse(again.secret).integrationKey).toBe("ops_fixture-key");
    await expect(
      provider().finishConnect(
        { pending: "v", redirectUri: REDIRECT, callback: { code: "c", state: "s" } },
        context,
      ),
    ).rejects.toThrow();
  });

  it("treats a rejected refresh token as a connection to make again", async () => {
    await expect(
      provider(tokenFetch({ error: "invalid_grant" }, 400)).refresh(connected, context),
    ).rejects.toBeInstanceOf(SignInSourceDisconnected);
  });

  it("revokes with the access token as a bearer and an empty body", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    await provider(fetch as never).disconnect(connected, context);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.1password.com/v1alpha1/oauth-integrations/self:revoke");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer fixture-access");
    expect(init.body).toBe("{}");
  });

  it("asks for one login by site, passes the app link through untouched, and never reads values", async () => {
    const fake = fakeSdk();
    const source = provider(tokenFetch(), fake.sdk);
    const request = await source.requestAccess(
      connected,
      { site: "https://github.com", goal: "Sign in to https://github.com for the user" },
      context,
    );
    expect(request).toEqual({ id: "request-1", entryId: "entry-1", approvalLink: APP_LINK });
    expect(fake.create).toHaveBeenCalledWith({
      goal: "Sign in to https://github.com for the user",
      entries: [{ type: "login", parameters: { website: "https://github.com" } }],
    });
    expect(fake.configs[0]).toEqual({
      accessToken: "fixture-access",
      integrationKey: "ops_fixture-key",
    });
    expect(
      await source.accessState(connected, { id: "request-1", entryId: "entry-1" }, context),
    ).toEqual({ state: "approved", reference: "accounts/a/capability/login/configurations/c-1" });
    expect(fake.loginRead).not.toHaveBeenCalled();
  });

  it("reads the request's states, matching grants by entry and treating unknown states as final", async () => {
    const fake = fakeSdk();
    const source = provider(tokenFetch(), fake.sdk);
    const ask = () => source.accessState(connected, { id: "r", entryId: "entry-1" }, context);
    fake.getStatus.mockResolvedValueOnce({ state: "pending", resolved: [] });
    expect(await ask()).toEqual({ state: "pending" });
    fake.getStatus.mockResolvedValueOnce({ state: "denied", resolved: [] });
    expect(await ask()).toEqual({ state: "denied" });
    fake.getStatus.mockResolvedValueOnce({ state: "expired", resolved: [] });
    expect(await ask()).toEqual({ state: "expired" });
    fake.getStatus.mockResolvedValueOnce({ state: "something-new", resolved: [] });
    expect(await ask()).toEqual({ state: "failed" });
    // The person may grant nothing for our entry.
    fake.getStatus.mockResolvedValueOnce({
      state: "resolved",
      resolved: [{ entryId: "entry-other", reference: "x" }],
    });
    expect(await ask()).toEqual({ state: "denied" });
    fake.getStatus.mockRejectedValueOnce(new InvalidTokenError("expired"));
    await expect(ask()).rejects.toBeInstanceOf(SignInSourceDisconnected);
    fake.getStatus.mockRejectedValueOnce(new InsufficientScopeError("scope"));
    await expect(ask()).rejects.toBeInstanceOf(SignInSourceDisconnected);
    // A request the provider no longer knows ran out, as far as the person is concerned.
    fake.getStatus.mockRejectedValueOnce(new AccessRequestNotFoundError("gone"));
    expect(await ask()).toEqual({ state: "expired" });
  });

  it("builds the extension's fill call from the grant reference and reads its answer", () => {
    const source = provider();
    expect(source.fillCall(connected, "accounts/a/capability/login/configurations/c-1")).toEqual({
      method: "agenticAutofill.v1.fillCredential",
      params: {
        accessToken: "fixture-access",
        integrationKey: "ops_fixture-key",
        resourcePath: "accounts/a/capability/login/configurations/c-1",
      },
    });
    expect(source.fillOutcome({ success: true, result: { status: "fill_submitted" } })).toEqual({
      status: "submitted",
    });
    expect(source.fillOutcome({ success: false, error: { code: "noActiveGrant" } })).toEqual({
      status: "no_active_grant",
    });
    expect(source.fillOutcome({ success: false, error: { code: "invalidToken" } })).toEqual({
      status: "disconnected",
    });
    expect(source.fillOutcome({ success: false, error: { code: "websiteMismatch" } })).toEqual({
      status: "failed",
    });
  });
});
