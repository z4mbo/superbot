import { t } from "@lingui/core/macro";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  desktopBridge,
  WINDOW_CONTROLS_BLOCK_PX,
  WINDOW_CONTROLS_INSET_PX,
  windowControlsKind,
} from "../../lib/platform/desktop";
import { useEventListener } from "../../lib/use-event-listener";
import { useBotsSidebarWidth } from "./sidebar/sidebar-layout";

const STORAGE_KEY = "rakazo:right-panel-width";
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 384;
const ABSOLUTE_MAX = 1000;
const MIN_CHAT_WIDTH = 320;
const MD_BREAKPOINT = 768;
const MOBILE_PANEL_MAX_WIDTH = 384; // Matches max-w-[384px] below.
const MAX_VISIBLE_CHAT_WIDTH = 48;
/** How far the panels' content sits in from the panel's edges (`px-5` in side-panel.tsx). */
const CONTENT_GUTTER_PX = 20;
/** Room between a panel header's last control and the divider before the window controls. */
const CONTROLS_DIVIDER_GAP_PX = 12;
const CONTROLS_DIVIDER_HEIGHT_PX = 18;

/**
 * Keeps a panel's header row, its first row, clear of window controls the page draws in that row.
 * Elsewhere the variable is unset and the row reaches the panel's edge.
 */
export const sidePanelHeaderStyle: CSSProperties = {
  paddingInlineEnd: "var(--side-panel-header-end, 0px)",
};

function maximumWidth(reservedLeadingPx: number, viewportWidth = window.innerWidth) {
  return Math.max(
    MIN_WIDTH,
    Math.min(ABSOLUTE_MAX, viewportWidth - reservedLeadingPx - MIN_CHAT_WIDTH),
  );
}

function readPreferredWidth() {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (saved >= MIN_WIDTH) return Math.min(ABSOLUTE_MAX, saved);
  } catch {
    /* Storage may be disabled. */
  }
  return DEFAULT_WIDTH;
}

export function ResizableSidePanel({
  open,
  panel,
  children,
  onCoversChat,
}: {
  open: boolean;
  panel: string;
  /** Tells the shell when the open panel covers nearly all of the chat, so it can make the chat inert. */
  onCoversChat?: (covers: boolean) => void;
  children: ReactNode;
}) {
  const sidebarWidth = useBotsSidebarWidth();
  const [preferredWidth, setPreferredWidth] = useState(readPreferredWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const belowMd = viewportWidth < MD_BREAKPOINT;
  const reservedLeadingPx = belowMd ? 0 : sidebarWidth;
  const chatWidth = viewportWidth - reservedLeadingPx;
  const maxWidth = maximumWidth(reservedLeadingPx, viewportWidth);
  const overlay = belowMd || chatWidth < MIN_CHAT_WIDTH + MIN_WIDTH;
  const [dragging, setDragging] = useState(false);
  // The page draws the window controls at the panel's top right (Linux), so the panel's header shares
  // their row, as in the reference. Where the operating system draws them over the page instead
  // (`--window-controls-block` is set), the panel starts below them.
  const sharesControlsRow = windowControlsKind(desktopBridge()) === "page";
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number; direction: number } | null>(null);
  const width = Math.max(MIN_WIDTH, Math.min(maxWidth, preferredWidth));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(preferredWidth));
    } catch {
      /* Storage may be disabled. */
    }
  }, [preferredWidth]);

  useEffect(() => {
    setViewportWidth(window.innerWidth);
  }, []);

  const panelWidth = belowMd ? Math.min(viewportWidth, MOBILE_PANEL_MAX_WIDTH) : width;
  const covering = open && overlay && chatWidth - panelWidth < MAX_VISIBLE_CHAT_WIDTH;
  useEffect(() => {
    if (!covering) return;
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused.closest('[data-space-switch="main"]')) {
      panelRef.current?.focus({ preventScroll: true });
    }
  }, [covering]);
  useEffect(() => {
    onCoversChat?.(covering);
    return () => onCoversChat?.(false);
  }, [covering, onCoversChat]);
  useEventListener(window, "resize", () => setViewportWidth(window.innerWidth));

  function stopDrag(event: PointerEvent<HTMLHRElement>) {
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function setWidthFromUser(next: number) {
    setPreferredWidth(Math.max(MIN_WIDTH, Math.min(maximumWidth(reservedLeadingPx), next)));
  }

  const panelStyle: Record<string, string> = { "--panel-width": `${width}px` };
  if (sharesControlsRow) {
    panelStyle["--side-panel-header-end"] =
      `${WINDOW_CONTROLS_INSET_PX + CONTROLS_DIVIDER_GAP_PX - CONTENT_GUTTER_PX}px`;
  } else {
    panelStyle.paddingTop = "var(--window-controls-block, 0px)";
  }

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      data-testid="side-panel"
      data-panel={panel}
      data-overlay={overlay || undefined}
      style={panelStyle}
      className={`absolute inset-y-0 end-0 z-20 flex min-h-0 shrink-0 flex-col overflow-hidden bg-sidebar focus:outline-none ${overlay ? "md:absolute" : "md:relative"} ${dragging ? "" : "transition-[width] duration-150 ease-out motion-reduce:transition-none"} ${open ? "w-full max-w-[384px] border-s border-sidebar-border md:w-(--panel-width) md:max-w-none" : "pointer-events-none w-0"}`}
    >
      {open ? (
        <hr
          tabIndex={0}
          aria-label={t`Resize panel`}
          aria-orientation="vertical"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={Math.round(width)}
          className={`absolute inset-y-0 start-0 z-30 m-0 hidden h-full w-2 touch-none cursor-col-resize border-0 bg-transparent hover:bg-border focus-visible:bg-border focus-visible:outline-none ${overlay ? "" : "md:block"}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              x: event.clientX,
              width,
              direction: document.documentElement.dir === "rtl" ? -1 : 1,
            };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (drag.current)
              setWidthFromUser(
                drag.current.width + (drag.current.x - event.clientX) * drag.current.direction,
              );
          }}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
          onKeyDown={(event) => {
            const direction = document.documentElement.dir === "rtl" ? -1 : 1;
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              setWidthFromUser(width + (event.key === "ArrowLeft" ? 32 : -32) * direction);
            } else if (event.key === "Home") {
              event.preventDefault();
              setWidthFromUser(MIN_WIDTH);
            } else if (event.key === "End") {
              event.preventDefault();
              setWidthFromUser(maximumWidth(reservedLeadingPx));
            }
          }}
        />
      ) : null}
      {open && sharesControlsRow ? (
        <span
          aria-hidden="true"
          data-testid="window-controls-divider"
          className="pointer-events-none absolute z-30 w-px bg-border"
          style={{
            insetInlineEnd: WINDOW_CONTROLS_INSET_PX,
            top: (WINDOW_CONTROLS_BLOCK_PX - CONTROLS_DIVIDER_HEIGHT_PX) / 2,
            height: CONTROLS_DIVIDER_HEIGHT_PX,
          }}
        />
      ) : null}
      {children}
    </aside>
  );
}
