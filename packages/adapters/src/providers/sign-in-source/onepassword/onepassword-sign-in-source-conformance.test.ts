import { describe, expect, it } from "vitest";
import { createSignInSourceProvider } from "../../../sign-in-sources/sign-in-source-factory.js";
import { signInSourceConformance } from "../../../sign-in-sources/sign-in-sources.test-support.js";
import type { CredentialBrokerSdk } from "./onepassword-sign-in-source.js";
import { OnePasswordSignInSource } from "./onepassword-sign-in-source.js";

/**
 * The provider against a stubbed token endpoint and SDK: tokens are issued until the connection
 * is revoked, after which a refresh is refused as the real endpoint refuses it.
 */
function stubbedProvider(): OnePasswordSignInSource {
  let revoked = false;
  const fetch = async (url: URL | RequestInfo) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("self:revoke")) {
      revoked = true;
      return Response.json({});
    }
    if (revoked) return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      expires_in: 900,
    });
  };
  const entries = new Map<string, string>();
  const sdk: CredentialBrokerSdk = {
    createOAuthClient: async () =>
      ({
        credentialBroker: {
          accessRequests: {
            create: async () => {
              const id = `request-${entries.size + 1}`;
              entries.set(id, `entry-${id}`);
              return {
                accessRequest: { id, entries: [{ id: `entry-${id}` }] },
                appLink: `onepassword://grant?r=${id}`,
              };
            },
            getStatus: async (id: string) => ({
              state: "resolved",
              resolved: [
                {
                  entryId: entries.get(id),
                  reference: `accounts/a/capability/login/configurations/${id}`,
                },
              ],
            }),
          },
        },
      }) as unknown as Awaited<ReturnType<CredentialBrokerSdk["createOAuthClient"]>>,
  };
  return new OnePasswordSignInSource({
    clientId: "fixture-client",
    clientSecret: "fixture-client-secret",
    fetch: fetch as typeof globalThis.fetch,
    loadSdk: async () => sdk,
  });
}

// Its sign-in page sends back a code, the state, and on first consent an integration key.
signInSourceConformance(
  "password manager",
  async () => stubbedProvider(),
  (start) => ({
    code: "fixture-code",
    state: start.state,
    fragment: { integration_key: "ops_fixture-key" },
  }),
);

describe("password manager sign-in source factory", () => {
  it("is listed without a client registration, but cannot be connected", async () => {
    const source = await createSignInSourceProvider({ SIGN_IN_SOURCE_PROVIDER: "onepassword" });
    expect(source).toBeInstanceOf(OnePasswordSignInSource);
    expect(source?.describe().capabilities.connectable).toBe(false);
    const registered = await createSignInSourceProvider({
      SIGN_IN_SOURCE_PROVIDER: "onepassword",
      SIGN_IN_SOURCE_CLIENT_ID: "fixture-client",
      SIGN_IN_SOURCE_CLIENT_SECRET: "fixture-client-secret",
    });
    expect(registered?.describe().capabilities.connectable).toBe(true);
  });
});
