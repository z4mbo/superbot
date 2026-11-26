#!/usr/bin/env node
import { runCli } from "./cli/run-cli.js";
import { defaultContext } from "./session/context.js";
import { processIo } from "./terminal/process-io.js";
import { refreshUpdateCache, UPDATE_CHECK_ARGUMENT } from "./update/update-check.js";

/** Waits until everything written to `stream` so far has been handed to the system. */
function drained(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

// An interrupt ends the command at once with the status shells report for Ctrl+C.
process.on("SIGINT", () => {
  process.exit(130);
});

// The once-a-day update check, started detached by an earlier command; it prints nothing.
if (process.argv[2] === UPDATE_CHECK_ARGUMENT) {
  await refreshUpdateCache(defaultContext(processIo()));
  process.exit(0);
}

const code = await runCli(process.argv.slice(2), defaultContext(processIo()));
await Promise.all([drained(process.stdout), drained(process.stderr)]);
process.exit(code);
