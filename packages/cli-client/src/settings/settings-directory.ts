import path from "node:path";

/** Where settings are looked up; tests pass their own instead of the process's. */
export type SettingsEnvironment = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
};

/**
 * This computer's Superbot settings directory: `SUPERBOT_CONFIG_DIR` when set, which keeps a
 * fixture profile apart, otherwise the platform's per-user application data. The same folder the
 * desktop app and earlier command-line releases use, so their saved server and Space carry over.
 */
export function settingsDirectory(settings: SettingsEnvironment = {}): string | undefined {
  const env = settings.env ?? process.env;
  const platform = settings.platform ?? process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const directory = (name: string) => {
    const value = env[name];
    return value && paths.isAbsolute(value) ? value : undefined;
  };
  const configured = directory("SUPERBOT_CONFIG_DIR");
  if (configured) return configured;
  if (platform === "win32") {
    const local = directory("LOCALAPPDATA");
    return local && paths.join(local, "Superbot");
  }
  const home = directory("HOME");
  if (platform === "darwin") {
    return home && paths.join(home, "Library/Application Support/Superbot");
  }
  const config = directory("XDG_CONFIG_HOME") ?? (home && paths.join(home, ".config"));
  return config && paths.join(config, "superbot");
}

/** A file in the settings directory, or undefined when this computer has none. */
export function settingsFile(name: string, settings: SettingsEnvironment = {}): string | undefined {
  const directory = settingsDirectory(settings);
  if (!directory) return undefined;
  const paths = (settings.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
  return paths.join(directory, name);
}

export function missingSettingsDirectory(): Error {
  return new Error("Superbot settings directory is unavailable");
}
