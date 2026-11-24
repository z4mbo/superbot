// Prints the main app's entitlements with the passkey association for a release signed by
// APPLE_TEAM_ID (read from the provisioning profile in CI, never committed). Helpers keep the
// base file: they are not the associated app. A build sets SUPERBOT_PASSKEY_RP_ID to its
// server's domain (and SUPERBOT_PASSKEY_DEVELOPER_MODE=1 when that domain is private; the legacy
// RAKAZO_ names still work), with the same
// values as for `pnpm build`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { brandEnv } from "@rakazo/core";
import { passkeyEntitlements } from "../src/main/auth/passkeys.js";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  build: { appId: string; mac: { entitlements: string } };
};
const base = readFileSync(path.join(root, pkg.build.mac.entitlements), "utf8");
process.stdout.write(
  passkeyEntitlements(base, process.env.APPLE_TEAM_ID ?? "", pkg.build.appId, {
    developerMode: brandEnv("PASSKEY_DEVELOPER_MODE", process.env) === "1",
  }),
);
