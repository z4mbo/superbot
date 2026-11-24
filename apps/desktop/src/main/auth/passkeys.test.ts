import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A release build inlines its passkey domain; these tests build as one associated with this domain.
vi.hoisted(() => {
  process.env.SUPERBOT_PASSKEY_RP_ID = "superbot.example.org";
});

import { associatedPasskeyRpIds, PASSKEY_RP_ID, passkeyEntitlements } from "./passkeys.js";

const root = path.resolve(import.meta.dirname, "../../..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  build: { appId: string; mac: { entitlements: string; entitlementsInherit: string } };
};
const base = readFileSync(path.join(root, pkg.build.mac.entitlements), "utf8");

describe("associatedPasskeyRpIds", () => {
  const resourcesPath = "/Applications/Superbot.app/Contents/Resources";
  const profile = "/Applications/Superbot.app/Contents/embedded.provisionprofile";

  it("lists the hosted domain only for a packaged macOS app with an embedded profile", () => {
    const exists = (file: string) => file === profile;
    expect(
      associatedPasskeyRpIds({ platform: "darwin", packaged: true, resourcesPath, exists }),
    ).toEqual([PASSKEY_RP_ID]);
    expect(
      associatedPasskeyRpIds({
        platform: "darwin",
        packaged: true,
        resourcesPath,
        exists: () => false,
      }),
    ).toEqual([]);
    expect(
      associatedPasskeyRpIds({ platform: "darwin", packaged: false, resourcesPath, exists }),
    ).toEqual([]);
    expect(
      associatedPasskeyRpIds({ platform: "win32", packaged: true, resourcesPath, exists }),
    ).toEqual([]);
  });
});

describe("passkeyEntitlements", () => {
  it("adds the application identifier and webcredentials domain to the base entitlements", () => {
    const plist = passkeyEntitlements(base, "ABCDE12345", pkg.build.appId);
    expect(plist.startsWith(base.slice(0, base.lastIndexOf("</dict>")).trimEnd())).toBe(true);
    expect(plist).toContain(
      "<key>com.apple.application-identifier</key>\n    <string>ABCDE12345.com.superbot.desktop</string>",
    );
    expect(plist).toContain(
      `<key>com.apple.developer.associated-domains</key>\n    <array>\n      <string>webcredentials:${PASSKEY_RP_ID}</string>\n    </array>\n  </dict>\n</plist>`,
    );
  });

  it("marks a development build that fetches the association itself in developer mode", () => {
    const plist = passkeyEntitlements(base, "ABCDE12345", pkg.build.appId, { developerMode: true });
    expect(plist).toContain(`<string>webcredentials:${PASSKEY_RP_ID}?mode=developer</string>`);
    expect(plist).toContain("<key>com.apple.security.get-task-allow</key>\n    <true/>\n  </dict>");
    expect(passkeyEntitlements(base, "ABCDE12345", pkg.build.appId)).not.toContain(
      "get-task-allow",
    );
  });

  it("keeps helpers on the base entitlements", () => {
    expect(pkg.build.mac.entitlementsInherit).toBe(pkg.build.mac.entitlements);
    expect(base).not.toContain("associated-domains");
    expect(base).not.toContain("application-identifier");
  });

  it("rejects a malformed team or bundle identifier", () => {
    expect(() => passkeyEntitlements(base, "", pkg.build.appId)).toThrow();
    expect(() => passkeyEntitlements(base, "abcde12345", pkg.build.appId)).toThrow();
    expect(() => passkeyEntitlements(base, "ABCDE12345</string>", pkg.build.appId)).toThrow();
    expect(() => passkeyEntitlements(base, "ABCDE12345", "dev rakazo")).toThrow();
    const derived = passkeyEntitlements(base, "ABCDE12345", pkg.build.appId);
    expect(() => passkeyEntitlements(derived, "ABCDE12345", pkg.build.appId)).toThrow();
  });
});

describe("self-hosted passkey domain", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(rpId: string, legacyRpId = "") {
    vi.stubEnv("SUPERBOT_PASSKEY_RP_ID", rpId);
    vi.stubEnv("RAKAZO_PASSKEY_RP_ID", legacyRpId);
    vi.resetModules();
    return import("./passkeys.js");
  }

  it("has no passkey domain unless the build names one", async () => {
    const passkeys = await load("");
    expect(passkeys.PASSKEY_RP_ID).toBe("");
    expect(
      passkeys.associatedPasskeyRpIds({
        platform: "darwin",
        packaged: true,
        resourcesPath: "/Applications/Superbot.app/Contents/Resources",
        exists: () => true,
      }),
    ).toEqual([]);
    expect(() => passkeys.passkeyEntitlements(base, "ABCDE12345", pkg.build.appId)).toThrow(
      "SUPERBOT_PASSKEY_RP_ID",
    );
  });

  it("associates the build with SUPERBOT_PASSKEY_RP_ID", async () => {
    const passkeys = await load(" Superbot.Example.org ", "legacy.example.org");
    expect(passkeys.PASSKEY_RP_ID).toBe("superbot.example.org");
    expect(passkeys.passkeyEntitlements(base, "ABCDE12345", pkg.build.appId)).toContain(
      "<string>webcredentials:superbot.example.org</string>",
    );
  });

  it("still reads the legacy RAKAZO_PASSKEY_RP_ID", async () => {
    const passkeys = await load("", "legacy.example.org");
    expect(passkeys.PASSKEY_RP_ID).toBe("legacy.example.org");
  });

  it.each(["https://rakazo.example.org", "localhost", "192.168.1.20", "rakazo.example.org:8443"])(
    "refuses to sign entitlements for %s",
    async (rpId) => {
      const passkeys = await load(rpId);
      expect(() => passkeys.passkeyEntitlements(base, "ABCDE12345", pkg.build.appId)).toThrow(
        "SUPERBOT_PASSKEY_RP_ID",
      );
    },
  );
});
