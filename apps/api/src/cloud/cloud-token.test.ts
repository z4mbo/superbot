import { deferred } from "@rakazo/core/test-async";
import { describe, expect, it } from "vitest";
import {
  CloudIssuerUnavailableError,
  createCloudTokenVerifier,
  isJwtShaped,
  JWKS_REFETCH_MS,
} from "./cloud-token.js";
import {
  createTestIssuer,
  TEST_ISSUER,
  TEST_JWKS_URL,
  TEST_NOW_SECONDS,
  TEST_SITE,
} from "./cloud-token.test-support.js";

function setup(options: { kids?: string[] } = {}) {
  const issuer = createTestIssuer(options);
  let nowMs = TEST_NOW_SECONDS * 1000;
  const verify = createCloudTokenVerifier({
    issuer: TEST_ISSUER,
    jwksUrl: TEST_JWKS_URL,
    originAllowed: (origin) => origin === TEST_SITE,
    fetch: issuer.fetch,
    now: () => nowMs,
  });
  return {
    issuer,
    verify,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const invalid = { ok: false, refusal: "token_invalid" };

describe("cloud token verification", () => {
  it("accepts a valid token and reads its account claims", async () => {
    const { issuer, verify } = setup();
    expect(await verify(issuer.token({ email: "Person@Example.test" }))).toEqual({
      ok: true,
      claims: {
        email: "Person@Example.test",
        normalizedEmail: "person@example.test",
        name: "Test Person",
        azp: TEST_SITE,
        session: "sess_1",
      },
    });
    expect(issuer.fetched).toEqual([TEST_JWKS_URL]);
  });

  it("accepts the issuer written with a trailing slash", async () => {
    const { issuer, verify } = setup();
    expect((await verify(issuer.token({ iss: `${TEST_ISSUER}/` }))).ok).toBe(true);
  });

  it("refuses an expired token, allowing five seconds of clock skew", async () => {
    const { issuer, verify } = setup();
    expect((await verify(issuer.token({ exp: TEST_NOW_SECONDS - 4 }))).ok).toBe(true);
    expect(await verify(issuer.token({ exp: TEST_NOW_SECONDS - 5 }))).toEqual(invalid);
    expect(await verify(issuer.token({ exp: undefined }))).toEqual(invalid);
  });

  it("refuses a token that is not valid yet, allowing five seconds of clock skew", async () => {
    const { issuer, verify } = setup();
    expect((await verify(issuer.token({ nbf: TEST_NOW_SECONDS + 5 }))).ok).toBe(true);
    expect(await verify(issuer.token({ nbf: TEST_NOW_SECONDS + 6 }))).toEqual(invalid);
  });

  it("refuses a token from another issuer", async () => {
    const { issuer, verify } = setup();
    expect(await verify(issuer.token({ iss: "https://other.example.test" }))).toEqual(invalid);
    expect(await verify(issuer.token({ iss: `${TEST_ISSUER}/tenant` }))).toEqual(invalid);
  });

  it("refuses a token issued to a site that is not allowed, or to no site", async () => {
    const { issuer, verify } = setup();
    expect(await verify(issuer.token({ azp: "https://evil.example.test" }))).toEqual(invalid);
    expect(await verify(issuer.token({ azp: undefined }))).toEqual(invalid);
  });

  it("refuses a bad signature", async () => {
    const { issuer, verify } = setup();
    const [header, , signature] = issuer.token().split(".");
    const forged = issuer.token({ email: "admin@example.test" }).split(".")[1];
    expect(await verify(`${header}.${forged}.${signature}`)).toEqual(invalid);
  });

  it("refuses alg none and HMAC tokens", async () => {
    const { issuer, verify } = setup();
    expect(await verify(issuer.unsignedToken({ alg: "none", kid: "key-1" }))).toEqual(invalid);
    expect(await verify(issuer.unsignedToken({ alg: "HS256", kid: "key-1" }))).toEqual(invalid);
    expect(await verify(issuer.token({}, { alg: "RS512" }))).toEqual(invalid);
    expect(await verify(issuer.token({}, { kid: undefined }))).toEqual(invalid);
  });

  it("refuses an email that is missing or not verified", async () => {
    const { issuer, verify } = setup();
    const unverified = { ok: false, refusal: "email_unverified" };
    expect(await verify(issuer.token({ email_verified: false }))).toEqual(unverified);
    expect(await verify(issuer.token({ email_verified: "true" }))).toEqual(unverified);
    expect(await verify(issuer.token({ email: undefined }))).toEqual(unverified);
  });

  it("refuses malformed tokens", async () => {
    const { verify } = setup();
    for (const token of ["a.b.c", "..", "not-a-token", "a.b", "e30.e30.%%%"]) {
      expect(await verify(token), token).toEqual(invalid);
    }
  });

  it("refetches the key set once for an unknown key id, then at most once a minute", async () => {
    const { issuer, verify, advance } = setup({ kids: ["key-1", "key-2"] });
    issuer.publish(["key-1"]);
    expect((await verify(issuer.token())).ok).toBe(true);
    expect(issuer.fetched).toHaveLength(1);

    // key-2 is unknown and the last fetch was just now: no new fetch.
    const rotated = issuer.token({}, { kid: "key-2" });
    expect(await verify(rotated)).toEqual(invalid);
    expect(issuer.fetched).toHaveLength(1);

    // A minute on, the issuer has rotated; one refetch finds the new key.
    issuer.publish(["key-1", "key-2"]);
    advance(JWKS_REFETCH_MS);
    expect((await verify(rotated)).ok).toBe(true);
    expect(issuer.fetched).toHaveLength(2);

    // An id the issuer never published waits another minute.
    expect(await verify(issuer.token({}, { kid: "key-3" }))).toEqual(invalid);
    expect(issuer.fetched).toHaveLength(2);
  });

  it("shares one key set fetch between concurrent verifications", async () => {
    const issuer = createTestIssuer();
    const gate = deferred<void>();
    let calls = 0;
    const verify = createCloudTokenVerifier({
      issuer: TEST_ISSUER,
      jwksUrl: TEST_JWKS_URL,
      originAllowed: (origin) => origin === TEST_SITE,
      fetch: (async (input: string) => {
        calls += 1;
        await gate.promise;
        return issuer.fetch(input);
      }) as typeof fetch,
      now: () => TEST_NOW_SECONDS * 1000,
    });
    const results = Promise.all([verify(issuer.token()), verify(issuer.token())]);
    gate.resolve();
    expect((await results).map((result) => result.ok)).toEqual([true, true]);
    expect(calls).toBe(1);
  });

  it("keeps using the cached keys when a refetch fails", async () => {
    const { issuer, verify, advance } = setup();
    expect((await verify(issuer.token())).ok).toBe(true);
    issuer.fail(true);
    advance(JWKS_REFETCH_MS);
    expect(await verify(issuer.token({}, { kid: "unknown" }))).toEqual(invalid);
    expect(issuer.fetched).toHaveLength(2);
    expect((await verify(issuer.token())).ok).toBe(true);
  });

  it("reports the issuer unavailable when no key set has ever been fetched", async () => {
    const { issuer, verify, advance } = setup();
    issuer.fail(true);
    await expect(verify(issuer.token())).rejects.toBeInstanceOf(CloudIssuerUnavailableError);
    // A retry right away does not fetch again.
    await expect(verify(issuer.token())).rejects.toBeInstanceOf(CloudIssuerUnavailableError);
    expect(issuer.fetched).toHaveLength(1);
    issuer.fail(false);
    advance(5_000);
    expect((await verify(issuer.token())).ok).toBe(true);
  });

  it("tells a cloud token from a signed session bearer", () => {
    expect(isJwtShaped("a.b.c")).toBe(true);
    expect(isJwtShaped("a.b.")).toBe(true);
    expect(isJwtShaped("session-token.c2lnbmF0dXJl+/=")).toBe(false);
    expect(isJwtShaped("device-token")).toBe(false);
  });
});
