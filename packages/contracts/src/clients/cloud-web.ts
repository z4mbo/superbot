import { z } from "zod";

/**
 * Cloud web: a hosted copy of the web app that signs people in with a central account and then
 * talks straight from the browser to each person's own servers. A server takes part only when
 * its operator names the hosted site's origins and the account issuer; see `docs/cloud-web.md`.
 */

/** Public and unauthenticated. Answers the hosted site only when the server allows its origin. */
export const CLOUD_HEALTH_PATH = "/api/health";
/** Who the request's cloud token signs in as on this server, or why it is refused. */
export const CLOUD_SESSION_PATH = "/api/cloud/session";

/**
 * Raised when the hosted site and a server stop understanding each other. A site shows a server
 * with a different number as incompatible instead of sending it requests it may misread.
 */
export const CLOUD_API_VERSION = 1;

export const CloudHealthSchema = z.object({
  ok: z.boolean(),
  /** What the operator calls this server; a label only. */
  name: z.string(),
  version: z.string(),
  cloudEnabled: z.boolean(),
  cloudApi: z.number().int(),
});
export type CloudHealth = z.infer<typeof CloudHealthSchema>;

/** Null for a body that is not a health answer, such as a proxy's own error page. */
export function parseCloudHealth(value: unknown): CloudHealth | null {
  const parsed = CloudHealthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Why a server turned a cloud token away, sent as `{ code }` with HTTP 401.
 * - `token_invalid`: bad signature, wrong issuer, expired, or issued for a site not allowed here.
 * - `email_unverified`: the account's email is missing from the token or not verified.
 * - `account_not_allowed`: the operator has not listed this account.
 * - `no_local_account`: listed, but no account on this server matches it.
 */
export const CLOUD_REFUSALS = [
  "token_invalid",
  "email_unverified",
  "account_not_allowed",
  "no_local_account",
] as const;
export type CloudRefusal = (typeof CLOUD_REFUSALS)[number];

export const CloudRefusalSchema = z.object({ code: z.enum(CLOUD_REFUSALS) });

/** Null when the body names no refusal this build knows. */
export function parseCloudRefusal(value: unknown): CloudRefusal | null {
  const parsed = CloudRefusalSchema.safeParse(value);
  return parsed.success ? parsed.data.code : null;
}

export const CloudSessionSchema = z.object({
  /** The account on this server the token signs in as. */
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
});
export type CloudSession = z.infer<typeof CloudSessionSchema>;
