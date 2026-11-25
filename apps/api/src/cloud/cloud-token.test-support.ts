import { createHmac, generateKeyPairSync, sign } from "node:crypto";

export const TEST_ISSUER = "https://accounts.example.test";
export const TEST_JWKS_URL = `${TEST_ISSUER}/.well-known/jwks.json`;
export const TEST_SITE = "https://hosted.example.test";
/** Seconds since the epoch the test clock starts at. */
export const TEST_NOW_SECONDS = 1_800_000_000;

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * An offline stand-in for an account issuer: RSA keys it publishes as a JWKS through an injected
 * `fetch`, and tokens it signs with them. Counts key-set fetches so tests can assert the cache.
 */
export function createTestIssuer(options: { kids?: string[] } = {}) {
  const pairs = new Map(
    (options.kids ?? ["key-1"]).map((kid) => [
      kid,
      generateKeyPairSync("rsa", { modulusLength: 2048 }),
    ]),
  );
  let published = [...pairs.keys()];
  let failing = false;
  const fetched: string[] = [];
  const fetchKeys = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    if (failing) throw new TypeError("fetch failed");
    const keys = published.map((kid) => ({
      ...pairs.get(kid)!.publicKey.export({ format: "jwk" }),
      kid,
      use: "sig",
      alg: "RS256",
    }));
    return Response.json({ keys });
  }) as typeof fetch;

  const claims = (overrides: Record<string, unknown> = {}) => ({
    iss: TEST_ISSUER,
    sub: "user_1",
    sid: "sess_1",
    azp: TEST_SITE,
    iat: TEST_NOW_SECONDS - 1,
    nbf: TEST_NOW_SECONDS - 1,
    exp: TEST_NOW_SECONDS + 60,
    email: "person@example.test",
    email_verified: true,
    name: "Test Person",
    ...overrides,
  });

  return {
    fetch: fetchKeys,
    fetched,
    /** Publishes only these key ids from now on. */
    publish(kids: string[]) {
      published = kids;
    },
    fail(value: boolean) {
      failing = value;
    },
    claims,
    /** An RS256 token signed by `kid`, with the claims merged over a valid default set. */
    token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
      const head = { alg: "RS256", typ: "JWT", kid: [...pairs.keys()][0], ...header };
      const signingInput = `${encode(head)}.${encode(claims(overrides))}`;
      const pair = pairs.get(String(head.kid)) ?? [...pairs.values()][0]!;
      const signature = sign("RSA-SHA256", Buffer.from(signingInput), pair.privateKey);
      return `${signingInput}.${signature.toString("base64url")}`;
    },
    /** A token with a chosen header and no RSA signature, for algorithm confusion cases. */
    unsignedToken(header: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
      const signingInput = `${encode(header)}.${encode(claims(overrides))}`;
      if (header.alg === "HS256") {
        const mac = createHmac("sha256", "shared-secret").update(signingInput).digest("base64url");
        return `${signingInput}.${mac}`;
      }
      return `${signingInput}.`;
    },
  };
}
