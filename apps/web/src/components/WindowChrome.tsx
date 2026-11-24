import {
  DARWIN_WINDOW_CONTROLS_WIDTH_PX,
  desktopBridge,
  windowControlsKind,
} from "../lib/platform/desktop";

function chromeClass(base: string, className?: string) {
  return className ? `${base} ${className}` : base;
}

/**
 * Keeps the macOS traffic lights clear: a draggable strip as wide as they are. Everywhere else
 * the window controls sit at the top right (`WindowControls`), so this renders nothing.
 */
export function WindowChrome({ className }: { className?: string }) {
  if (windowControlsKind(desktopBridge()) !== "traffic-lights") return null;
  return (
    <div
      className={chromeClass("app-drag h-3 shrink-0", className)}
      style={{ width: DARWIN_WINDOW_CONTROLS_WIDTH_PX }}
      aria-hidden="true"
    />
  );
}
