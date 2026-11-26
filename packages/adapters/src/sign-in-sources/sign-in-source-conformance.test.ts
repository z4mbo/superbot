import { describe, expect, it } from "vitest";
import { EmulatorSignInSourceProvider } from "./sign-in-source-emulator.js";
import { createSignInSourceProvider, resolveSignInSourceProvider } from "./sign-in-source-factory.js";
import { signInSourceConformance, testContext } from "./sign-in-sources.test-support.js";

// The emulator's sign-in page sends the person straight back with everything in the address.
signInSourceConformance(
  "emulator",
  async () => new EmulatorSignInSourceProvider(),
  (start) => {
    const back = new URL(start.authorizeUrl);
    return {
      code: back.searchParams.get("code") ?? "",
      state: back.searchParams.get("state") ?? "",
      fragment: Object.fromEntries(new URLSearchParams(back.hash.slice(1))),
    };
  },
);

describe("sign-in source factory", () => {
  it("offers none unless a known provider is named", async () => {
    expect(resolveSignInSourceProvider({})).toBe("none");
    expect(resolveSignInSourceProvider({ SIGN_IN_SOURCE_PROVIDER: "made-up" })).toBe("none");
    expect(await createSignInSourceProvider({})).toBeNull();
    expect(
      (await createSignInSourceProvider({ SIGN_IN_SOURCE_PROVIDER: " Emulator " }))?.describe().id,
    ).toBe("emulator");
  });

  it("denies and expires on the emulator's marked sites", async () => {
    const source = new EmulatorSignInSourceProvider();
    const credential = await source.finishConnect(
      {
        pending: "c",
        redirectUri: "https://app.example.test/sign-in-source/callback",
        callback: { code: "c", state: "s", fragment: { key: "k" } },
      },
      testContext,
    );
    for (const [site, state] of [
      ["https://deny.example.test", "denied"],
      ["https://expire.example.test", "expired"],
    ] as const) {
      const request = await source.requestAccess(credential, { site, goal: "g" }, testContext);
      expect((await source.accessState(credential, request, testContext)).state).toBe(state);
    }
  });
});
