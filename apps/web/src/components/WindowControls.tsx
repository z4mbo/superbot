import { useLingui } from "@lingui/react/macro";
import { bestEffort } from "@rakazo/logging/best-effort";
import { Copy, Minus, Square, X } from "lucide-react";
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
    <div
      data-testid="window-controls"
      className="app-drag fixed top-0 right-0 z-[5000] flex items-center pe-3"
      style={{ height: WINDOW_CONTROLS_BLOCK_PX }}
    >
      <div className="flex items-center gap-0.5">
        <WindowButton
          label={minimizeLabel}
          onClick={once(desktop.window.minimize, "window.minimize")}
        >
          <Minus />
        </WindowButton>
        <WindowButton
          label={maximizeLabel}
          // Older desktop releases send no change signal, so read the state after acting.
          onClick={once(
            () => desktop.window.toggleMaximize().then(readMaximized),
            "window.toggleMaximize",
          )}
        >
          {maximized ? <Copy /> : <Square />}
        </WindowButton>
        <WindowButton close label={closeLabel} onClick={once(desktop.window.close, "window.close")}>
          <X />
        </WindowButton>
      </div>
    </div>
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
      className={`app-no-drag inline-flex h-7 w-9 cursor-default items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color] duration-120 ease-in-out outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none [&_svg]:size-3 [&_svg]:stroke-[1.5] ${
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
