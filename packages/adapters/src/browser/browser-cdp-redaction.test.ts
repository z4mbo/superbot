import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { REDACTED_MARKER } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  capCdpResult,
  isSensitiveKey,
  redactCdpResult,
  redactCredentialText,
  secretForms,
} from "./browser-cdp-redaction.js";
import { redactBrowserResult } from "./browser-tools.js";

const R = REDACTED_MARKER;
// Fake credentials, written in pieces so they never read as real ones.
const JWT_VALUE = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJhZGEifQ", "c2lnbmF0dXJl"].join(".");
const KEY_VALUE = `sk-${"fake".repeat(6)}`;

describe("isSensitiveKey", () => {
  it.each([
    "cookie",
    "Set-Cookie",
    "SET-COOKIE",
    "authorization",
    "Proxy-Authorization",
    "X-Api-Key",
    "x-auth-token",
    "access_token",
    "refreshToken",
    "password",
    "client_secret",
    "sessionId",
    "connect.sid",
    "sid",
    "X-CSRF-Token",
    "x-xsrf-token",
    "privateKey",
    "otp",
    "cvc",
  ])("%s names a credential", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["name", "value", "url", "nodeId", "title", "content-type", "x".repeat(65)])(
    "%s does not",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe("redactCdpResult", () => {
  it("masks credential-named keys at any depth, in objects and arrays", () => {
    expect(
      redactCdpResult({
        result: {
          value: {
            user: "ada",
            accessToken: "abc123",
            nested: [{ deeper: { password: "hunter2", note: "ok" } }, { apiKey: 42 }],
          },
        },
      }),
    ).toEqual({
      result: {
        value: {
          user: "ada",
          accessToken: R,
          nested: [{ deeper: { password: R, note: "ok" } }, { apiKey: R }],
        },
      },
    });
  });

  it("masks header maps whatever their case, and {name, value} header lists", () => {
    expect(
      redactCdpResult({
        headers: {
          "Content-Type": "text/html",
          Authorization: "Bearer abc",
          "SET-COOKIE": "sid=1; HttpOnly",
          cookie: "a=b",
          "Proxy-Authorization": "Basic Zm9vOmJhcg==",
          "X-Amz-Security-Token": "zzz",
        },
        list: [
          { name: "Cookie", value: "session=abc" },
          { name: "accept", value: "*/*" },
          { name: "x-csrf-token", value: "t0k" },
        ],
      }),
    ).toEqual({
      headers: {
        "Content-Type": "text/html",
        Authorization: R,
        "SET-COOKIE": R,
        cookie: R,
        "Proxy-Authorization": R,
        "X-Amz-Security-Token": R,
      },
      list: [
        { name: "Cookie", value: R },
        { name: "accept", value: "*/*" },
        { name: "x-csrf-token", value: R },
      ],
    });
  });

  it("masks credentials inside strings: auth schemes, JWTs, known key prefixes and named pairs", () => {
    // The scheme stays, so the reader knows what kind of credential was there.
    expect(redactCredentialText("Authorization: Bearer abc.def-ghi")).toBe(
      `Authorization: Bearer ${R}`,
    );
    expect(redactCredentialText("use Basic Zm9vOmJhcg== here")).toBe(`use Basic ${R} here`);
    expect(redactCredentialText(`token ${JWT_VALUE} end`)).toBe(`token ${R} end`);
    expect(redactCredentialText(`key ${KEY_VALUE}`)).toBe(`key ${R}`);
    expect(redactCredentialText('{"password": "hunter2", "user": "ada"}')).toBe(
      `{"password": "${R}", "user": "ada"}`,
    );
    expect(redactCredentialText("sid=abc; theme=dark; connect.sid=s%3Axyz")).toBe(
      `sid=${R}; theme=dark; connect.sid=${R}`,
    );
  });

  it("masks tokens in URL query strings and keeps the rest of the address", () => {
    expect(
      redactCdpResult({
        url: "https://api.example.test/v1/me?access_token=abc123&page=2&api_key=k3y#top",
        entries: [{ url: "https://example.test/cb?code=1&id_token=zz" }],
      }),
    ).toEqual({
      url: `https://api.example.test/v1/me?access_token=${R}&page=2&api_key=${R}#top`,
      entries: [{ url: `https://example.test/cb?code=1&id_token=${R}` }],
    });
  });

  it("masks a base64 body that decodes to a credential or a run secret, and keeps others", () => {
    const encode = (text: string) => Buffer.from(text).toString("base64");
    const withToken = encode('{"access_token":"abc123","scope":"read"}');
    const withSecret = encode("plain words around hunter2-fake-secret here");
    const harmless = encode("<html><body>Hello there, nothing to hide</body></html>");
    const image = Buffer.from(
      Array.from({ length: 64 }, (_, index) => (index * 37) % 256),
    ).toString("base64");
    expect(
      redactCdpResult({ body: withToken, other: withSecret, page: harmless, image }, [
        "hunter2-fake-secret",
      ]),
    ).toEqual({ body: R, other: R, page: harmless, image });
    // base64url, as JWT parts and data URLs often are.
    expect(redactCdpResult(Buffer.from("password=hunter2&x=1").toString("base64url"))).toBe(R);
  });

  it("masks credential attributes and field values in DOM attribute lists", () => {
    const node = (attributes: string[]) => redactCdpResult({ node: { attributes } }) as never;
    expect(node(["type", "password", "value", "hunter2"])).toEqual({
      node: { attributes: ["type", "password", "value", R] },
    });
    expect(node(["type", "hidden", "name", "state", "value", "xyz"])).toEqual({
      node: { attributes: ["type", "hidden", "name", "state", "value", R] },
    });
    expect(node(["name", "csrf-token", "content", "abc"])).toEqual({
      node: { attributes: ["name", "csrf-token", "content", R] },
    });
    expect(node(["autocomplete", "cc-number", "value", "4242"])).toEqual({
      node: { attributes: ["autocomplete", "cc-number", "value", R] },
    });
    expect(node(["data-auth-token", "abc", "class", "btn"])).toEqual({
      node: { attributes: ["data-auth-token", R, "class", "btn"] },
    });
    expect(node(["type", "text", "name", "q", "value", "shoes"])).toEqual({
      node: { attributes: ["type", "text", "name", "q", "value", "shoes"] },
    });
  });

  it("masks credential-named keys even when the key itself is the secret's only sign", () => {
    expect(redactCdpResult({ "Set-Cookie": ["a=1", "b=2"] })).toEqual({ "Set-Cookie": R });
  });

  it("stops at a depth no real result has, so a pathological one cannot exhaust the stack", () => {
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let index = 0; index < 5_000; index++) deep = { next: deep };
    expect(JSON.stringify(redactCdpResult(deep))).toContain("nested too deeply");
  });

  it("reads strings in linear time, whatever their shape", () => {
    const size = 200_000;
    expectLinearTime(() =>
      redactCredentialText(
        `${"a=".repeat(size)}${" Bearer".repeat(size)}${"token: ".repeat(size)}`,
      ),
    );
  });
});

describe("the run's own secrets", () => {
  it("are hidden as typed, URL-encoded and base64-encoded", () => {
    const secret = "p@ss word&1!";
    const forms = secretForms([secret, ""]);
    expect(forms).toEqual(
      expect.arrayContaining([
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString("base64"),
      ]),
    );
    const result = redactBrowserResult(
      {
        a: `typed ${secret}`,
        b: `https://x.test/?q=${encodeURIComponent(secret)}`,
        c: `blob ${Buffer.from(secret).toString("base64")}`,
      },
      forms,
    );
    expect(JSON.stringify(result)).not.toContain("ss word");
    expect(JSON.stringify(result)).not.toContain(encodeURIComponent(secret));
    expect(JSON.stringify(result)).not.toContain(Buffer.from(secret).toString("base64"));
  });

  it("keep a short secret's base64 out, since it would match ordinary text", () => {
    expect(secretForms(["abc"])).toEqual(["abc"]);
  });
});

describe("capCdpResult", () => {
  it("keeps a result that fits and cuts a larger one with a marker", () => {
    expect(capCdpResult({ a: 1 }, 100)).toEqual({ result: { a: 1 } });
    const capped = capCdpResult({ text: "x".repeat(500) }, 100);
    expect(capped).toMatchObject({ truncated: true });
    expect((capped as { resultText: string }).resultText).toMatch(
      /^.{100}…\[\d+ characters cut\]$/s,
    );
  });

  it("cuts only after redaction, so a cut never splits a credential into readable pieces", () => {
    const value = redactCdpResult({ pad: "x".repeat(90), token: "abcdefghijklmnop" });
    const capped = capCdpResult(value, 105) as { resultText: string };
    expect(capped.resultText).not.toContain("abcdef");
  });
});
