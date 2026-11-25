import type { AdapterContext, SignInSourceProvider } from "@rakazo/adapter-kit";
import { SignInSourceDisconnected } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { OnePasswordSignInSource } from "../providers/sign-in-source/onepassword/onepassword-sign-in-source.js";
import { EmulatorSignInSourceProvider } from "./sign-in-source-emulator.js";
import { createSignInSourceProvider, resolveSignInSourceProvider } from "./sign-in-source-factory.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};
const REDIRECT = "https://app.example.test/sign-in-source/callback";

/** What every sign-in source owes core, run offline against each provider's fake. */
function conformance(name: string, make: () => Promise<SignInSourceProvider>) {
  describe(`${name} sign-in source contract`, () => {
    it("describes itself with a name, a grant lifetime and its approval link schemes", async () => {
      const source = await make();
      const { capabilities } = source.describe();
      expect(source.displayName.length).toBeGreaterThan(0);
      expect(capabilities.grantDays).toBeGreaterThan(0);
      expect(capabilities.approvalLinkSchemes.length).toBeGreaterThan(0);
    });

    it("connects, asks for a login, and fills only through its own call with the grant reference", async () => {
      const source = await make();
      const start = await source.beginConnect({ redirectUri: REDIRECT }, context);
      const back = new URL(start.authorizeUrl);
      const credential = await source.finishConnect(
        {
          pending: start.pending,
          redirectUri: REDIRECT,
          callback: {
            code: back.searchParams.get("code") ?? "",
            state: back.searchParams.get("state") ?? "",
            fragment: Object.fromEntries(new URLSearchParams(back.hash.slice(1))),
          },
        },
        context,
      );
      const request = await source.requestAccess(
        credential,
        { site: "https://example.test", goal: "Sign in" },
        context,
      );
      expect(
        source
          .describe()
          .capabilities.approvalLinkSchemes.some((scheme) => request.approvalLink.startsWith(scheme)),
      ).toBe(true);
      const answer = await source.accessState(credential, request, context);
      expect(answer.state).toBe("approved");
      if (answer.state !== "approved") return;
      const call = source.fillCall(credential, answer.reference);
      expect(Object.values(call.params)).toContain(answer.reference);

      await source.disconnect(credential, context);
      await expect(source.refresh(credential, context)).rejects.toBeInstanceOf(
        SignInSourceDisconnected,
      );
    });
  });
}

conformance("emulator", async () => new EmulatorSignInSourceProvider());

describe("sign-in source factory", () => {
  it("offers none unless a known provider is named", async () => {
    expect(resolveSignInSourceProvider({})).toBe("none");
    expect(resolveSignInSourceProvider({ SIGN_IN_SOURCE_PROVIDER: "made-up" })).toBe("none");
    expect(await createSignInSourceProvider({})).toBeNull();
    expect(
      (await createSignInSourceProvider({ SIGN_IN_SOURCE_PROVIDER: "emulator" }))?.describe().id,
    ).toBe("emulator");
  });

  it("lists the password manager without a client registration, but cannot connect it", async () => {
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

  it("denies and expires on the emulator's marked sites", async () => {
    const source = new EmulatorSignInSourceProvider();
    const credential = await source.finishConnect(
      {
        pending: "c",
        redirectUri: REDIRECT,
        callback: { code: "c", state: "s", fragment: { key: "k" } },
      },
      context,
    );
    for (const [site, state] of [
      ["https://deny.example.test", "denied"],
      ["https://expire.example.test", "expired"],
    ] as const) {
      const request = await source.requestAccess(credential, { site, goal: "g" }, context);
      expect((await source.accessState(credential, request, context)).state).toBe(state);
    }
  });
});
