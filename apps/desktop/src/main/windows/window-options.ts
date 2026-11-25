export const DEFAULT_WARM_WINDOW_TTL_MS = 15 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function warmWindowTtlMs(value: string | undefined) {
  if (value === undefined || value.trim() === "") return DEFAULT_WARM_WINDOW_TTL_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_TIMER_DELAY_MS
    ? parsed
    : DEFAULT_WARM_WINDOW_TTL_MS;
}

// Keep in sync with the web background tokens from @rakazo/ui-tokens (asserted in tests).
// Do not import that package here: desktop packs compiled JS only and ui-tokens is a
// TypeScript source / devDependency.
const DARK_BACKGROUND = "#121212";
const LIGHT_BACKGROUND = "#FCFCFC";

/**
 * The window controls Windows draws over the page's top right corner, painted in the page's
 * background so they read as part of it. The page leaves that corner free.
 */
export function titleBarOverlay(dark: boolean) {
  return {
    height: 51,
    color: dark ? DARK_BACKGROUND : LIGHT_BACKGROUND,
    symbolColor: dark ? "#FFFFFF" : "#000000",
  };
}

/**
 * Matches the reference desktop app: native traffic lights on macOS, the system's overlay
 * controls on Windows, and a frameless window whose page draws its own controls on Linux.
 */
function windowChrome(platform: NodeJS.Platform, dark: boolean) {
  const chrome = { backgroundColor: DARK_BACKGROUND, show: true, autoHideMenuBar: true };
  if (platform === "darwin")
    return {
      ...chrome,
      frame: true,
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 16, y: 15 },
    };
  if (platform === "win32")
    return {
      ...chrome,
      frame: false,
      titleBarStyle: "hidden" as const,
      titleBarOverlay: titleBarOverlay(dark),
    };
  return { ...chrome, frame: false, titleBarStyle: "default" as const };
}

type WorkArea = { width: number; height: number };

/** Opens as a window inside the screen's work area rather than filling it. */
export function browserWindowOptions(platform: NodeJS.Platform, workArea: WorkArea, dark = true) {
  return {
    width: Math.min(1280, Math.round(workArea.width * 0.8)),
    height: Math.min(840, Math.round(workArea.height * 0.85)),
    ...windowChrome(platform, dark),
  };
}

/**
 * Unpackaged (dev) launches set the dock/taskbar icon by hand. macOS draws the file as-is,
 * so it needs the squircle-with-margins asset; packaged builds already use icon.icns.
 */
export function developmentIconFile(platform: NodeJS.Platform) {
  return platform === "darwin" ? "icon-macos.png" : "icon.png";
}

/** The first-run setup window is smaller and keeps the same platform chrome. */
export function setupWindowOptions(platform: NodeJS.Platform, workArea: WorkArea, dark = true) {
  const width = Math.min(720, workArea.width);
  const height = Math.min(700, workArea.height);
  return {
    width,
    height,
    minWidth: Math.min(480, width),
    minHeight: Math.min(560, height),
    ...windowChrome(platform, dark),
  };
}
