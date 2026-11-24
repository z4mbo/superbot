import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MigrationFs } from "./user-data-migration.js";
import {
  LEGACY_APP_NAME,
  legacyUserDataDir,
  MIGRATION_MARKER,
  migrateLegacyUserData,
} from "./user-data-migration.js";

let appData: string;
let legacy: string;
let current: string;
const now = () => new Date("2026-11-24T10:00:00.000Z");

beforeEach(() => {
  appData = fs.mkdtempSync(path.join(os.tmpdir(), "user-data-migration-"));
  legacy = path.join(appData, "Rakazo");
  current = path.join(appData, "Superbot");
});

afterEach(() => {
  fs.rmSync(appData, { recursive: true, force: true });
});

function write(file: string, content = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function seedLegacyProfile() {
  write(path.join(legacy, "setup.json"), '{"mode":"existing","serverUrl":"https://bots.test"}\n');
  write(path.join(legacy, "stack", ".env"), "POSTGRES_PASSWORD=abc\n");
  write(path.join(legacy, "devices", "abc.json"), '{"token":"sealed"}');
  write(path.join(legacy, "native-crash-checkpoint.json"), "{}");
  write(path.join(legacy, "Partitions", "rakazo-1", "Cookies"), "cookies");
  write(path.join(legacy, "Partitions", "rakazo-1", "Cache", "data_0"), "cache");
  write(path.join(legacy, "Code Cache", "js", "index"), "cache");
  write(path.join(legacy, "SingletonLock"), "host-123");
  // The server bundle ships files that share names with Chromium's; they must still be copied.
  write(path.join(legacy, "stack", "server", "node_modules", "lockfile", "index.js"), "module");
  write(path.join(legacy, "stack", "server", "Cache", "keep"), "bundle");
}

function migrate(extra: Partial<Parameters<typeof migrateLegacyUserData>[0]> = {}) {
  return migrateLegacyUserData({
    appDataDir: appData,
    userDataDir: current,
    now,
    uniqueSuffix: () => "test",
    ...extra,
  });
}

const read = (file: string) => fs.readFileSync(file, "utf8");
const leftovers = () => fs.readdirSync(appData).filter((entry) => entry.includes("migrating"));

describe("migrateLegacyUserData", () => {
  it("copies the old profile into a new folder and marks it", () => {
    seedLegacyProfile();

    expect(migrate()).toEqual({ kind: "migrated", from: legacy, to: current });

    expect(read(path.join(current, "setup.json"))).toContain("https://bots.test");
    expect(read(path.join(current, "stack", ".env"))).toBe("POSTGRES_PASSWORD=abc\n");
    expect(read(path.join(current, "devices", "abc.json"))).toBe('{"token":"sealed"}');
    expect(read(path.join(current, "native-crash-checkpoint.json"))).toBe("{}");
    expect(read(path.join(current, "Partitions", "rakazo-1", "Cookies"))).toBe("cookies");
    expect(JSON.parse(read(path.join(current, MIGRATION_MARKER)))).toEqual({
      from: legacy,
      migratedAt: "2026-11-24T10:00:00.000Z",
    });
    expect(leftovers()).toEqual([]);
  });

  it("leaves caches and the old process's locks behind", () => {
    seedLegacyProfile();
    migrate();

    expect(fs.existsSync(path.join(current, "Code Cache"))).toBe(false);
    expect(fs.existsSync(path.join(current, "Partitions", "rakazo-1", "Cache"))).toBe(false);
    expect(fs.existsSync(path.join(current, "SingletonLock"))).toBe(false);
  });

  it("copies files that only share a name with a cache or lock deeper in the profile", () => {
    seedLegacyProfile();
    migrate();

    const server = path.join(current, "stack", "server");
    expect(read(path.join(server, "node_modules", "lockfile", "index.js"))).toBe("module");
    expect(read(path.join(server, "Cache", "keep"))).toBe("bundle");
  });

  it("never changes or removes the old folder", () => {
    seedLegacyProfile();
    migrate();

    expect(read(path.join(legacy, "setup.json"))).toContain("https://bots.test");
    expect(fs.existsSync(path.join(legacy, "Code Cache", "js", "index"))).toBe(true);
    expect(fs.existsSync(path.join(legacy, MIGRATION_MARKER))).toBe(false);
  });

  it("does nothing when there is no old profile", () => {
    expect(migrate()).toEqual({ kind: "skipped", reason: "no-legacy" });
    expect(fs.existsSync(current)).toBe(false);
  });

  it("does nothing when the old path is a file", () => {
    write(legacy);
    expect(migrate()).toEqual({ kind: "skipped", reason: "no-legacy" });
  });

  it("copies in beside the native app's settings without overwriting them", () => {
    seedLegacyProfile();
    write(path.join(current, "server.txt"), "https://native.example");
    write(path.join(current, "stack"), "not ours");

    expect(migrate()).toEqual({ kind: "skipped", reason: "in-use" });
    fs.rmSync(path.join(current, "stack"));
    write(path.join(current, "native-only.json"), "{}");

    expect(migrate()).toEqual({ kind: "migrated", from: legacy, to: current });
    expect(read(path.join(current, "server.txt"))).toBe("https://native.example");
    expect(read(path.join(current, "native-only.json"))).toBe("{}");
    expect(read(path.join(current, "setup.json"))).toContain("https://bots.test");
  });

  it("leaves a new profile that is already in use untouched", () => {
    seedLegacyProfile();
    write(path.join(current, "setup.json"), "new");

    write(path.join(current, "Local State"), "{}");

    expect(migrate()).toEqual({ kind: "skipped", reason: "in-use" });
    expect(fs.readdirSync(current).sort()).toEqual(["Local State", "setup.json"]);
    expect(read(path.join(current, "setup.json"))).toBe("new");
  });

  it("still migrates into a folder Chromium created at startup", () => {
    seedLegacyProfile();
    write(path.join(current, "Crashpad", "settings.dat"), "new");
    write(path.join(current, "SingletonLock"), "new");

    expect(migrate()).toEqual({ kind: "migrated", from: legacy, to: current });
    expect(read(path.join(current, "setup.json"))).toContain("https://bots.test");
    expect(read(path.join(current, "Crashpad", "settings.dat"))).toBe("new");
    expect(read(path.join(current, "SingletonLock"))).toBe("new");
    expect(fs.existsSync(path.join(current, MIGRATION_MARKER))).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("runs once: a second launch keeps what the first one copied", () => {
    seedLegacyProfile();
    expect(migrate().kind).toBe("migrated");
    write(path.join(current, "setup.json"), "changed after migration");
    write(path.join(legacy, "setup.json"), "old build kept running");

    expect(migrate()).toEqual({ kind: "skipped", reason: "already-migrated" });
    expect(read(path.join(current, "setup.json"))).toBe("changed after migration");
  });

  it("skips when the old and new folders are the same", () => {
    seedLegacyProfile();
    expect(migrate({ userDataDir: legacy })).toEqual({ kind: "skipped", reason: "same-folder" });
  });

  it("removes a partial copy and reports the failure without throwing", () => {
    seedLegacyProfile();
    const error = new Error("disk full");
    const failing: MigrationFs = {
      ...fs,
      cpSync: ((source: string, destination: string, options: fs.CopySyncOptions) => {
        fs.cpSync(source, destination, options);
        throw error;
      }) as MigrationFs["cpSync"],
    };

    expect(migrate({ fs: failing })).toEqual({ kind: "failed", from: legacy, to: current, error });
    expect(fs.existsSync(current)).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(path.join(legacy, "setup.json"))).toBe(true);
  });

  it("takes back entries it moved when a move into an existing folder fails", () => {
    seedLegacyProfile();
    write(path.join(current, "Crashpad", "settings.dat"), "new");
    let renames = 0;
    const failing: MigrationFs = {
      ...fs,
      renameSync: (source, destination) => {
        renames += 1;
        if (renames === 3) throw new Error("rename failed");
        fs.renameSync(source, destination);
      },
    };

    const result = migrate({ fs: failing });

    expect(result.kind).toBe("failed");
    expect(fs.readdirSync(current)).toEqual(["Crashpad"]);
    expect(leftovers()).toEqual([]);
  });

  it("migrates again after a failed attempt", () => {
    seedLegacyProfile();
    const failing: MigrationFs = {
      ...fs,
      writeFileSync: () => {
        throw new Error("read-only");
      },
    };
    expect(migrate({ fs: failing }).kind).toBe("failed");
    expect(migrate().kind).toBe("migrated");
  });
});

describe("legacyUserDataDir", () => {
  it("is the Rakazo folder beside the new one on every platform", () => {
    expect(LEGACY_APP_NAME).toBe("Rakazo");
    expect(legacyUserDataDir("/Users/me/Library/Application Support", path.posix)).toBe(
      "/Users/me/Library/Application Support/Rakazo",
    );
    expect(legacyUserDataDir("C:\\Users\\me\\AppData\\Roaming", path.win32)).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\Rakazo",
    );
    expect(legacyUserDataDir("/home/me/.config", path.posix)).toBe("/home/me/.config/Rakazo");
  });

  it("resolves the old folder from appData with the platform's path rules", () => {
    const appDataDir = "C:\\Users\\me\\AppData\\Roaming";
    const files = new Set<string>();
    const result = migrateLegacyUserData({
      appDataDir,
      userDataDir: "C:\\Users\\me\\AppData\\Roaming\\Superbot",
      path: path.win32,
      fs: {
        ...fs,
        existsSync: (file) => {
          files.add(String(file));
          return false;
        },
      },
    });
    expect(result).toEqual({ kind: "skipped", reason: "no-legacy" });
    expect([...files]).toEqual(["C:\\Users\\me\\AppData\\Roaming\\Rakazo"]);
  });
});
