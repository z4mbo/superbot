import { DEFAULT_SERVER, serverOrigin } from "../client/server-origin.js";
import { readOptionalFile, writeFileAtomic } from "./atomic-file.js";
import type { SettingsEnvironment } from "./settings-directory.js";
import { missingSettingsDirectory, settingsFile } from "./settings-directory.js";

type HasServer = { readonly server: string };

/**
 * The server to use: an explicit `--server` value, then `SUPERBOT_SERVER`, then the one saved on
 * this computer, then the local default. An explicit value is returned as given (trimmed), so the
 * caller reports an invalid one rather than silently using another server.
 */
export async function selectedServer(
  explicit?: string | null,
  settings: SettingsEnvironment = {},
): Promise<string> {
  const env = settings.env ?? process.env;
  for (const value of [explicit, env.SUPERBOT_SERVER]) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  const file = settingsFile("server.txt", settings);
  try {
    const saved = file ? await readOptionalFile(file) : undefined;
    return saved === undefined ? DEFAULT_SERVER : serverOrigin(saved.trim()).origin;
  } catch {
    // An unreadable or invalid saved choice is no choice: the default stands.
    return DEFAULT_SERVER;
  }
}

/** Makes this client's server the device default. */
export function rememberServer(client: HasServer, settings: SettingsEnvironment = {}) {
  return rememberSignInServer(client, undefined, settings);
}

/**
 * Keeps a launch-specific server private to that invocation: signing in to the server named at
 * launch leaves the saved default alone. An address chosen in the form becomes the device default.
 */
export async function rememberSignInServer(
  client: HasServer,
  launchServer?: string | null,
  settings: SettingsEnvironment = {},
): Promise<void> {
  if (launchServer !== undefined && launchServer !== null) {
    try {
      if (serverOrigin(launchServer.trim()).origin === client.server) return;
    } catch {
      // Not an origin, so it cannot be the server signed in to.
    }
  }
  const file = settingsFile("server.txt", settings);
  if (!file) throw missingSettingsDirectory();
  await writeFileAtomic(file, `${client.server}\n`);
}
