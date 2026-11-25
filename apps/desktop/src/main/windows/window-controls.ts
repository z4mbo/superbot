import { BrowserWindow, nativeTheme } from "electron";
import type { IpcCaller } from "../ipc/ipc.js";
import { handleIpc } from "../ipc/ipc.js";
import { titleBarOverlay } from "./window-options.js";

function minimize(win: BrowserWindow | null) {
  win?.minimize();
}

/** Maximize toggles to restore, and restore also leaves full screen. */
function toggleMaximize(win: BrowserWindow | null) {
  if (!win) return;
  if (win.isMaximized() || win.isFullScreen()) {
    win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
  } else {
    win.maximize();
  }
}

function windowState(win: BrowserWindow | null) {
  return {
    minimized: win?.isMinimized() ?? false,
    maximized: win?.isMaximized() ?? false,
    fullScreen: win?.isFullScreen() ?? false,
  };
}

/**
 * Each acts on the window that sent the call, never on the app window: the page a server switch
 * is replacing may call these too, and its buttons must not move the window that replaces it.
 */
export function registerWindowControls() {
  const windowFrom = (event: IpcCaller) => BrowserWindow.fromWebContents(event.sender);
  handleIpc("desktop.window.close", (event) => {
    windowFrom(event)?.close();
  });
  handleIpc("desktop.window.minimize", (event) => minimize(windowFrom(event)));
  handleIpc("desktop.window.toggleMaximize", (event) => toggleMaximize(windowFrom(event)));
  handleIpc("desktop.window.state", (event) => windowState(windowFrom(event)));
  handleIpc("desktop.setup.window.minimize", (event) => minimize(windowFrom(event)));
  handleIpc("desktop.setup.window.toggleMaximize", (event) => toggleMaximize(windowFrom(event)));
  handleIpc("desktop.setup.window.state", (event) => windowState(windowFrom(event)));
}

/**
 * Tells the window's page when maximize or full screen changes, so its maximize control can
 * show restore. The signal carries nothing: the page reads the state again.
 */
export function signalWindowState(win: BrowserWindow) {
  const signal = () => {
    if (!win.isDestroyed()) win.webContents.send("desktop.window.changed");
  };
  win.on("maximize", signal);
  win.on("unmaximize", signal);
  win.on("enter-full-screen", signal);
  win.on("leave-full-screen", signal);
}

/** Windows paints its overlay controls itself, so they follow the system light or dark theme. */
export function followSystemTheme(win: BrowserWindow) {
  if (process.platform !== "win32") return;
  const sync = () => {
    if (!win.isDestroyed())
      win.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors));
  };
  nativeTheme.on("updated", sync);
  win.once("closed", () => nativeTheme.off("updated", sync));
}
