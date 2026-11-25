import type { HTMLAttributes, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import {
  BOTS_SIDEBAR_MIN_WIDTH,
  clampBotsSidebarWidth,
  maximumBotsSidebarWidth,
  readBotsSidebarWidth,
  writeBotsSidebarWidth,
} from "../../../lib/preferences/bots-sidebar-width-pref";
import { useEventListener } from "../../../lib/use-event-listener";

function direction() {
  return document.documentElement.dir === "rtl" ? -1 : 1;
}

export function useSidebarResize({ userId }: { userId: string | null | undefined }) {
  const [preferredWidth, setPreferredWidth] = useState(() => readBotsSidebarWidth(userId));
  // Only the limit is kept, so resizing the window re-renders the shell only when it changes.
  const [maxWidth, setMaxWidth] = useState(() => maximumBotsSidebarWidth(window.innerWidth));
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    width: number;
    direction: number;
  } | null>(null);
  const width =
    dragWidth !== null
      ? Math.min(maxWidth, dragWidth)
      : clampBotsSidebarWidth(preferredWidth, maxWidth);

  useEffect(() => {
    setPreferredWidth(readBotsSidebarWidth(userId));
    drag.current = null;
    setDragWidth(null);
  }, [userId]);

  useEventListener(window, "resize", () => setMaxWidth(maximumBotsSidebarWidth(window.innerWidth)));

  function commit(next: number) {
    const clamped = clampBotsSidebarWidth(next, maxWidth);
    setPreferredWidth(clamped);
    writeBotsSidebarWidth(userId, clamped);
  }

  function release(event: PointerEvent<HTMLElement>) {
    drag.current = null;
    setDragWidth(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function widthAt(clientX: number) {
    const current = drag.current;
    if (!current) return width;
    return clampBotsSidebarWidth(
      current.width + (clientX - current.startX) * current.direction,
      maxWidth,
    );
  }

  const handleProps: HTMLAttributes<HTMLElement> = {
    role: "separator",
    tabIndex: 0,
    "aria-orientation": "vertical",
    "aria-valuemin": BOTS_SIDEBAR_MIN_WIDTH,
    "aria-valuemax": maxWidth,
    "aria-valuenow": Math.round(width),
    onPointerDown(event) {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        width,
        direction: direction(),
      };
      setDragWidth(width);
    },
    onPointerMove(event) {
      if (drag.current?.pointerId !== event.pointerId) return;
      setDragWidth(widthAt(event.clientX));
    },
    onPointerUp(event) {
      if (drag.current?.pointerId !== event.pointerId) return;
      commit(widthAt(event.clientX));
      release(event);
    },
    onPointerCancel(event) {
      if (drag.current?.pointerId !== event.pointerId) return;
      release(event);
    },
    onLostPointerCapture(event) {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      setDragWidth(null);
    },
    onKeyDown(event) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        commit(width + (event.key === "ArrowRight" ? 32 : -32) * direction());
      } else if (event.key === "Home") {
        event.preventDefault();
        commit(BOTS_SIDEBAR_MIN_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        commit(maxWidth);
      }
    },
  };

  return {
    width,
    resizing: dragWidth !== null,
    handleProps,
  };
}
