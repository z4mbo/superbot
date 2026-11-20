//! The system web view on each platform: Microsoft Edge WebView2 on Windows, WKWebView on macOS
//! and WebKitGTK on Linux, and what each needs to show a page inside this app.

use std::path::PathBuf;

use gpui_kit::{App, Window};
use wry::raw_window_handle::{self as rwh, HasWindowHandle, RawWindowHandle};
use wry::{WebContext, WebViewBuilder};

/// Why no web view can be shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Missing {
    /// Windows without the Microsoft Edge WebView2 Runtime.
    Runtime,
    /// Linux without a display GTK can open.
    Display,
}

impl Missing {
    pub fn sentence(self) -> &'static str {
        match self {
            Self::Runtime => "This needs the Microsoft Edge WebView2 Runtime.",
            Self::Display => "This needs a desktop session WebKitGTK can open.",
        }
    }
}

/// Whether this system can show a web view now. On Linux this starts GTK, once.
pub fn ready() -> Result<(), Missing> {
    if !runtime_installed() {
        return Err(Missing::Runtime);
    }
    if !own::started() {
        return Err(Missing::Display);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn runtime_installed() -> bool {
    true
}

#[cfg(target_os = "windows")]
pub fn runtime_installed() -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    let mut version = windows_core::PWSTR::null();
    let found = unsafe { GetAvailableCoreWebView2BrowserVersionString(windows_core::PCWSTR::null(), &mut version) };
    found.is_ok() && !webview2_com::take_pwstr(version).is_empty()
}

/// Where a web view goes: inside an app window, or, where the window system cannot hold a
/// child view (Linux on Wayland), in a window of its own.
pub enum Host {
    Child(ParentWindow),
    Own,
}

pub use own::Own;

/// The app window a web view is a child of, read on the GUI thread just before the build.
pub struct ParentWindow(RawWindowHandle);

pub fn host(window: &Window) -> Option<Host> {
    let raw = HasWindowHandle::window_handle(window).ok()?.as_raw();
    match raw {
        RawWindowHandle::Wayland(_) => Some(Host::Own),
        // WebKitGTK parents its view to an Xlib window; an XCB id names the same X window.
        RawWindowHandle::Xcb(xcb) => {
            Some(Host::Child(ParentWindow(RawWindowHandle::Xlib(rwh::XlibWindowHandle::new(xcb.window.get().into())))))
        }
        raw => Some(Host::Child(ParentWindow(raw))),
    }
}

impl HasWindowHandle for ParentWindow {
    fn window_handle(&self) -> Result<rwh::WindowHandle<'_>, rwh::HandleError> {
        // SAFETY: the handle is the app window that asked for the web view, read on this thread just
        // before the build. Closing it during the build fails the build instead of reusing the handle.
        Ok(unsafe { rwh::WindowHandle::borrow_raw(self.0) })
    }
}

/// Whose cookies and storage a web view uses.
#[derive(Clone)]
pub enum Profile {
    /// One native account on one server (`policy::profile_key`), kept between launches and
    /// apart from every other account, server and browser.
    Account(String),
    /// Nothing kept: an agent's screen.
    Private,
}

/// The web context and store a web view starts with for `profile`. Build the view from the
/// returned context with [`WebViewBuilder::new_with_web_context`], then pass the builder through
/// [`isolate`].
pub fn context(profile: &Profile) -> WebContext {
    WebContext::new(match profile {
        Profile::Account(key) => data_root().map(|root| root.join(key)),
        Profile::Private => data_root().map(|root| root.join("screens")),
    })
}

pub fn isolate<'a>(builder: WebViewBuilder<'a>, profile: &Profile) -> WebViewBuilder<'a> {
    match profile {
        Profile::Private => builder.with_incognito(true),
        Profile::Account(key) => account_store(builder, key),
    }
}

#[cfg(not(target_os = "macos"))]
fn account_store<'a>(builder: WebViewBuilder<'a>, _: &str) -> WebViewBuilder<'a> {
    builder
}

/// WKWebView keeps an account's data in a store named by 16 bytes of its profile key. Named
/// stores exist from macOS 14; before that WebKit would fall back to the store every view
/// shares, so those views keep nothing instead.
#[cfg(target_os = "macos")]
fn account_store<'a>(builder: WebViewBuilder<'a>, key: &str) -> WebViewBuilder<'a> {
    use wry::WebViewBuilderExtDarwin;
    match store_identifier(key).filter(|_| macos::named_stores()) {
        Some(identifier) => builder.with_data_store_identifier(identifier),
        None => builder.with_incognito(true),
    }
}

#[cfg(any(target_os = "macos", test))]
fn store_identifier(key: &str) -> Option<[u8; 16]> {
    let bytes: Vec<u8> = (0..key.len())
        .step_by(2)
        .map(|at| key.get(at..at + 2).and_then(|pair| u8::from_str_radix(pair, 16).ok()))
        .collect::<Option<_>>()?;
    bytes.try_into().ok()
}

/// The folder web profiles live in: the local app data folder on Windows, the user's data
/// folder elsewhere. macOS keeps WKWebView data in its own stores and ignores it.
fn data_root() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share")));
    Some(base?.join("Superbot").join("WebView"))
}

thread_local! {
    static PUMPING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Keeps GTK's events moving while web views are open, every frame from the first one on: GTK has
/// no loop of its own here, since GPUI runs the app's. Windows and macOS need nothing.
pub fn pump(cx: &mut App) {
    if !cfg!(target_os = "linux") || PUMPING.with(|pumping| pumping.replace(true)) {
        return;
    }
    cx.spawn(async move |cx| loop {
        cx.background_executor().timer(std::time::Duration::from_millis(16)).await;
        own::pending();
    })
    .detach();
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::OnceLock;

    pub fn named_stores() -> bool {
        static MAJOR: OnceLock<u32> = OnceLock::new();
        *MAJOR.get_or_init(|| {
            std::process::Command::new("/usr/bin/sw_vers")
                .arg("-productVersion")
                .output()
                .ok()
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .and_then(|version| version.trim().split('.').next()?.parse().ok())
                .unwrap_or(0)
        }) >= 14
    }
}

#[cfg(target_os = "linux")]
mod own {
    use std::cell::Cell;

    thread_local! {
        static STARTED: Cell<Option<bool>> = const { Cell::new(None) };
    }

    /// Starts GTK on the GUI thread, once. On an X11 session GTK must use X11 too, since the
    /// views it parents into app windows are X windows.
    pub fn started() -> bool {
        STARTED.with(|started| {
            if let Some(started) = started.get() {
                return started;
            }
            if std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var_os("DISPLAY").is_some() {
                // SAFETY: set on the GUI thread before GTK starts and before any thread reads it.
                unsafe { std::env::set_var("GDK_BACKEND", "x11") };
            }
            let ok = gtk::init().is_ok();
            started.set(Some(ok));
            ok
        })
    }

    pub fn pending() {
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
    }

    /// A web view in a GTK window of its own, for a window system that cannot hold it inside
    /// an app window.
    pub struct Own {
        window: gtk::Window,
    }

    impl Own {
        pub fn build(
            title: &str,
            width: i32,
            height: i32,
            builder: wry::WebViewBuilder<'_>,
        ) -> wry::Result<(Self, wry::WebView)> {
            use gtk::prelude::*;
            use wry::WebViewBuilderExtUnix;
            let window = gtk::Window::new(gtk::WindowType::Toplevel);
            window.set_title(title);
            window.set_default_size(width, height);
            let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
            window.add(&container);
            let webview = builder.build_gtk(&container)?;
            window.show_all();
            Ok((Self { window }, webview))
        }

        pub fn set_title(&self, title: &str) {
            use gtk::prelude::*;
            self.window.set_title(title);
        }

        pub fn present(&self) {
            use gtk::prelude::*;
            self.window.present();
        }

        /// Runs `closed` once the person closes the window.
        pub fn on_close(&self, closed: impl Fn() + 'static) {
            use gtk::prelude::*;
            self.window.connect_delete_event(move |_, _| {
                closed();
                gtk::glib::Propagation::Proceed
            });
        }
    }

    impl Drop for Own {
        fn drop(&mut self) {
            use gtk::prelude::*;
            // SAFETY: the window belongs to this host and nothing else keeps it.
            unsafe { self.window.destroy() };
        }
    }
}

/// Off Linux every app window holds its web views, so no view gets a window of its own.
#[cfg(not(target_os = "linux"))]
mod own {
    pub fn started() -> bool {
        true
    }

    pub fn pending() {}

    pub struct Own;

    impl Own {
        pub fn build(_: &str, _: i32, _: i32, _: wry::WebViewBuilder<'_>) -> wry::Result<(Self, wry::WebView)> {
            Err(wry::Error::UnsupportedWindowHandle)
        }

        pub fn set_title(&self, _: &str) {}

        pub fn present(&self) {}

        pub fn on_close(&self, _: impl Fn() + 'static) {}
    }
}

/// GPUI opens its Linux windows on Wayland whenever a Wayland display is offered.
pub fn wayland() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_key_names_one_store() {
        assert_eq!(
            store_identifier("00112233445566778899aabbccddeeff"),
            Some([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
        );
        assert_eq!(store_identifier("0011"), None);
        assert_eq!(store_identifier("zz112233445566778899aabbccddeeff"), None);
    }
}
