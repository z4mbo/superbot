import type { DelegatedSession, DelegatedSessionInput } from "@rakazo/auth";
import type { CloudHealth, CloudRefusal, CloudSession } from "@rakazo/contracts";
import { CLOUD_API_VERSION, CLOUD_HEALTH_PATH, CLOUD_SESSION_PATH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { LocalAccount, LocalAccountDirectory } from "./cloud-accounts.js";
import { mapCloudAccount, prismaAccountDirectory } from "./cloud-accounts.js";
import type { CloudWebSettings } from "./cloud-settings.js";
import { cloudOriginAllowed } from "./cloud-settings.js";
import {
  CloudIssuerUnavailableError,
  createCloudTokenVerifier,
  isJwtShaped,
} from "./cloud-token.js";

/** How long a verified account keeps its local session in memory before it is looked up again. */
const SIGNED_IN_CACHE_MS = 60_000;
const SIGNED_IN_CACHE_SIZE = 1_000;
const PREFLIGHT_MAX_AGE_SECONDS = 600;
const ISSUER_RETRY_AFTER_SECONDS = 5;

export interface CloudWebDeps {
  settings: CloudWebSettings;
  prisma: PrismaClient;
  /** Opens or finds the local session for a verified account; null when sign-in rules refuse it. */
  delegatedSession: (input: DelegatedSessionInput) => Promise<DelegatedSession | null>;
  /** Origins that already get credentialed CORS; they keep exactly that. */
  trustedOrigin: (origin: string) => boolean;
  /** The response headers a page may read, as for the server's own web app. */
  exposeHeaders: string[];
  clientIp: (c: Context) => string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests replace the database reads. */
  directory?: LocalAccountDirectory;
}

type SignedIn = { account: LocalAccount; bearer: string; until: number };

/**
 * Lets the hosted web app call this server: CORS for its origins without credentials, and its
 * account token turned into an ordinary local session before anything reads the session.
 */
export function createCloudWeb(deps: CloudWebDeps) {
  const { settings } = deps;
  const now = deps.now ?? Date.now;
  const verifyToken = createCloudTokenVerifier({
    issuer: settings.issuer,
    jwksUrl: settings.jwksUrl,
    originAllowed: (origin) => cloudOriginAllowed(settings.origins, origin),
    fetch: deps.fetch,
    now,
  });
  const directory = deps.directory ?? prismaAccountDirectory(deps.prisma);
  const signedIn = new Map<string, SignedIn>();
  /** The local account each signed-in request was given, for the session route. */
  const requestAccounts = new WeakMap<Request, LocalAccount>();

  const isCloudOrigin = (origin: string) =>
    !deps.trustedOrigin(origin) && cloudOriginAllowed(settings.origins, origin);

  const cloudCors = cors({
    origin: (origin) => origin,
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
    exposeHeaders: deps.exposeHeaders,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  });

  const signIn = async (c: Context, token: string): Promise<SignedIn | CloudRefusal> => {
    const verified = await verifyToken(token);
    if (!verified.ok) return verified.refusal;
    const { claims } = verified;
    const key = `${claims.normalizedEmail}\0${claims.session}`;
    const cached = signedIn.get(key);
    if (cached && cached.until > now()) return cached;
    signedIn.delete(key);
    const result = await runAsSystem("cloud web sign-in", async () => {
      const mapped = await mapCloudAccount(
        settings.allowedEmails,
        directory,
        claims.normalizedEmail,
      );
      if (!mapped.ok) return mapped.refusal;
      const session = await deps.delegatedSession({
        userId: mapped.account.id,
        key: `cloud-web\0${settings.issuer}\0${claims.session}`,
        userAgent: c.req.header("user-agent"),
        ipAddress: deps.clientIp(c),
      });
      return session ? { account: mapped.account, bearer: session.bearer } : "no_local_account";
    });
    if (typeof result === "string") return result;
    const entry = { ...result, until: now() + SIGNED_IN_CACHE_MS };
    if (signedIn.size >= SIGNED_IN_CACHE_SIZE) {
      const oldest = signedIn.keys().next();
      if (!oldest.done) signedIn.delete(oldest.value);
    }
    signedIn.set(key, entry);
    return entry;
  };

  return {
    isCloudOrigin,

    /** The cloud sites' CORS; every other origin is answered by `trusted`, exactly as before. */
    cors(trusted: MiddlewareHandler): MiddlewareHandler {
      return (c, next) => {
        const origin = c.req.header("origin");
        if (!origin || !isCloudOrigin(origin)) return trusted(c, next);
        // A public site calling a server on a private or tailnet address asks first.
        if (
          c.req.method === "OPTIONS" &&
          c.req.header("access-control-request-private-network") === "true"
        ) {
          c.res.headers.set("Access-Control-Allow-Private-Network", "true");
        }
        return cloudCors(c, next);
      };
    },

    /**
     * Turns `Authorization: Bearer <cloud token>` into the local session's signed bearer, so
     * every later reader sees an ordinary signed-in request. A token that fails is answered here
     * and never continues as an anonymous request.
     */
    signIn: (async (c, next) => {
      const header = c.req.header("authorization");
      const token = header?.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : "";
      if (!isJwtShaped(token) || c.req.path === CLOUD_HEALTH_PATH) return next();
      let result: SignedIn | CloudRefusal;
      try {
        result = await signIn(c, token);
      } catch (error) {
        if (!(error instanceof CloudIssuerUnavailableError)) throw error;
        return c.json({ error: "Account issuer unavailable" }, 503, {
          "cache-control": "no-store",
          "retry-after": String(ISSUER_RETRY_AFTER_SECONDS),
        });
      }
      if (typeof result === "string") {
        return c.json({ code: result }, 401, { "cache-control": "no-store" });
      }
      const headers = new Headers(c.req.raw.headers);
      headers.set("authorization", `Bearer ${result.bearer}`);
      // The token alone signs this request in; a cookie never adds to it.
      headers.delete("cookie");
      c.req.raw = new Request(c.req.raw, { headers });
      requestAccounts.set(c.req.raw, result.account);
      await next();
      // Signing out, or revoking sessions, ends the session the cache points at.
      if (c.req.method !== "GET" && c.req.path.startsWith("/api/auth/")) {
        for (const [key, entry] of signedIn) {
          if (entry.bearer === result.bearer) signedIn.delete(key);
        }
      }
      withoutSessionCredentials(c);
    }) satisfies MiddlewareHandler,

    /** `GET /api/cloud/session`; mount after `signIn`. */
    mount(app: Hono) {
      app.get(CLOUD_SESSION_PATH, (c) => {
        const account = requestAccounts.get(c.req.raw);
        if (!account) {
          return c.json({ code: "token_invalid" satisfies CloudRefusal }, 401, {
            "cache-control": "no-store",
          });
        }
        return c.json(
          {
            user: { id: account.id, email: account.email, name: account.name },
          } satisfies CloudSession,
          200,
          { "cache-control": "no-store" },
        );
      });
    },
  };
}

export type CloudWeb = ReturnType<typeof createCloudWeb>;

/**
 * The local session stays on the server: a cloud request never gets its cookie or the bearer the
 * auth library offers native clients, so the browser holds no long-lived credential for it.
 */
function withoutSessionCredentials(c: Context) {
  const names = ["set-cookie", "set-auth-token"];
  if (!names.some((name) => c.res.headers.has(name))) return;
  try {
    for (const name of names) c.res.headers.delete(name);
  } catch (error) {
    // A response passed through from fetch keeps immutable headers; answer with a copy.
    if (!(error instanceof TypeError)) throw error;
    const response = c.res;
    const headers = new Headers(response.headers);
    for (const name of names) headers.delete(name);
    c.res = undefined;
    c.res = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** `GET /api/health`: public, no session and no database, whether or not cloud web is on. */
export function mountCloudHealth(
  app: Hono,
  health: { name: string; version: string; cloudEnabled: boolean },
) {
  app.get(CLOUD_HEALTH_PATH, (c) =>
    c.json({ ok: true, ...health, cloudApi: CLOUD_API_VERSION } satisfies CloudHealth, 200, {
      "cache-control": "no-store",
    }),
  );
}
