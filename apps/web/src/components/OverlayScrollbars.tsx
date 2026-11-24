import { Suspense, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { lazyComponent } from "../lib/platform/preload-recovery";

const OverlayScrollbarThumbs = lazyComponent(() =>
  import("./OverlayScrollbarThumbs").then((module) => module.OverlayScrollbarThumbs),
);

/** Whether the platform's own scrollbars take room beside the content and draw a track. */
function classicScrollbars() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;top:-200px;width:100px;height:100px;overflow:scroll";
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width > 0;
}

/**
 * Scrollbars as the reference draws them: no track or arrows, and no room taken from the content,
 * just a thin rounded thumb over the edge of the area the pointer is over or that is scrolling.
 * Platforms whose own scrollbars already overlay the content (macOS by default, phones) keep them;
 * elsewhere the page hides its native scrollbars at once and draws the thumb in their place.
 */
export function OverlayScrollbars() {
  const [enabled] = useState(classicScrollbars);
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    root.dataset.overlayScrollbars = "";
    return () => {
      delete root.dataset.overlayScrollbars;
    };
  }, [enabled]);
  return enabled
    ? createPortal(
        <Suspense fallback={null}>
          <OverlayScrollbarThumbs />
        </Suspense>,
        document.body,
      )
    : null;
}
