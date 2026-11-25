import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import type { SettingsEnvironment } from "./settings-directory.js";

/** A throwaway settings directory per test, never the person's own. */
export function useTemporarySettings() {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
  return async (): Promise<{ directory: string; settings: SettingsEnvironment }> => {
    const root = await mkdtemp(path.join(tmpdir(), "superbot-settings-"));
    directories.push(root);
    const directory = path.join(root, "nested");
    return { directory, settings: { env: { SUPERBOT_CONFIG_DIR: directory } } };
  };
}
