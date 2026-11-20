pub use system::{parent_window, ScreenView};

/// What the server's screen page says about its connection. The page's shim sends only this word,
/// through the bridge the mobile app also uses: never the address or the page's text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenState {
    Loading,
    Connecting,
    Connected,
    Failed,
    Disconnected,
}

impl ScreenState {
    fn parse(message: &str) -> Option<Self> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Report {
            rakazo_screen: String,
        }
        let report: Report = serde_json::from_str(message).ok()?;
        Some(match report.rakazo_screen.as_str() {
            "loading" => Self::Loading,
            "connecting" => Self::Connecting,
            "connected" => Self::Connected,
            "failed" => Self::Failed,
            "disconnected" => Self::Disconnected,
            _ => return None,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ScreenFailure {
    /// Windows without the Microsoft Edge WebView2 Runtime.
    NoRuntime,
    /// A system with no web view this app embeds.
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    Unsupported,
    Failed,
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod system {
    use std::path::PathBuf;

    use gpui_kit::{Bounds, Hsla, Pixels, Rgba};
    use tokio::sync::mpsc::UnboundedSender;
    use url::Url;
    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::raw_window_handle::{self as rwh, HasWindowHandle, RawWindowHandle};
    use wry::{NewWindowResponse, Rect, WebContext, WebView, WebViewBuilder};

    use super::{ScreenFailure, ScreenState};
    use crate::web::policy;

    const BRIDGE: &str = r#"Object.defineProperty(window, "ReactNativeWebView", {
      value: Object.freeze({ postMessage: (message) => window.ipc.postMessage(String(message)) }),
    });"#;

    /// One agent's live screen, drawn by the system web view as a child of the app window over the
    /// side panel. It shows only the server's own screen pages; the capability in their address is
    /// never logged or shown.
    pub struct ScreenView {
        webview: WebView,
        server: Url,
    }

    impl ScreenView {
        pub fn build(
            parent: ParentWindow,
            server: &Url,
            screen: &str,
            bounds: Bounds<Pixels>,
            background: Hsla,
            states: UnboundedSender<ScreenState>,
        ) -> Result<Self, ScreenFailure> {
            #[cfg(target_os = "windows")]
            if !crate::web::window::runtime_installed() {
                return Err(ScreenFailure::NoRuntime);
            }
            if !policy::screen_page(server, screen) {
                return Err(ScreenFailure::Failed);
            }
            let mut context = WebContext::new(data_folder());
            let (navigation_server, ipc_server) = (server.clone(), server.clone());
            let fill = Rgba::from(background);
            let channel = |value: f32| (value * 255.0).round() as u8;
            let webview = WebViewBuilder::new_with_web_context(&mut context)
                .with_url(screen)
                .with_bounds(rect(bounds))
                .with_focused(false)
                .with_incognito(true)
                .with_devtools(false)
                .with_clipboard(false)
                .with_background_color((channel(fill.r), channel(fill.g), channel(fill.b), 255))
                .with_initialization_script_for_main_only(BRIDGE, true)
                .with_navigation_handler(move |target| policy::screen_page(&navigation_server, &target))
                .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
                .with_ipc_handler(move |request| {
                    if !policy::screen_page(&ipc_server, &request.uri().to_string()) {
                        return;
                    }
                    if let Some(state) = ScreenState::parse(request.body()) {
                        let _ = states.send(state);
                    }
                })
                .build_as_child(&parent)
                .map_err(|_| ScreenFailure::Failed)?;
            Ok(Self { webview, server: server.clone() })
        }

        pub fn place(&self, bounds: Bounds<Pixels>) {
            let _ = self.webview.set_bounds(rect(bounds));
        }

        pub fn show(&self, visible: bool) {
            let _ = self.webview.set_visible(visible);
        }

        /// Loads a newer address of the same screen, as after taking or handing back control.
        pub fn load(&self, screen: &str) {
            if policy::screen_page(&self.server, screen) {
                let _ = self.webview.load_url(screen);
            }
        }
    }

    fn rect(bounds: Bounds<Pixels>) -> Rect {
        Rect {
            position: LogicalPosition::new(
                f64::from(f32::from(bounds.origin.x)),
                f64::from(f32::from(bounds.origin.y)),
            )
            .into(),
            size: LogicalSize::new(
                f64::from(f32::from(bounds.size.width).max(0.0)),
                f64::from(f32::from(bounds.size.height).max(0.0)),
            )
            .into(),
        }
    }

    /// Screens keep nothing between visits: they run in-private, in a folder of their own.
    fn data_folder() -> Option<PathBuf> {
        let local = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("HOME"))?;
        Some(PathBuf::from(local).join("Superbot").join("WebView").join("screens"))
    }

    /// The app window a screen view is a child of, read on the GUI thread just before the build.
    pub struct ParentWindow(RawWindowHandle);

    pub fn parent_window(window: &gpui_kit::Window) -> Option<ParentWindow> {
        Some(ParentWindow(HasWindowHandle::window_handle(window).ok()?.as_raw()))
    }

    impl HasWindowHandle for ParentWindow {
        fn window_handle(&self) -> Result<rwh::WindowHandle<'_>, rwh::HandleError> {
            // SAFETY: the handle is the app window that asked for the screen, read on this thread just
            // before the build. Closing it during the build fails the build instead of reusing the handle.
            Ok(unsafe { rwh::WindowHandle::borrow_raw(self.0) })
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod system {
    use gpui_kit::{Bounds, Hsla, Pixels};
    use tokio::sync::mpsc::UnboundedSender;
    use url::Url;

    use super::{ScreenFailure, ScreenState};

    pub struct ParentWindow;

    pub fn parent_window(_: &gpui_kit::Window) -> Option<ParentWindow> {
        None
    }

    pub struct ScreenView;

    impl ScreenView {
        pub fn build(
            _: ParentWindow,
            _: &Url,
            _: &str,
            _: Bounds<Pixels>,
            _: Hsla,
            _: UnboundedSender<ScreenState>,
        ) -> Result<Self, ScreenFailure> {
            Err(ScreenFailure::Unsupported)
        }

        pub fn place(&self, _: Bounds<Pixels>) {}

        pub fn show(&self, _: bool) {}

        pub fn load(&self, _: &str) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bridge_carries_only_known_state_words() {
        assert_eq!(ScreenState::parse(r#"{"rakazoScreen":"connected"}"#), Some(ScreenState::Connected));
        assert_eq!(ScreenState::parse(r#"{"rakazoScreen":"failed"}"#), Some(ScreenState::Failed));
        assert_eq!(ScreenState::parse(r#"{"rakazoScreen":"elsewhere"}"#), None);
        assert_eq!(ScreenState::parse("connected"), None);
    }
}
