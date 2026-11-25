// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableSidePanel, sidePanelHeaderStyle } from "./resizable-side-panel";

vi.mock("./sidebar/sidebar-layout", () => ({ useBotsSidebarWidth: () => sidebarWidth }));

let sidebarWidth: number;
let host: HTMLDivElement;
let root: Root;

function Shell({ open }: { open: boolean }) {
  const [covered, setCovered] = useState(false);
  return (
    <>
      <main data-space-switch="main" inert={covered}>
        <button type="button">Message</button>
      </main>
      <ResizableSidePanel open={open} panel="settings" onCoversChat={setCovered}>
        <div data-testid="panel-header" style={sidePanelHeaderStyle}>
          <button type="button">Close panel</button>
        </div>
      </ResizableSidePanel>
    </>
  );
}

function show(open: boolean, width: number) {
  window.innerWidth = width;
  act(() => {
    root.render(<Shell open={open} />);
  });
  return host.querySelector<HTMLElement>('[data-space-switch="main"]')!;
}

describe("ResizableSidePanel", () => {
  beforeEach(() => {
    sidebarWidth = 0;
    i18n.load("en", {});
    i18n.activate("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete window.rakazoDesktop;
    vi.unstubAllGlobals();
  });

  it("makes the covered chat inert while the panel is open over it", () => {
    expect(show(true, 390).hasAttribute("inert")).toBe(true);
  });

  it("moves focus from the chat to the panel when the panel covers it", () => {
    const message = show(false, 390).querySelector("button")!;
    message.focus();
    expect(document.activeElement).toBe(message);

    show(true, 390);

    expect(document.activeElement).toBe(host.querySelector('[data-testid="side-panel"]'));
  });

  it("frees the chat again when the panel closes", () => {
    show(true, 390);
    expect(show(false, 390).hasAttribute("inert")).toBe(false);
  });

  it("keeps the visible chat interactive when the sidebar is off canvas", () => {
    sidebarWidth = 316;
    expect(show(true, 600).hasAttribute("inert")).toBe(false);
  });

  it("makes the chat inert when the overlay covers nearly all of it beside the sidebar", () => {
    sidebarWidth = 460;
    expect(show(true, 800).hasAttribute("inert")).toBe(true);
  });

  it("keeps the visible chat interactive when the overlay partially covers it beside the sidebar", () => {
    sidebarWidth = 316;
    expect(show(true, 800).hasAttribute("inert")).toBe(false);
  });

  it("ignores the hidden sidebar when the panel covers a phone-sized chat", () => {
    sidebarWidth = 316;
    expect(show(true, 390).hasAttribute("inert")).toBe(true);
  });

  describe("top row", () => {
    const panel = () => host.querySelector<HTMLElement>('[data-testid="side-panel"]')!;
    const header = () => host.querySelector<HTMLElement>('[data-testid="panel-header"]')!;
    const divider = () =>
      host.querySelector<HTMLElement>('[data-testid="window-controls-divider"]');
    const headerEnd = () => {
      // jsdom resolves no custom properties, so read the one the panel sets and the row reads.
      expect(header().style.paddingInlineEnd).toBe("var(--side-panel-header-end, 0px)");
      return panel().style.getPropertyValue("--side-panel-header-end");
    };

    it("puts its header beside window controls the page draws, with a divider between", () => {
      window.rakazoDesktop = { platform: "linux", nativeWindowFrame: false } as never;
      show(true, 1280);
      expect(panel().style.paddingTop).toBe("");
      // The 140px the controls take, plus the 12px before the divider, less the 20px gutter.
      expect(headerEnd()).toBe("132px");
      expect(divider()?.style.insetInlineEnd).toBe("140px");
      expect(divider()?.style.top).toBe("17px");
      show(false, 1280);
      expect(divider()).toBeNull();
    });

    it("starts below controls the operating system draws over the page", () => {
      window.rakazoDesktop = { platform: "win32", nativeWindowFrame: true } as never;
      vi.stubGlobal("navigator", { ...navigator, windowControlsOverlay: { visible: true } });
      show(true, 1280);
      expect(panel().style.paddingTop).toBe("var(--window-controls-block, 0px)");
      expect(headerEnd()).toBe("");
      expect(divider()).toBeNull();
    });

    it("keeps its header at the top edge in a browser", () => {
      show(true, 1280);
      // The variable is unset in a browser, so this adds nothing.
      expect(panel().style.paddingTop).toBe("var(--window-controls-block, 0px)");
      expect(headerEnd()).toBe("");
      expect(divider()).toBeNull();
    });
  });

  it("leaves the chat alone when the panel sits beside it", () => {
    const message = show(false, 1500).querySelector("button")!;
    message.focus();

    expect(show(true, 1500).hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(message);
  });
});
