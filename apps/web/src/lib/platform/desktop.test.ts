import { afterEach, describe, expect, it, vi } from "vitest";
import type { RakazoDesktop, RakazoDesktopOAuthCallback } from "./desktop.js";
import {
  DARWIN_WINDOW_CONTROLS_WIDTH_PX,
  desktopOAuthCode,
  oauthStateOf,
  onDesktopOAuthCallback,
  windowControlsKind,
} from "./desktop.js";

function desktop(platform: string): RakazoDesktop {
  const updateState = {
    phase: "unsupported" as const,
    currentVersion: "0.1.0",
    availableVersion: null,
    percent: null,
    message: "Automatic updates only run in an installed build.",
    checkedAt: null,
  };
  return {
    platform,
    window: {
      close: async () => undefined,
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
    },
    update: {
      state: async () => updateState,
      check: async () => updateState,
      download: async () => updateState,
      install: async () => updateState,
    },
    oauth: { onCallback: () => () => undefined },
  };
}

describe("window controls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("draws no window controls in the browser", () => {
    expect(windowControlsKind(undefined)).toBeNull();
  });

  it("leaves macOS traffic lights to Electron", () => {
    expect(windowControlsKind(desktop("darwin"))).toBe("traffic-lights");
  });

  it("leaves Windows controls to its title bar overlay, or a native frame", () => {
    const framed = { ...desktop("win32"), nativeWindowFrame: true };
    expect(windowControlsKind(framed)).toBeNull();
    vi.stubGlobal("navigator", { windowControlsOverlay: { visible: true } });
    expect(windowControlsKind(framed)).toBe("overlay");
  });

  it("draws controls in the page on Linux and older frameless Windows clients", () => {
    expect(windowControlsKind(desktop("win32"))).toBe("page");
    expect(windowControlsKind(desktop("linux"))).toBe("page");
  });

  it("reserves the macOS traffic-light strip width beside inset controls", () => {
    expect(DARWIN_WINDOW_CONTROLS_WIDTH_PX).toBe(72);
  });
});

describe("captured OAuth callbacks", () => {
  it("sends the code and state as the compact form the paste flow accepts", () => {
    expect(desktopOAuthCode({ code: "ac_123", state: "verifier_456" })).toBe("ac_123#verifier_456");
  });

  it("sends a bare code when the provider redirects without state", () => {
    expect(desktopOAuthCode({ code: "ac_123" })).toBe("ac_123");
  });
});

describe("attempt correlation", () => {
  afterEach(() => vi.unstubAllGlobals());

  function bridgeEmitting() {
    let emit: (callback: RakazoDesktopOAuthCallback) => void = () => undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal("window", {
      rakazoDesktop: {
        ...desktop("linux"),
        oauth: {
          onCallback: (listener: (callback: RakazoDesktopOAuthCallback) => void) => {
            emit = listener;
            return unsubscribe;
          },
        },
      },
    });
    return { emit: (c: RakazoDesktopOAuthCallback) => emit(c), unsubscribe };
  }

  it("reads the attempt state out of the authorize URL", () => {
    expect(oauthStateOf("https://claude.ai/oauth/authorize?code=true&state=verifier_456")).toBe(
      "verifier_456",
    );
    expect(oauthStateOf("https://claude.ai/oauth/authorize?code=true")).toBeUndefined();
    expect(oauthStateOf("not a url")).toBeUndefined();
  });

  it("ignores a code captured for a different attempt", () => {
    const { emit } = bridgeEmitting();
    const received: string[] = [];
    onDesktopOAuthCallback((code) => received.push(code), "verifier_456");

    emit({ code: "stale", state: "verifier_000" });
    expect(received).toEqual([]);

    emit({ code: "ac_123", state: "verifier_456" });
    expect(received).toEqual(["ac_123#verifier_456"]);
  });

  it("accepts any code when the provider carries no state to correlate on", () => {
    const { emit } = bridgeEmitting();
    const received: string[] = [];
    onDesktopOAuthCallback((code) => received.push(code));

    emit({ code: "ac_123" });
    expect(received).toEqual(["ac_123"]);
  });

  it("no-ops in a browser without the desktop bridge", () => {
    vi.stubGlobal("window", {});
    const received: string[] = [];
    expect(() => onDesktopOAuthCallback((code) => received.push(code))()).not.toThrow();
    expect(received).toEqual([]);
  });
});
