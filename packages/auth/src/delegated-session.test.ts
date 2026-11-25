import { describe, expect, it } from "vitest";
import { DELEGATED_SESSION_PATH, delegatedSessionToken } from "./delegated-session.js";
import { createAuth } from "./index.js";

const secret = "offline-auth-secret-at-least-32-characters";

describe("delegated sessions", () => {
  it("derives one token per account and key, which no other secret reproduces", () => {
    const token = delegatedSessionToken(secret, "user-1", "issuer\0session-1");
    expect(token).toMatch(/^[\w-]{32}$/);
    expect(delegatedSessionToken(secret, "user-1", "issuer\0session-1")).toBe(token);
    expect(delegatedSessionToken(secret, "user-2", "issuer\0session-1")).not.toBe(token);
    expect(delegatedSessionToken(secret, "user-1", "issuer\0session-2")).not.toBe(token);
    expect(delegatedSessionToken(`${secret}-other`, "user-1", "issuer\0session-1")).not.toBe(token);
  });

  it("is never served over HTTP", async () => {
    const auth = createAuth({} as never, {
      secret,
      baseURL: "https://api.example.test",
      webOrigin: "https://app.example.test",
      signupsEnabled: undefined,
      signupAllowlist: undefined,
    });
    const response = await auth.handler(
      new Request(`https://api.example.test/api/auth${DELEGATED_SESSION_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1", key: "anything" }),
      }),
    );
    expect(response.status).toBe(404);
  });
});
