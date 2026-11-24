import { randomBytes } from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";

/**
 * The app was called Rakazo before it became Superbot. Electron names the userData folder after the
 * product (`~/Library/Application Support/Rakazo`, `%APPDATA%\Rakazo`, `~/.config/Rakazo`), so the
 * renamed build starts on an empty profile unless the old one is carried over. This copies it once,
 * before anything reads userData, and never touches the old folder, so the previous build still
 * opens and a failed copy loses nothing.
 */
export const LEGACY_APP_NAME = "Rakazo";
export const MIGRATION_MARKER = ".migrated-from-rakazo";

/**
 * What this app keeps in its profile. The new folder counts as used once it holds one of these;
 * anything else in it (what Chromium makes at startup, or the settings the native Superbot app
 * keeps in the same folder on macOS) does not stop the copy, and is never overwritten by it.
 */
const PROFILE_ENTRIES = new Set([
  "Cookies",
  "IndexedDB",
  "Local State",
  "Local Storage",
  "Network",
  "Partitions",
  "Preferences",
  "Session Storage",
  "devices",
  "setup.json",
  "stack",
  "ui-locale.txt",
]);

/** The old process's locks and crash reports; they belong to it. */
const PROCESS_FILES = new Set([
  ".DS_Store",
  "Crashpad",
  "DevToolsActivePort",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "lockfile",
]);

/** Caches Chromium rebuilds by itself, in the profile and in each session partition. */
const CACHES = new Set([
  "Cache",
  "Code Cache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
]);

/**
 * Left behind: the old process's own files and the caches (skipping them keeps the one-time copy
 * fast). Only matched where Chromium puts them, so a file of the same name deeper down (in the
 * stack's server bundle, say) is still copied.
 */
function copied(segments: string[]): boolean {
  const [first, , third] = segments;
  if (segments.length === 1) {
    return !(PROCESS_FILES.has(first!) || CACHES.has(first!) || first === MIGRATION_MARKER);
  }
  return !(segments.length === 3 && first === "Partitions" && CACHES.has(third!));
}

export type MigrationFs = Pick<
  typeof nodeFs,
  "cpSync" | "existsSync" | "lstatSync" | "readdirSync" | "renameSync" | "rmSync" | "writeFileSync"
>;

export type UserDataMigration =
  | { kind: "skipped"; reason: "same-folder" | "no-legacy" | "already-migrated" | "in-use" }
  | { kind: "migrated"; from: string; to: string }
  | { kind: "failed"; from: string; to: string; error: unknown };

export interface UserDataMigrationInput {
  /** Electron's `appData`: the parent of both the old and the new userData folder. */
  appDataDir: string;
  /** Electron's `userData` for this build. */
  userDataDir: string;
  legacyName?: string;
  fs?: MigrationFs;
  path?: Pick<typeof nodePath, "basename" | "join" | "relative" | "sep">;
  now?: () => Date;
  uniqueSuffix?: () => string;
}

/** The old build's userData folder for a given `appData` folder. */
export function legacyUserDataDir(
  appDataDir: string,
  pathApi: Pick<typeof nodePath, "join"> = nodePath,
  legacyName = LEGACY_APP_NAME,
): string {
  return pathApi.join(appDataDir, legacyName);
}

/**
 * Copies the old profile into the new userData folder when the old one exists and this app never
 * used the new one. It copies into a staging folder next to both and moves it in only once complete, so
 * a failure leaves the new folder as it was and the app starts on a fresh profile. Never throws.
 */
export function migrateLegacyUserData(input: UserDataMigrationInput): UserDataMigration {
  const fs = input.fs ?? nodeFs;
  const pathApi = input.path ?? nodePath;
  const now = input.now ?? (() => new Date());
  const from = legacyUserDataDir(input.appDataDir, pathApi, input.legacyName);
  const to = input.userDataDir;
  if (from === to) return { kind: "skipped", reason: "same-folder" };

  let staging: string | undefined;
  const moved: string[] = [];
  try {
    if (!fs.existsSync(from) || !fs.lstatSync(from).isDirectory()) {
      return { kind: "skipped", reason: "no-legacy" };
    }
    const existing = fs.existsSync(to) ? fs.readdirSync(to) : null;
    if (existing?.includes(MIGRATION_MARKER))
      return { kind: "skipped", reason: "already-migrated" };
    if (existing?.some((entry) => PROFILE_ENTRIES.has(entry))) {
      return { kind: "skipped", reason: "in-use" };
    }

    const suffix = input.uniqueSuffix?.() ?? randomBytes(6).toString("hex");
    staging = pathApi.join(input.appDataDir, `.${pathApi.basename(to)}-migrating-${suffix}`);
    fs.cpSync(from, staging, {
      recursive: true,
      errorOnExist: false,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (source) => {
        if (source === from) return true;
        if (!copied(pathApi.relative(from, source).split(pathApi.sep))) return false;
        // Sockets and pipes belong to a process that is not running here.
        const stat = fs.lstatSync(source);
        return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
      },
    });
    fs.writeFileSync(
      pathApi.join(staging, MIGRATION_MARKER),
      `${JSON.stringify({ from, migratedAt: now().toISOString() })}\n`,
      { mode: 0o600 },
    );

    if (existing === null) {
      fs.renameSync(staging, to);
    } else {
      // Something already made the folder; move entries in beside what it holds, the marker last.
      const entries = fs.readdirSync(staging).filter((entry) => entry !== MIGRATION_MARKER);
      for (const entry of [...entries, MIGRATION_MARKER]) {
        const target = pathApi.join(to, entry);
        if (fs.existsSync(target)) continue;
        fs.renameSync(pathApi.join(staging, entry), target);
        moved.push(target);
      }
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return { kind: "migrated", from, to };
  } catch (error) {
    for (const target of moved) removeQuietly(fs, target);
    if (staging !== undefined) removeQuietly(fs, staging);
    return { kind: "failed", from, to, error };
  }
}

function removeQuietly(fs: MigrationFs, target: string) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // The copy already failed; a leftover is harmless and the app still starts.
  }
}
