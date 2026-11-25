const PUBLISHABLE_KEY = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * The issuer of the instance's session tokens, read from its publishable key: `pk_test_` or
 * `pk_live_`, then base64 of the instance's Frontend API host followed by `$`. Null for anything
 * else, so a mistyped key is reported at startup instead of as refused tokens later.
 */
export function issuerFromPublishableKey(key: string | undefined): string | null {
  const encoded = PUBLISHABLE_KEY.exec(key?.trim() ?? "")?.[1];
  if (!encoded) return null;
  let decoded: string;
  try {
    decoded = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
  if (!decoded.endsWith("$")) return null;
  const host = decoded.slice(0, -1).toLowerCase();
  return HOST.test(host) ? `https://${host}` : null;
}
