import { createHmac } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";

/**
 * A session the server opens for an account another issuer vouched for, such as a hosted web app
 * whose short-lived token the API already verified. Its token is derived from the auth secret and
 * a caller-chosen key, so every API instance finds the same session for the same key without a
 * table of its own, and repeated requests reuse one session instead of adding a row each.
 *
 * Server only: the router never serves it, so it is reachable only through `auth.api`.
 */
export const DELEGATED_SESSION_PATH = "/delegated-session";

export type DelegatedSessionInput = {
  userId: string;
  /** Stable for one outside session, e.g. its issuer and session id. */
  key: string;
  userAgent?: string;
  ipAddress?: string;
};
/** `bearer` is what the signed bearer plugin accepts as `Authorization: Bearer`. */
export type DelegatedSession = { bearer: string; sessionId: string };

export function delegatedSessions() {
  return {
    id: "delegated-sessions",
    endpoints: {
      delegatedSession: createAuthEndpoint(
        DELEGATED_SESSION_PATH,
        { method: "POST", body: delegatedSessionBody, metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const { userId, key, userAgent, ipAddress } = ctx.body;
          const { secret, internalAdapter: adapter, sessionConfig } = ctx.context;
          const token = delegatedSessionToken(secret, userId, key);
          let found = await adapter.findSession(token);
          if (found && found.session.expiresAt.getTime() <= Date.now()) {
            await adapter.deleteSession(token);
            found = null;
          }
          if (!found) {
            let failure: unknown;
            try {
              // Runs the session hooks, so the same admission rules as any sign-in apply.
              await adapter.createSession(
                userId,
                false,
                {
                  token,
                  expiresAt: new Date(Date.now() + sessionConfig.expiresIn * 1000),
                  userAgent: userAgent ?? "",
                  ipAddress: ipAddress ?? "",
                },
                true,
              );
            } catch (error) {
              if (error instanceof APIError) throw error;
              failure = error;
            }
            // A failed create is fine when another instance created the same session first.
            found = await adapter.findSession(token);
            if (!found && failure) throw failure;
          }
          if (!found || found.user.id !== userId) {
            throw new APIError("FORBIDDEN", { message: "This account cannot sign in" });
          }
          return ctx.json({
            bearer: signedSessionToken(secret, token),
            sessionId: found.session.id,
          } satisfies DelegatedSession);
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

/** A Standard Schema the endpoint validates its body with, without a schema library here. */
const delegatedSessionBody = {
  "~standard": {
    version: 1,
    vendor: "rakazo",
    types: undefined as unknown as { input: DelegatedSessionInput; output: DelegatedSessionInput },
    validate: (value: unknown) => {
      const { userId, key, userAgent, ipAddress } = (value ?? {}) as Record<string, unknown>;
      const optional = (field: unknown) => (typeof field === "string" ? field : undefined);
      if (typeof userId !== "string" || !userId || typeof key !== "string" || !key) {
        return { issues: [{ message: "userId and key are required" }] };
      }
      return {
        value: { userId, key, userAgent: optional(userAgent), ipAddress: optional(ipAddress) },
      };
    },
  },
} as const;

/** Bound to the account too, so a key reused for another account never finds this session. */
export function delegatedSessionToken(secret: string, userId: string, key: string): string {
  return createHmac("sha256", secret)
    .update(`delegated-session\0${userId}\0${key}`)
    .digest("base64url")
    .slice(0, 32);
}

/** The session cookie's signed value, `token.signature`, as the signed bearer plugin checks it. */
export function signedSessionToken(secret: string, token: string): string {
  return `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;
}
