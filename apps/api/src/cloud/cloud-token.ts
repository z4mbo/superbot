import type { KeyObject } from "node:crypto";
import { createPublicKey, verify } from "node:crypto";
import type { CloudRefusal } from "@rakazo/contracts/cloud-web";
import { deadlineSignal } from "@rakazo/core";

/** Clocks on two machines disagree a little; a token is honoured this long past either edge. */
export const CLOUD_TOKEN_SKEW_SECONDS = 5;
/** An unknown key id fetches the key set again at most this often. */
export const JWKS_REFETCH_MS = 60_000;
/** Without any key set yet, a failed fetch is retried sooner than an unknown key. */
const JWKS_RETRY_MS = 5_000;
const JWKS_TIMEOUT_MS = 5_000;
const MIN_RSA_BITS = 2048;

export interface CloudTokenClaims {
  email: string;
  /** Lowercased; how the operator's list names accounts. */
  normalizedEmail: string;
  name: string | null;
  /** The hosted site's origin the token was issued to. */
  azp: string;
  /** One sign-in at the issuer; local sessions are reused per value. */
  session: string;
}

export type CloudTokenResult =
  | { ok: true; claims: CloudTokenClaims }
  | { ok: false; refusal: Extract<CloudRefusal, "token_invalid" | "email_unverified"> };

/** The issuer's keys could not be read and none are cached, so no token can be checked yet. */
export class CloudIssuerUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("The account issuer's signing keys could not be fetched", options);
    this.name = "CloudIssuerUnavailableError";
  }
}

export interface CloudTokenVerifierOptions {
  issuer: string;
  jwksUrl: string;
  /** Whether a token's `azp` names a site this server allows. */
  originAllowed: (origin: string) => boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Three dot-separated parts, like a compact JWT. A signed local session token has two, so a
 * bearer with three parts is always a cloud token, refused here rather than passed on if bad.
 */
export function isJwtShaped(value: string): boolean {
  return value.split(".").length === 3;
}

const SEGMENTS = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/**
 * Verifies RS256 tokens from one issuer: signature against its published key set, issuer,
 * validity window, the site it was issued to, and a verified email. Keys are cached in memory.
 */
export function createCloudTokenVerifier(options: CloudTokenVerifierOptions) {
  const keys = createKeySet(options);
  const now = options.now ?? Date.now;
  const invalid: CloudTokenResult = { ok: false, refusal: "token_invalid" };
  return async (token: string): Promise<CloudTokenResult> => {
    if (!SEGMENTS.test(token)) return invalid;
    const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] = token.split(".");
    const header = decodeJson(encodedHeader);
    const payload = decodeJson(encodedPayload);
    if (!header || !payload) return invalid;
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return invalid;
    const key = await keys.find(header.kid);
    if (!key) return invalid;
    const signed = verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key,
      Buffer.from(encodedSignature, "base64url"),
    );
    if (!signed) return invalid;
    if (payload.iss !== options.issuer && payload.iss !== `${options.issuer}/`) return invalid;
    const seconds = now() / 1000;
    if (typeof payload.exp !== "number" || seconds >= payload.exp + CLOUD_TOKEN_SKEW_SECONDS)
      return invalid;
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== "number" || seconds + CLOUD_TOKEN_SKEW_SECONDS < payload.nbf)
        return invalid;
    }
    if (typeof payload.azp !== "string" || !options.originAllowed(payload.azp)) return invalid;
    const session = typeof payload.sid === "string" && payload.sid ? payload.sid : payload.sub;
    if (typeof session !== "string" || !session) return invalid;
    if (typeof payload.email !== "string" || !payload.email || payload.email_verified !== true) {
      return { ok: false, refusal: "email_unverified" };
    }
    return {
      ok: true,
      claims: {
        email: payload.email,
        normalizedEmail: payload.email.trim().toLowerCase(),
        name: typeof payload.name === "string" && payload.name.trim() ? payload.name : null,
        azp: payload.azp,
        session,
      },
    };
  };
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The issuer's public keys by id. An unknown id refetches at most once per JWKS_REFETCH_MS, all
 * concurrent lookups share one fetch, and a failed fetch keeps the keys already held.
 */
function createKeySet(options: CloudTokenVerifierOptions) {
  const fetchKeys = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let held: Map<string, KeyObject> | undefined;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;

  const refresh = () => {
    inFlight ??= (async () => {
      fetchedAt = now();
      try {
        const response = await fetchKeys(options.jwksUrl, {
          headers: { accept: "application/json" },
          signal: deadlineSignal(JWKS_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
        held = parseKeySet(await response.json());
      } catch (error) {
        if (!held) throw new CloudIssuerUnavailableError({ cause: error });
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    async find(kid: string): Promise<KeyObject | undefined> {
      const known = held?.get(kid);
      if (known) return known;
      if (inFlight) await inFlight;
      else if (now() - fetchedAt >= (held ? JWKS_REFETCH_MS : JWKS_RETRY_MS)) await refresh();
      else if (!held) throw new CloudIssuerUnavailableError();
      return held?.get(kid);
    },
  };
}

function parseKeySet(value: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const listed =
    value && typeof value === "object" && Array.isArray((value as { keys?: unknown }).keys)
      ? (value as { keys: unknown[] }).keys
      : [];
  for (const jwk of listed) {
    if (!jwk || typeof jwk !== "object") continue;
    const { kid, kty, use, alg, n, e } = jwk as Record<string, unknown>;
    if (typeof kid !== "string" || kty !== "RSA" || typeof n !== "string" || typeof e !== "string")
      continue;
    if ((use !== undefined && use !== "sig") || (alg !== undefined && alg !== "RS256")) continue;
    try {
      const key = createPublicKey({ key: { kty, n, e }, format: "jwk" });
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_RSA_BITS) keys.set(kid, key);
    } catch {
      // A malformed key is left out; tokens it signed are refused like any unknown key.
    }
  }
  return keys;
}
