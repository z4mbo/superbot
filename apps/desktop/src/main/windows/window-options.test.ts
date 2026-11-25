import { describe, expect, it } from "vitest";
import {
  browserWindowOptions,
  DEFAULT_WARM_WINDOW_TTL_MS,
  developmentIconFile,
  setupWindowOptions,
  titleBarOverlay,
  warmWindowTtlMs,
} from "./window-options.js";

const laptop = { width: 1440, height: 875 };

describe("desktop window chrome", () => {
  // The reference desktop app's own BrowserWindow options, per platform.
  it("uses native traffic lights on macOS", () => {
    expect(browserWindowOptions("darwin", laptop)).toMatchObject({
      frame: true,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 15 },
    });
  });

  it("lets Windows draw its controls over the page in the app and setup windows", () => {
    for (const dark of [true, false]) {
      for (const opts of [
        browserWindowOptions("win32", laptop, dark),
        setupWindowOptions("win32", laptop, dark),
      ]) {
        expect(opts).toMatchObject({
          frame: false,
          titleBarStyle: "hidden",
          titleBarOverlay: titleBarOverlay(dark),
        });
      }
    }
    expect(titleBarOverlay(true)).toEqual({
      height: 51,
      color: "#121212",
      symbolColor: "#FFFFFF",
    });
    expect(titleBarOverlay(false)).toEqual({
      height: 51,
      color: "#FCFCFC",
      symbolColor: "#000000",
    });
  });

  it("keeps Linux frameless so its in-page buttons control the window", () => {
    const opts = browserWindowOptions("linux", laptop);
    expect(opts).toMatchObject({ frame: false, titleBarStyle: "default" });
    expect(opts).not.toHaveProperty("titleBarOverlay");
  });
});

describe("app window size", () => {
  it("opens smaller than a laptop screen so it reads as a window, not full screen", () => {
    const opts = browserWindowOptions("darwin", laptop);
    expect(opts.width).toBeLessThan(laptop.width);
    expect(opts.height).toBeLessThan(laptop.height);
  });

  it("fits inside a small scaled screen", () => {
    const small = { width: 1280, height: 672 };
    for (const opts of [browserWindowOptions("win32", small), setupWindowOptions("win32", small)]) {
      expect(opts.width).toBeLessThanOrEqual(small.width);
      expect(opts.height).toBeLessThanOrEqual(small.height);
    }
    const setup = setupWindowOptions("win32", small);
    expect(setup.minHeight).toBeLessThanOrEqual(setup.height);
  });

  it("caps its size on large displays", () => {
    expect(browserWindowOptions("darwin", { width: 3840, height: 2160 })).toMatchObject({
      width: 1280,
      height: 840,
    });
  });
});

describe("setup window chrome", () => {
  it("matches the app window chrome so first run looks like the product", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const setup = setupWindowOptions(platform, laptop);
      const app = browserWindowOptions(platform, laptop);
      expect(setup.frame).toBe(app.frame);
      expect(setup.titleBarStyle).toBe(app.titleBarStyle);
      expect(setup.backgroundColor).toBe(app.backgroundColor);
    }
  });

  it("opens smaller than the app window and stays usable when resized down", () => {
    const setup = setupWindowOptions("win32", laptop);
    expect(setup.width).toBeLessThan(browserWindowOptions("win32", laptop).width);
    expect(setup.minWidth).toBeLessThanOrEqual(setup.width);
    expect(setup.minHeight).toBeLessThanOrEqual(setup.height);
  });
});

describe("warm window lifetime", () => {
  it("accepts finite timer delays within Node's supported range", () => {
    expect(warmWindowTtlMs("0")).toBe(0);
    expect(warmWindowTtlMs("900000")).toBe(900_000);
    expect(warmWindowTtlMs("2147483647")).toBe(2_147_483_647);
  });

  it.each([undefined, "", " ", "nope", "-1", "Infinity", "2147483648"])(
    "uses the default for an invalid value (%s)",
    (value) => {
      expect(warmWindowTtlMs(value)).toBe(DEFAULT_WARM_WINDOW_TTL_MS);
    },
  );
});

describe("development icon", () => {
  it("uses the squircle asset on macOS because the dock draws the file unmasked", () => {
    expect(developmentIconFile("darwin")).toBe("icon-macos.png");
  });

  it("keeps the full-bleed icon elsewhere", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(developmentIconFile(platform)).toBe("icon.png");
    }
  });
});

describe("window background", () => {
  it("matches the web dark background token so startup chrome does not flash", async () => {
    const { webDarkTokens } = await import("@rakazo/ui-tokens");
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(browserWindowOptions(platform, laptop).backgroundColor).toBe(webDarkTokens.background);
      expect(setupWindowOptions(platform, laptop).backgroundColor).toBe(webDarkTokens.background);
    }
  });

  it("paints the Windows overlay in the web background tokens", async () => {
    const { webDarkTokens, webLightTokens } = await import("@rakazo/ui-tokens");
    expect(titleBarOverlay(true).color).toBe(webDarkTokens.background);
    expect(titleBarOverlay(false).color).toBe(webLightTokens.background);
  });
});
