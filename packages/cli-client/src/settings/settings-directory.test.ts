import { describe, expect, it } from "vitest";
import { settingsDirectory } from "./settings-directory.js";

describe("settingsDirectory", () => {
  it("uses SUPERBOT_CONFIG_DIR first on every platform", () => {
    expect(
      settingsDirectory({
        env: { SUPERBOT_CONFIG_DIR: "/fixture/profile", HOME: "/home/someone" },
        platform: "linux",
      }),
    ).toBe("/fixture/profile");
    expect(
      settingsDirectory({
        env: {
          SUPERBOT_CONFIG_DIR: "C:\\fixture",
          LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
        },
        platform: "win32",
      }),
    ).toBe("C:\\fixture");
  });

  it("falls back to each platform's per-user application data", () => {
    expect(
      settingsDirectory({
        env: { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" },
        platform: "win32",
      }),
    ).toBe("C:\\Users\\someone\\AppData\\Local\\Superbot");
    expect(settingsDirectory({ env: { HOME: "/Users/someone" }, platform: "darwin" })).toBe(
      "/Users/someone/Library/Application Support/Superbot",
    );
    expect(
      settingsDirectory({
        env: { HOME: "/home/someone", XDG_CONFIG_HOME: "/xdg" },
        platform: "linux",
      }),
    ).toBe("/xdg/superbot");
    expect(settingsDirectory({ env: { HOME: "/home/someone" }, platform: "freebsd" })).toBe(
      "/home/someone/.config/superbot",
    );
  });

  it("ignores relative paths and has none without a home", () => {
    expect(
      settingsDirectory({
        env: { SUPERBOT_CONFIG_DIR: "profile", XDG_CONFIG_HOME: "config", HOME: "/home/someone" },
        platform: "linux",
      }),
    ).toBe("/home/someone/.config/superbot");
    expect(settingsDirectory({ env: {}, platform: "linux" })).toBeUndefined();
    expect(settingsDirectory({ env: { HOME: "relative" }, platform: "darwin" })).toBeUndefined();
    expect(settingsDirectory({ env: {}, platform: "win32" })).toBeUndefined();
  });
});
