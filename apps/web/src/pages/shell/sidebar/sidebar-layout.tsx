import { useLingui } from "@lingui/react/macro";
import { SidebarProvider } from "@rakazo/ui-web";
import type { ComponentProps, CSSProperties } from "react";
import { createContext, useContext } from "react";
import { BOTS_SIDEBAR_DEFAULT_WIDTH } from "../../../lib/preferences/bots-sidebar-width-pref";
import { useSidebarResize } from "./use-sidebar-resize";

const SidebarWidthContext = createContext(BOTS_SIDEBAR_DEFAULT_WIDTH);
/** The reference desktop app's resize handle, centred on the sidebar's edge. */
const RESIZE_HANDLE_WIDTH = 12;

export function useBotsSidebarWidth() {
  return useContext(SidebarWidthContext);
}

export function BotsSidebarLayout({
  userId,
  computerOpen,
  children,
  ...props
}: ComponentProps<typeof SidebarProvider> & {
  userId: string | null | undefined;
  computerOpen: boolean;
}) {
  const { t } = useLingui();
  const { width, resizing, handleProps } = useSidebarResize({ userId });
  return (
    <SidebarWidthContext value={width}>
      <SidebarProvider
        {...props}
        open
        style={
          { "--sidebar-width": `${width}px`, "--sidebar-width-icon": `${width}px` } as CSSProperties
        }
        data-resizing-sidebar={resizing || undefined}
      >
        {children}
        {/* The full-screen computer covers the sidebar, so its edge must not catch clicks there. */}
        {computerOpen ? null : (
          <hr
            {...handleProps}
            data-testid="bots-sidebar-edge"
            aria-label={t`Resize bots sidebar`}
            style={{
              insetInlineStart: width - RESIZE_HANDLE_WIDTH / 2 - 1,
              width: RESIZE_HANDLE_WIDTH,
            }}
            className="absolute inset-y-0 z-50 m-0 hidden h-full border-0 bg-transparent cursor-col-resize touch-none select-none after:absolute after:inset-y-0 after:start-[5px] after:w-0.5 focus-visible:outline-none hover:after:bg-sidebar-border focus-visible:after:bg-sidebar-border md:block"
          />
        )}
      </SidebarProvider>
    </SidebarWidthContext>
  );
}
