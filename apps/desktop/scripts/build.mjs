import { build } from "esbuild";

/** Build-time settings read `SUPERBOT_<name>` first and the legacy `RAKAZO_<name>` after it. */
const buildEnv = (name) => process.env[`SUPERBOT_${name}`] || process.env[`RAKAZO_${name}`] || "";

await build({
  entryPoints: ["src/main/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  external: ["electron", "electron-updater", "koffi", "@sentry/electron"],
  // Only the release workflow's builds report errors; local and agent builds never do.
  define: {
    "process.env.RAKAZO_DESKTOP_RELEASE": JSON.stringify(buildEnv("DESKTOP_RELEASE")),
    // Self-hosted builds associated with their own passkey domain (see src/main/auth/passkeys.ts).
    "process.env.SUPERBOT_PASSKEY_RP_ID": JSON.stringify(buildEnv("PASSKEY_RP_ID")),
    "process.env.RAKAZO_PASSKEY_RP_ID": JSON.stringify(buildEnv("PASSKEY_RP_ID")),
  },
});
