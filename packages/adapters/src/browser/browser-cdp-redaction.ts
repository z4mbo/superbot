import { REDACTED_MARKER } from "@rakazo/core";

/**
 * Credentials taken out of a DevTools protocol result before the model sees it. A result can carry
 * what the page holds (a response body, a script's return value, request headers), and a page can
 * read its own cookies, so nothing here trusts the method that produced it:
 *
 * - every value under a key that names a credential (cookie, authorization, token, password,
 *   secret, api key, session, ...), in objects, header maps and `{name, value}` header lists;
 * - in a DOM node's attribute list: any attribute whose name names a credential (data-token),
 *   and the value or content of a password, hidden or credential-named field or meta tag;
 * - a base64 string whose decoded text carries a credential or one of the run's secrets, whole;
 * - inside every string: a credential after an auth scheme (`Bearer …`), a JWT, a credential-named
 *   `name=value` pair (cookies, query strings) or `name: value` pair (JSON, headers), and tokens
 *   with a well-known key prefix.
 *
 * Strings are read token by token, so the time stays linear in the size of the result however the
 * page shapes its text.
 */

const SENSITIVE_KEY_PARTS = [
  "cookie",
  "authorization",
  "token",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "apikey",
  "session",
  "credential",
  "privatekey",
  "csrf",
  "xsrf",
];
const SENSITIVE_KEYS = new Set(["auth", "sid", "jwt", "otp", "pin", "cvc", "cvv"]);
/** A name longer than this is prose, not a key. */
const MAX_KEY_CHARS = 64;
const AUTH_SCHEMES = new Set(["bearer", "basic", "token", "digest", "negotiate"]);
/** Below this depth a value is replaced, so a pathological result cannot exhaust the stack. */
const MAX_DEPTH = 200;
const TOO_DEEP = "[cut: nested too deeply]";

/** Anything but these separates tokens. `=` stays inside a token so a pair is read whole. */
const TOKEN = /[^\s"'<>;,&(){}[\]:|`\\/?#]+/g;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const PREFIXED_KEY =
  /^(?:(?:sk|rk)-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})$/;
/** Between a credential-named key and its value: quotes, spaces and one colon. */
const KEY_VALUE_GAP = /^["'\s\\]*:["'\s\\]*$/;
const SCHEME_GAP = /^\s+$/;
/**
 * A gap inside one value, such as the `/` of base64: what follows still belongs to it. A URL's
 * `?` or `#` starts its next part instead.
 */
const INSIDE_VALUE_GAP = /^[^\s"';,&?#]+$/;

/** Whether a key, header or field name names a credential. */
export function isSensitiveKey(key: string): boolean {
  if (key.length > MAX_KEY_CHARS) return false;
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return false;
  if (SENSITIVE_KEYS.has(normalized)) return true;
  // A dotted name is named by its last part, as a cookie such as connect.sid is.
  const last = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  if (last !== key.toLowerCase() && SENSITIVE_KEYS.has(last)) return true;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactToken(token: string): string {
  if (JWT.test(token) || PREFIXED_KEY.test(token)) return REDACTED_MARKER;
  const equals = token.indexOf("=");
  if (equals <= 0 || equals === token.length - 1) return token;
  const name = token.slice(0, equals);
  const value = token.slice(equals + 1);
  // A cookie or query parameter; `connect.sid` is named by its last part.
  const named = name.slice(name.lastIndexOf(".") + 1);
  if (isSensitiveKey(named) || JWT.test(value) || PREFIXED_KEY.test(value))
    return `${name}=${REDACTED_MARKER}`;
  return token;
}

/** One string with every credential shape inside it replaced. */
export function redactCredentialText(text: string): string {
  let previous: { token: string; end: number; redacted: boolean } | undefined;
  return text.replace(TOKEN, (token: string, offset: number) => {
    const gap = previous ? text.slice(previous.end, offset) : "";
    const after = previous;
    const redact = (redacted: boolean, shown: string) => {
      previous = { token, end: offset + token.length, redacted };
      return shown;
    };
    // A scheme word stays; the credential after it goes.
    if (AUTH_SCHEMES.has(token.toLowerCase())) return redact(false, token);
    if (after?.redacted && INSIDE_VALUE_GAP.test(gap)) return redact(true, REDACTED_MARKER);
    if (after && AUTH_SCHEMES.has(after.token.toLowerCase()) && SCHEME_GAP.test(gap))
      return redact(true, REDACTED_MARKER);
    if (after && isSensitiveKey(after.token) && gap.length <= 8 && KEY_VALUE_GAP.test(gap))
      return redact(true, REDACTED_MARKER);
    const shown = redactToken(token);
    return redact(shown !== token, shown);
  });
}

/** Below this length a string is a word, not an encoded body worth decoding. */
const BASE64_MIN_CHARS = 24;
const BASE64 = /^(?:[A-Za-z0-9+/]+={0,2}|[A-Za-z0-9_-]+={0,2})$/;

/** The text a base64 string encodes, when it decodes to readable text. */
function decodedBase64(value: string): string | undefined {
  if (value.length < BASE64_MIN_CHARS || !BASE64.test(value)) return undefined;
  const text = Buffer.from(
    value,
    value.includes("-") || value.includes("_") ? "base64url" : "base64",
  ).toString("utf8");
  // Mostly printable: a binary blob (an image) carries no text to redact.
  const printable = text.replace(/[^\x20-\x7e\t\r\n\u00a0-\uffff]/g, "").length;
  return text.length > 0 && !text.includes("\ufffd") && printable / text.length > 0.95
    ? text
    : undefined;
}

/** A base64 string that hides a credential or a run secret when decoded, or undefined. */
function hidesSecretEncoded(value: string, secrets: readonly string[]): boolean {
  const text = decodedBase64(value);
  if (text === undefined) return false;
  return (
    redactCredentialText(text) !== text || secrets.some((secret) => secret && text.includes(secret))
  );
}

/** Attributes whose value is what the field holds, or what a meta tag carries. */
const VALUE_ATTRIBUTES = new Set(["value", "content"]);

function redactAttributeList(attributes: unknown[], secrets: readonly string[]): unknown[] {
  // DOM nodes list attributes as alternating names and values.
  const names = new Map<string, string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = attributes[index];
    const value = attributes[index + 1];
    if (typeof name === "string" && typeof value === "string")
      names.set(name.toLowerCase(), value.toLowerCase());
  }
  const type = names.get("type");
  const hidesValue =
    type === "password" ||
    type === "hidden" ||
    [
      names.get("name"),
      names.get("id"),
      names.get("autocomplete"),
      names.get("property"),
      names.get("itemprop"),
    ].some((name) => name !== undefined && (isSensitiveKey(name) || name.startsWith("cc-")));
  return attributes.map((item, index) => {
    if (index % 2 === 1) {
      const name = String(attributes[index - 1]).toLowerCase();
      if (isSensitiveKey(name) || (hidesValue && VALUE_ATTRIBUTES.has(name)))
        return REDACTED_MARKER;
    }
    return redactValue(item, 1, secrets);
  });
}

function redactValue(value: unknown, depth: number, secrets: readonly string[]): unknown {
  if (typeof value === "string")
    return hidesSecretEncoded(value, secrets) ? REDACTED_MARKER : redactCredentialText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, secrets));
  const record = value as Record<string, unknown>;
  // A header given as {name, value}, as request and response header lists are.
  const headerName = typeof record.name === "string" ? record.name : undefined;
  const sensitiveHeader = headerName !== undefined && isSensitiveKey(headerName);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (isSensitiveKey(key) || (sensitiveHeader && key === "value"))
        return [redactCredentialText(key), REDACTED_MARKER];
      if (key === "attributes" && Array.isArray(item) && item.length % 2 === 0)
        return [key, redactAttributeList(item, secrets)];
      return [redactCredentialText(key), redactValue(item, depth + 1, secrets)];
    }),
  );
}

/**
 * A DevTools protocol result with every credential shape taken out. `secrets` are the run's own,
 * looked for inside base64 strings here; the caller redacts them everywhere else.
 */
export function redactCdpResult(value: unknown, secrets: readonly string[] = []): unknown {
  return redactValue(value, 0, secrets);
}

/** The forms a run secret can take in a page's text: as typed, URL-encoded, and base64-encoded. */
export function secretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    const encoded = Buffer.from(secret, "utf8").toString("base64");
    // A short secret's base64 is common text; only a long one is told apart.
    if (secret.length >= 8) {
      forms.add(encoded);
      forms.add(encoded.replace(/=+$/, ""));
    }
  }
  return [...forms];
}

/**
 * The result as the model reads it: whole when it fits in `maxChars` once serialized, else its
 * serialized start with a marker. Cut only after redaction, so no cut can split a credential
 * into pieces the redaction would no longer recognize.
 */
export function capCdpResult(
  value: unknown,
  maxChars: number,
): { result: unknown } | { resultText: string; truncated: true } {
  const text = JSON.stringify(value) ?? "null";
  if (text.length <= maxChars) return { result: value };
  return {
    resultText: `${text.slice(0, maxChars)}…[${text.length - maxChars} characters cut]`,
    truncated: true,
  };
}
