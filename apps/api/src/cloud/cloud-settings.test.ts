import { describe, expect, it } from "vitest";
import { cloudOriginAllowed, cloudWebFromEnv, parseCloudOrigins } from "./cloud-settings.js";

const configured = {
  SUPERBOT_CLOUD_WEB_ORIGINS: "https://hosted.example.com, https://hosted-*.example.com",
  SUPERBOT_CLOUD_ISSUER: "https://accounts.example.com/",
  SUPERBOT_CLOUD_ALLOWED_EMAILS: "Owner@Example.com, friend@example.com=Local@Example.com",
};

describe("cloud web settings", () => {
  it("is off when none of the settings is given", () => {
    expect(cloudWebFromEnv({})).toBeUndefined();
    expect(cloudWebFromEnv({ SUPERBOT_CLOUD_SERVER_NAME: "Home" })).toBeUndefined();
  });

  it("refuses to start with only some of the required settings", () => {
    for (const missing of Object.keys(configured)) {
      const partial = { ...configured, [missing]: " " };
      expect(() => cloudWebFromEnv(partial), missing).toThrow(/must be configured together/);
    }
  });

  it("reads origins, issuer, key set, accounts and name", () => {
    const settings = cloudWebFromEnv({ ...configured, SUPERBOT_CLOUD_SERVER_NAME: " Home lab " });
    expect(settings).toEqual({
      origins: ["https://hosted.example.com", "https://hosted-*.example.com"],
      issuer: "https://accounts.example.com",
      jwksUrl: "https://accounts.example.com/.well-known/jwks.json",
      allowedEmails: new Map([
        ["owner@example.com", null],
        ["friend@example.com", "local@example.com"],
      ]),
      serverName: "Home lab",
    });
    expect(cloudWebFromEnv(configured)?.serverName).toBe("Superbot");
  });

  it("takes a separate key set address", () => {
    const settings = cloudWebFromEnv({
      ...configured,
      SUPERBOT_CLOUD_JWKS_URL: "https://keys.example.com/jwks",
    });
    expect(settings?.jwksUrl).toBe("https://keys.example.com/jwks");
    expect(() =>
      cloudWebFromEnv({ ...configured, SUPERBOT_CLOUD_JWKS_URL: "http://keys.example.com/jwks" }),
    ).toThrow(/SUPERBOT_CLOUD_JWKS_URL must be an https URL/);
  });

  it("refuses an issuer that is not https", () => {
    expect(() =>
      cloudWebFromEnv({ ...configured, SUPERBOT_CLOUD_ISSUER: "http://accounts.example.com" }),
    ).toThrow(/SUPERBOT_CLOUD_ISSUER must be an https URL/);
  });

  it("refuses malformed account entries", () => {
    for (const entry of ["not-an-email", "a@example.com=b@example.com=c@example.com", "a@b=nope"]) {
      expect(
        () => cloudWebFromEnv({ ...configured, SUPERBOT_CLOUD_ALLOWED_EMAILS: entry }),
        entry,
      ).toThrow(/SUPERBOT_CLOUD_ALLOWED_EMAILS/);
    }
  });
});

describe("cloud web origins", () => {
  it("accepts exact https origins, loopback http, and one prefixed wildcard label", () => {
    expect(
      parseCloudOrigins(
        "https://hosted.example.com/, http://localhost:5173, http://127.0.0.1, https://hosted-*.example.com",
      ),
    ).toEqual([
      "https://hosted.example.com",
      "http://localhost:5173",
      "http://127.0.0.1",
      "https://hosted-*.example.com",
    ]);
  });

  it("refuses wildcards that could match more than one site's previews", () => {
    for (const origin of [
      "*",
      "https://*",
      "https://*.example.com",
      "https://hosted.*.example.com",
      "https://hosted-*-*.example.com",
      "https://hosted.example.*",
      "https://hosted-*",
      "http://hosted-*.example.com",
      "https://hosted-*.example.com/path",
    ]) {
      expect(() => parseCloudOrigins(origin), origin).toThrow(/SUPERBOT_CLOUD_WEB_ORIGINS/);
    }
  });

  it("refuses non-https origins, paths, queries and credentials", () => {
    for (const origin of [
      "http://hosted.example.com",
      "http://192.168.1.2:5173",
      "https://hosted.example.com/app",
      "https://hosted.example.com?x=1",
      "https://user:pass@hosted.example.com",
      "hosted.example.com",
      "ftp://hosted.example.com",
    ]) {
      expect(() => parseCloudOrigins(origin), origin).toThrow(/SUPERBOT_CLOUD_WEB_ORIGINS/);
    }
    expect(() => parseCloudOrigins(" , ")).toThrow(/lists no origin/);
  });

  it("matches exact origins exactly", () => {
    const origins = parseCloudOrigins("https://hosted.example.com");
    expect(cloudOriginAllowed(origins, "https://hosted.example.com")).toBe(true);
    expect(cloudOriginAllowed(origins, "https://HOSTED.example.com")).toBe(true);
    for (const origin of [
      "https://hosted.example.com:8443",
      "http://hosted.example.com",
      "https://hosted.example.com.evil.test",
      "https://evil-hosted.example.com",
      "null",
      "",
    ]) {
      expect(cloudOriginAllowed(origins, origin), origin).toBe(false);
    }
  });

  it("matches a pattern's wildcard to letters, digits and hyphens within its label only", () => {
    const origins = parseCloudOrigins("https://hosted-*.example.com");
    for (const origin of [
      "https://hosted-abc123.example.com",
      "https://hosted-git-main-x.example.com",
    ])
      expect(cloudOriginAllowed(origins, origin), origin).toBe(true);
    for (const origin of [
      "https://hosted-.example.com",
      "https://hosted-a.b.example.com",
      "https://hosted-a.evil.test/.example.com",
      "https://other-abc.example.com",
      "https://hosted-abc.example.com:444",
      "http://hosted-abc.example.com",
      "https://hosted-abc.example.com.evil.test",
      "https://hosted-a_b.example.com",
    ]) {
      expect(cloudOriginAllowed(origins, origin), origin).toBe(false);
    }
  });
});
