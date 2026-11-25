import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useEventListener } from "../lib/use-event-listener";

/** The thumb's thickness, its gap from the area's edge, and its shortest length, as in the reference. */
const THICKNESS_PX = 6;
const INSET_PX = 1;
const MIN_LENGTH_PX = 20;
/** A vertical thumb starts this far below the area's top and stops this far above its bottom. */
const TOP_OFFSET_PX = 7;
const BOTTOM_OFFSET_PX = 5;
/** How long a thumb shown by scrolling stays once the pointer is elsewhere. */
const SCROLL_LINGER_MS = 1000;

type Axis = "y" | "x";
type Drag = { element: Element; axis: Axis; start: number; scroll: number; ratio: number };

const overflowStyle = new WeakMap<Element, { x: boolean; y: boolean }>();

function overflowOf(element: Element) {
  const computed = getComputedStyle(element);
  // The page itself scrolls unless it is told not to, as a dialog does while it is open.
  const allowed =
    element === document.scrollingElement
      ? (value: string) => value !== "hidden" && value !== "clip"
      : (value: string) => value === "auto" || value === "scroll";
  return { x: allowed(computed.overflowX), y: allowed(computed.overflowY) };
}

function scrollsOn(element: Element, axis: Axis) {
  let style = element === document.scrollingElement ? undefined : overflowStyle.get(element);
  if (!style) {
    style = overflowOf(element);
    if (element !== document.scrollingElement) overflowStyle.set(element, style);
  }
  return axis === "y"
    ? style.y && element.scrollHeight > element.clientHeight + 1
    : style.x && element.scrollWidth > element.clientWidth + 1;
}

/** The nearest area at or above `node` that the user can scroll. */
function scrollerAt(node: EventTarget | null): Element | null {
  for (let element = node instanceof Element ? node : null; element; ) {
    if (scrollsOn(element, "y") || scrollsOn(element, "x")) return element;
    element = element.parentElement;
  }
  return null;
}

/** The thumbs OverlayScrollbars draws, loaded once the page has painted. */
export function OverlayScrollbarThumbs() {
  const vertical = useRef<HTMLDivElement>(null);
  const horizontal = useRef<HTMLDivElement>(null);
  const hovered = useRef<Element | null>(null);
  const scrolled = useRef<Element | null>(null);
  const drag = useRef<Drag | null>(null);
  const shown = useRef<Element | null>(null);
  const frame = useRef(0);
  const [scrolls, setScrolls] = useState(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function paint() {
    frame.current = 0;
    const element = drag.current?.element ?? hovered.current ?? scrolled.current;
    shown.current = element;
    const both = element ? scrollsOn(element, "y") && scrollsOn(element, "x") : false;
    place(vertical.current, element, "y", both);
    place(horizontal.current, element, "x", both);
  }

  function schedulePaint() {
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  }

  useEventListener(
    document,
    "pointermove",
    (event) => {
      if (drag.current) return;
      const target = event.target;
      if (target === vertical.current || target === horizontal.current) return;
      hovered.current = scrollerAt(target);
      schedulePaint();
    },
    { capture: true, passive: true },
  );
  useEventListener(document.documentElement, "pointerleave", () => {
    hovered.current = null;
    schedulePaint();
  });
  useEventListener(
    document,
    "scroll",
    (event) => {
      const target = event.target === document ? document.scrollingElement : event.target;
      if (!(target instanceof Element)) return;
      scrolled.current = target;
      setScrolls((count) => count + 1);
      schedulePaint();
    },
    { capture: true, passive: true },
  );
  useTimeout(
    () => {
      scrolled.current = null;
      schedulePaint();
    },
    scrolls ? SCROLL_LINGER_MS : null,
    scrolls,
  );

  function startDrag(axis: Axis, event: ReactPointerEvent<HTMLDivElement>) {
    const element = shown.current;
    if (!element || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const client = axis === "y" ? element.clientHeight : element.clientWidth;
    const content = axis === "y" ? element.scrollHeight : element.scrollWidth;
    const thumb = axis === "y" ? event.currentTarget.offsetHeight : event.currentTarget.offsetWidth;
    const track = client - (axis === "y" ? TOP_OFFSET_PX + BOTTOM_OFFSET_PX : INSET_PX * 2);
    drag.current = {
      element,
      axis,
      start: axis === "y" ? event.clientY : event.clientX,
      scroll: axis === "y" ? element.scrollTop : element.scrollLeft,
      ratio: (content - client) / Math.max(1, track - thumb),
    };
    event.currentTarget.dataset.dragging = "";
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current) return;
    const moved = (current.axis === "y" ? event.clientY : event.clientX) - current.start;
    const next = current.scroll + moved * current.ratio;
    if (current.axis === "y") current.element.scrollTop = next;
    else current.element.scrollLeft = next;
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    delete event.currentTarget.dataset.dragging;
    schedulePaint();
  }

  // The thumb sits outside the area, so a wheel turned over it scrolls the area it belongs to.
  function forwardWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    shown.current?.scrollBy({
      left: event.deltaX * scale,
      top: event.deltaY * scale,
    });
  }

  const thumb = (axis: Axis) => (
    <div
      ref={axis === "y" ? vertical : horizontal}
      aria-hidden="true"
      data-testid={`overlay-scrollbar-${axis}`}
      data-axis={axis}
      onPointerDown={(event) => startDrag(axis, event)}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onWheel={forwardWheel}
      className="pointer-events-none fixed top-0 left-0 z-[4999] rounded-full bg-hairline opacity-0 transition-[background-color,opacity] duration-150 hover:bg-border data-dragging:bg-border data-shown:pointer-events-auto data-shown:opacity-100 data-shown:[transition-duration:150ms,0ms] motion-reduce:transition-none"
    />
  );

  return (
    <>
      {thumb("y")}
      {thumb("x")}
    </>
  );
}

/** Puts `thumb` over the edge of `element` for `axis`, or hides it when that axis does not scroll. */
function place(thumb: HTMLDivElement | null, element: Element | null, axis: Axis, both: boolean) {
  if (!thumb) return;
  if (!element?.isConnected || !scrollsOn(element, axis)) {
    delete thumb.dataset.shown;
    return;
  }
  const root = element === document.scrollingElement;
  const box = root
    ? { left: 0, top: 0, width: element.clientWidth, height: element.clientHeight }
    : (() => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left + element.clientLeft,
          top: rect.top + element.clientTop,
          width: element.clientWidth,
          height: element.clientHeight,
        };
      })();
  const corner = both ? THICKNESS_PX + INSET_PX + 2 : 0;
  if (axis === "y") {
    const track = box.height - TOP_OFFSET_PX - BOTTOM_OFFSET_PX - corner;
    const length = Math.max(MIN_LENGTH_PX, (track * element.clientHeight) / element.scrollHeight);
    const progress = element.scrollTop / (element.scrollHeight - element.clientHeight);
    const rtl = getComputedStyle(element).direction === "rtl";
    const x = rtl ? box.left + INSET_PX : box.left + box.width - INSET_PX - THICKNESS_PX;
    const y = box.top + TOP_OFFSET_PX + Math.min(1, Math.max(0, progress)) * (track - length);
    Object.assign(thumb.style, {
      width: `${THICKNESS_PX}px`,
      height: `${length}px`,
      transform: `translate(${x}px, ${y}px)`,
    });
  } else {
    const track = box.width - INSET_PX * 2 - corner;
    const length = Math.max(MIN_LENGTH_PX, (track * element.clientWidth) / element.scrollWidth);
    // Right-to-left areas count their scroll position down from zero.
    const progress = Math.abs(element.scrollLeft) / (element.scrollWidth - element.clientWidth);
    const rtl = getComputedStyle(element).direction === "rtl";
    const offset = Math.min(1, Math.max(0, rtl ? 1 - progress : progress)) * (track - length);
    const x = box.left + INSET_PX + (rtl ? corner : 0) + offset;
    const y = box.top + box.height - INSET_PX - THICKNESS_PX;
    Object.assign(thumb.style, {
      width: `${length}px`,
      height: `${THICKNESS_PX}px`,
      transform: `translate(${x}px, ${y}px)`,
    });
  }
  thumb.dataset.shown = "";
}
