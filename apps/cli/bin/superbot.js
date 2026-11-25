#!/usr/bin/env node
// Runs the bundled command. The bundle is built with `pnpm --filter superbot-cli build`.
try {
  await import("../dist/superbot.js");
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("superbot.js")) {
    process.stderr.write(
      "superbot: build the command first with pnpm --filter superbot-cli build\n",
    );
    process.exit(1);
  }
  throw error;
}
