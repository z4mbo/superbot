import type { RakazoDesktop, RakazoDesktopOAuthCallback } from "@rakazo/contracts";

export type { RakazoDesktop, RakazoDesktopOAuthCallback } from "@rakazo/contracts";

declare global {
  interface Window {
    rakazoDesktop?: RakazoDesktop;
  }
}

export function desktopBridge(): RakazoDesktop | undefined {
  return typeof window === "undefined" ? undefined : window.rakazoDesktop;
}

/** Which app this is, as measurement names it. */
export function analyticsSurface(): "desktop" | "web" {
  return desktopBridge() ? "desktop" : "web";
}

/** The compact `code#state` form the manual paste flow already accepts. */
export function desktopOAuthCode(callback: RakazoDesktopOAuthCallback) {
  return callback.state === undefined ? callback.code : `${callback.code}#${callback.state}`;
}

/**
 * The authorize URL carries the attempt's PKCE state, so a captured code whose
 * state differs belongs to a different attempt — a popup left open by a
 * cancelled sign-in, say — and must not be spent on the current one.
 */
export function oauthStateOf(verificationUri: string): string | undefined {
  try {
    return new URL(verificationUri).searchParams.get("state") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Desktop sign-in redirects to a loopback URL the renderer never sees, so the main process
 * captures the code there and the copy-and-paste step can be skipped. No-ops in a browser.
 * Providers whose authorize URL carries no state cannot be correlated, so their codes are
 * always accepted.
 */
export function onDesktopOAuthCallback(
  listener: (code: string) => void,
  expectedState?: string,
): () => void {
  const oauth = desktopBridge()?.oauth;
  if (!oauth) return () => undefined;
  return oauth.onCallback((callback) => {
    if (expectedState !== undefined && callback.state !== expectedState) return;
    listener(desktopOAuthCode(callback));
  });
}

/**
 * Who draws the window controls, as in the reference desktop app: macOS traffic lights at the
 * top left; the operating system's overlay at the top right (Windows); the page itself at the
 * top right (Linux, and older frameless releases). Null in a browser or a natively framed window.
 */
export function windowControlsKind(
  desktop?: RakazoDesktop,
): "traffic-lights" | "overlay" | "page" | null {
  if (!desktop) return null;
  if (desktop.platform === "darwin") return "traffic-lights";
  if (!desktop.nativeWindowFrame) return "page";
  const overlay = (navigator as { windowControlsOverlay?: { visible: boolean } })
    .windowControlsOverlay;
  return overlay?.visible ? "overlay" : null;
}

/** Room the top-right window controls take from the page's toolbars, as in the reference. */
export const WINDOW_CONTROLS_INSET_PX = 140;
/** Height of the band the top-right window controls sit in. */
export const WINDOW_CONTROLS_BLOCK_PX = 52;

/**
 * Horizontal space Electron's native macOS traffic lights occupy from the window's leading edge.
 * Apply it with a style (`width` or `left`). Tailwind only emits a utility from a complete class
 * literal, so `w-[${DARWIN_WINDOW_CONTROLS_WIDTH_PX}px]` would not ship.
 */
export const DARWIN_WINDOW_CONTROLS_WIDTH_PX = 72;
