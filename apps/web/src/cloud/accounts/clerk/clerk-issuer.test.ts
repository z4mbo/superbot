import { describe, expect, it } from "vitest";
import { issuerFromPublishableKey } from "./clerk-issuer.js";

const key = (prefix: string, text: string) => `${prefix}${btoa(text)}`;

describe("issuerFromPublishableKey", () => {
  it("reads the instance's Frontend API host from a development key", () => {
    expect(
      issuerFromPublishableKey("pk_test_ZnJlc2gtbWlkZ2UtNjc5OS5jbGVyay5hY2NvdW50cy5kZXYk"),
    ).toBe("https://fresh-midge-6799.clerk.accounts.dev");
  });

  it("reads a production key and tolerates surrounding space", () => {
    expect(issuerFromPublishableKey(`  ${key("pk_live_", "clerk.example.com$")}\n`)).toBe(
      "https://clerk.example.com",
    );
  });

  it.each([
    ["nothing", undefined],
    ["an empty key", ""],
    ["a secret key", key("sk_test_", "fresh-midge-6799.clerk.accounts.dev$")],
    ["a key without the trailing marker", key("pk_test_", "fresh-midge-6799.clerk.accounts.dev")],
    ["a key naming a path", key("pk_test_", "evil.example/path$")],
    ["a key naming a single label", key("pk_test_", "localhost$")],
    ["a key that is not base64", "pk_test_%%%"],
  ])("refuses %s", (_label, value) => {
    expect(issuerFromPublishableKey(value)).toBeNull();
  });
});
