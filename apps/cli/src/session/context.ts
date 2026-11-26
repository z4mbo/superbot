import type { SettingsEnvironment } from "@rakazo/cli-client";
import { CredentialStore } from "@rakazo/cli-client";
import type { LocalModelDrivers } from "../local/local-model.js";
import type { Io } from "../terminal/io.js";
import type { UpdateEnvironment } from "../update/update-check.js";

/** Everything a command reads from its surroundings; tests pass their own of each. */
export type CliContext = {
  io: Io;
  /** Where saved settings live: the process environment, or a test's temporary directory. */
  settings: SettingsEnvironment;
  credentials: CredentialStore;
  /** Runs local models selected on this device; tests replace the installed CLIs. */
  localModels?: LocalModelDrivers;
  /** How long a reply may take before the command stops waiting for it. */
  replyBudgetMs?: number;
  /** The registry and clock the update check uses; tests pass their own. */
  updates?: UpdateEnvironment;
};

export const REPLY_BUDGET_MS = 600_000;

export function defaultContext(io: Io): CliContext {
  const settings: SettingsEnvironment = { env: process.env, platform: process.platform };
  return { io, settings, credentials: new CredentialStore({ settings }) };
}
