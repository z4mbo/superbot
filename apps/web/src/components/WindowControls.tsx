import { useLingui } from "@lingui/react/macro";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { RakazoDesktop } from "../lib/platform/desktop";
import {
  desktopBridge,
  WINDOW_CONTROLS_BLOCK_PX,
  WINDOW_CONTROLS_INSET_PX,
  windowControlsKind,
} from "../lib/platform/desktop";

/**
 * The window's minimize, maximize and close buttons at its top right, drawn by the page where the
 * operating system draws none (Linux), as the reference desktop app does. Wherever controls sit
 * at the top right, page or overlay, the page's toolbars keep `--window-controls-inset` clear.
 */
export function WindowControls() {
  const desktop = desktopBridge();
  const kind = windowControlsKind(desktop);
  const reserves = kind === "page" || kind === "overlay";
  useLayoutEffect(() => {
    if (!reserves) return;
    const style = document.documentElement.style;
    style.setProperty("--window-controls-inset", `${WINDOW_CONTROLS_INSET_PX}px`);
    style.setProperty("--window-controls-block", `${WINDOW_CONTROLS_BLOCK_PX}px`);
    return () => {
      style.removeProperty("--window-controls-inset");
      style.removeProperty("--window-controls-block");
    };
  }, [reserves]);
  if (kind !== "page" || !desktop) return null;
  // Portalled to the body's end so it stays above dialogs and full-window views.
  return createPortal(<PageWindowControls desktop={desktop} />, document.body);
}

/** A double click lands as two clicks; only the first acts, as in the reference. */
function once(action: () => Promise<void>, label: string) {
  return (event: MouseEvent) => {
    if (event.detail > 1) return;
    void bestEffort(label, action());
  };
}

function PageWindowControls({ desktop }: { desktop: RakazoDesktop }) {
  const { t } = useLingui();
  const [maximized, readMaximized] = useMaximized(desktop);
  const minimizeLabel = t`Minimize`;
  const maximizeLabel = maximized ? t`Restore` : t`Maximize`;
  const closeLabel = t`Close`;
  return (
    // The whole block is not a drag region. Over a drag region the window manager takes the
    // pointer, so a pointer leaving a button there never tells the page, and the button kept its
    // hover fill as if it were plated at rest. Leaving a button now always lands on the page.
    <div
      data-testid="window-controls"
      className="app-no-drag fixed top-0 right-0 z-[5000] flex items-center ps-1 pe-3"
      style={{ height: WINDOW_CONTROLS_BLOCK_PX }}
    >
      <div className="flex items-center gap-0.5">
        <WindowButton
          label={minimizeLabel}
          onClick={once(desktop.window.minimize, "window.minimize")}
        >
          <Glyph d="M3.5 12h17" weight={2.8} />
        </WindowButton>
        <WindowButton
          label={maximizeLabel}
          // Older desktop releases send no change signal, so read the state after acting.
          onClick={once(
            () => desktop.window.toggleMaximize().then(readMaximized),
            "window.toggleMaximize",
          )}
        >
          {maximized ? (
            <Glyph d="M6.5 9.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2zM9.5 4.5h8a3 3 0 0 1 3 3v8" />
          ) : (
            <Glyph
              d="M6.5 2.5h12a3 3 0 0 1 3 3v13a3 3 0 0 1-3 3h-12a3 3 0 0 1-3-3v-13a3 3 0 0 1 3-3z"
              weight={1.8}
            />
          )}
        </WindowButton>
        <WindowButton close label={closeLabel} onClick={once(desktop.window.close, "window.close")}>
          <Glyph d="M5 5l14 14M19 5 5 19" />
        </WindowButton>
      </div>
    </div>
  );
}

/** A 12px line glyph, sized to the reference's: 1px strokes, the minus 10px wide. */
function Glyph({ d, weight = 2 }: { d: string; weight?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3"
    >
      <path d={d} />
    </svg>
  );
}

function WindowButton({
  label,
  close = false,
  onClick,
  children,
}: {
  label: string;
  close?: boolean;
  onClick: (event: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // Not a tab stop, and pressing it keeps focus where it was, like the operating system's own.
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`app-no-drag inline-flex h-7 w-9 cursor-default items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color] duration-120 ease-in-out outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none ${
        close
          ? "hover:bg-destructive-fill hover:text-destructive-foreground active:bg-destructive-fill/78"
          : "hover:bg-foreground/8 hover:text-foreground active:bg-foreground/13"
      }`}
    >
      {children}
    </button>
  );
}

/** Maximized or full screen, read again whenever the window says it changed. */
function useMaximized(desktop: RakazoDesktop) {
  const [maximized, setMaximized] = useState(false);
  const read = useCallback(async () => {
    const state = await desktop.window.state();
    setMaximized(state.maximized || state.fullScreen);
  }, [desktop]);
  useEffect(() => {
    const refresh = () => void bestEffort("window.state", read());
    refresh();
    return desktop.window.onChange?.(refresh);
  }, [desktop, read]);
  return [maximized, read] as const;
}
