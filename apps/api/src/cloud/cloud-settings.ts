/**
 * The operator's cloud web settings (see `docs/cloud-web.md`). All off by default; naming some of
 * the required three but not all is a startup error, so a half-configured server never accepts
 * a cloud token.
 */
export interface CloudWebSettings {
  /** Exact origins, and patterns with one `*` in the first host label, from SUPERBOT_CLOUD_WEB_ORIGINS. */
  origins: string[];
  /** Compared exactly with a token's `iss`. */
  issuer: string;
  jwksUrl: string;
  /** Lowercased cloud email to the lowercased local email it signs in as, or null for the same one. */
  allowedEmails: Map<string, string | null>;
  serverName: string;
}

export function cloudWebFromEnv(source: NodeJS.ProcessEnv): CloudWebSettings | undefined {
  const origins = source.SUPERBOT_CLOUD_WEB_ORIGINS?.trim();
  const issuer = source.SUPERBOT_CLOUD_ISSUER?.trim();
  const emails = source.SUPERBOT_CLOUD_ALLOWED_EMAILS?.trim();
  if (!origins && !issuer && !emails) return undefined;
  if (!origins || !issuer || !emails) {
    throw new Error(
      "SUPERBOT_CLOUD_WEB_ORIGINS, SUPERBOT_CLOUD_ISSUER and SUPERBOT_CLOUD_ALLOWED_EMAILS must be configured together",
    );
  }
  const normalizedIssuer = httpsUrl(issuer, "SUPERBOT_CLOUD_ISSUER").replace(/\/+$/, "");
  const jwksUrl = source.SUPERBOT_CLOUD_JWKS_URL?.trim();
  return {
    origins: parseCloudOrigins(origins),
    issuer: normalizedIssuer,
    jwksUrl: jwksUrl
      ? httpsUrl(jwksUrl, "SUPERBOT_CLOUD_JWKS_URL")
      : `${normalizedIssuer}/.well-known/jwks.json`,
    allowedEmails: parseAllowedEmails(emails),
    serverName: source.SUPERBOT_CLOUD_SERVER_NAME?.trim() || "Superbot",
  };
}

function httpsUrl(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error();
    return url.href;
  } catch {
    throw new Error(`${name} must be an https URL`);
  }
}

const LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;
/** One `*` inside the first host label, after a literal prefix: `https://site-*.example.com`. */
const PATTERN = /^https:\/\/([a-z0-9-]+)\*([a-z0-9-]*)((?:\.[a-z0-9-]+)+)(:\d{1,5})?$/;

/**
 * Every entry is an origin with no path. A pattern's `*` matches letters, digits and hyphens
 * only, never a dot, so it can only stand for preview deployments under the operator's prefix.
 */
export function parseCloudOrigins(value: string): string[] {
  const origins = value
    .split(",")
    // A lone trailing slash is how origins are often pasted; any other path is refused below.
    .map((entry) =>
      entry
        .trim()
        .toLowerCase()
        .replace(/(?<=[^/])\/$/, ""),
    )
    .filter(Boolean);
  if (origins.length === 0) throw new Error("SUPERBOT_CLOUD_WEB_ORIGINS lists no origin");
  for (const origin of origins) {
    if (origin.includes("*")) {
      if (!PATTERN.test(origin)) throw invalidOrigin(origin);
      continue;
    }
    if (LOOPBACK.test(origin)) continue;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw invalidOrigin(origin);
    }
    if (url.protocol !== "https:" || url.origin !== origin) throw invalidOrigin(origin);
  }
  return [...new Set(origins)];
}

function invalidOrigin(origin: string) {
  // Only the shape is named, so a pasted secret is not logged.
  return new Error(
    `SUPERBOT_CLOUD_WEB_ORIGINS entries must be https origins with no path, such as https://app.example.com or https://app-*.example.com (${origin.includes("*") ? "pattern" : "origin"} rejected)`,
  );
}

/** Whether a request's Origin, or a token's `azp`, is one of the configured sites. */
export function cloudOriginAllowed(origins: readonly string[], candidate: string): boolean {
  const origin = candidate.toLowerCase();
  return origins.some((allowed) => {
    const star = allowed.indexOf("*");
    if (star === -1) return allowed === origin;
    const prefix = allowed.slice(0, star);
    const suffix = allowed.slice(star + 1);
    if (!origin.startsWith(prefix) || !origin.endsWith(suffix)) return false;
    const middle = origin.slice(prefix.length, origin.length - suffix.length);
    return /^[a-z0-9-]+$/.test(middle);
  });
}

function parseAllowedEmails(value: string): Map<string, string | null> {
  const allowed = new Map<string, string | null>();
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [cloud = "", local, ...rest] = trimmed
      .split("=")
      .map((part) => part.trim().toLowerCase());
    if (rest.length > 0 || !isEmail(cloud) || (local !== undefined && !isEmail(local))) {
      throw new Error(
        "SUPERBOT_CLOUD_ALLOWED_EMAILS entries must be email or email=local-email, comma-separated",
      );
    }
    allowed.set(cloud, local ?? null);
  }
  if (allowed.size === 0) throw new Error("SUPERBOT_CLOUD_ALLOWED_EMAILS lists no account");
  return allowed;
}

function isEmail(value: string): boolean {
  return /^[^\s@,=]+@[^\s@,=]+$/.test(value);
}
