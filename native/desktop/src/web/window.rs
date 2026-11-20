use std::path::PathBuf;
use std::rc::Rc;

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use url::Url;
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::raw_window_handle::{self as rwh, HasWindowHandle, RawWindowHandle};
use wry::{NewWindowResponse, Rect, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows};

use super::policy::{self, Navigate, Popup};
use crate::theme::{ActiveTheme, Skin, Theme, CAPTION_HEIGHT, CAPTION_WIDTH};
use crate::ui::overlays::caption_buttons;
use crate::ui::{icon, pill_button, Tone, Type};

const TITLE: &str = "Superbot workspace";

struct Opened {
    profile: String,
    start: String,
    handle: AnyWindowHandle,
    view: WeakEntity<WebWorkspace>,
}

#[derive(Default)]
struct OpenWindows(Vec<Opened>);

impl Global for OpenWindows {}

fn open_windows(cx: &mut App) -> &mut Vec<Opened> {
    let live = cx.windows();
    let open = &mut cx.default_global::<OpenWindows>().0;
    open.retain(|opened| live.contains(&opened.handle));
    open
}

pub fn open(server: Url, profile: String, url: String, cx: &mut App) {
    let showing = open_windows(cx)
        .iter()
        .find(|opened| opened.profile == profile && opened.start == url)
        .map(|opened| opened.handle);
    if let Some(handle) = showing {
        if handle.update(cx, |_, window, _| window.activate_window()).is_ok() {
            return;
        }
    }
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1240.), px(840.)), cx))),
        window_min_size: Some(size(px(640.), px(480.))),
        titlebar: Some(TitlebarOptions {
            title: Some(TITLE.into()),
            appears_transparent: true,
            traffic_light_position: None,
        }),
        ..Default::default()
    };
    let (start, folder) = (url.clone(), profile.clone());
    let opened = gpui_kit::open_window(options, cx, move |window, cx| {
        cx.new(|cx| WebWorkspace::new(server, folder, start, window, cx))
    });
    match opened {
        Ok((handle, view)) => open_windows(cx).push(Opened { profile, start: url, handle, view: view.downgrade() }),
        Err(_) => cx.open_url(&url),
    }
}

pub fn close(profile: &str, cx: &mut App) {
    let closing: Vec<_> = open_windows(cx)
        .iter()
        .filter(|opened| opened.profile == profile)
        .map(|opened| (opened.handle, opened.view.clone()))
        .collect();
    for (handle, view) in closing {
        view.update(cx, |this, _| this.webview = None).ok();
        handle.update(cx, |_, window, _| window.remove_window()).ok();
    }
}

enum Signal {
    Title(String),
    Location(String),
    Browser(String),
}

enum Page {
    Starting,
    Open,
    NoRuntime,
    Failed,
}

struct WebWorkspace {
    server: Url,
    page: Page,
    title: SharedString,
    location: Option<String>,
    webview: Option<Rc<WebView>>,
    bounds: Option<(Pixels, Pixels)>,
    _signals: Task<()>,
    _build: Task<()>,
    _activation: Subscription,
}

impl WebWorkspace {
    fn new(server: Url, profile: String, start: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (signals, mut received) = unbounded_channel();
        let listen = cx.spawn_in(window, async move |this, cx| {
            while let Some(signal) = received.recv().await {
                if this.update_in(cx, |this, window, cx| this.receive(signal, window, cx)).is_err() {
                    break;
                }
            }
        });
        let build_server = server.clone();
        // WebView2 pumps window messages while it starts, so it is built here, outside any update.
        let build = cx.spawn_in(window, async move |this, cx| {
            let Ok(Some((parent, bounds, skin, background))) = this.update_in(cx, |_, window, cx| {
                let parent = window.window_handle().ok()?.as_raw();
                Some((parent, content(window.viewport_size()), cx.skin().skin, cx.skin().app))
            }) else {
                return;
            };
            let built = build(&build_server, &profile, &start, Parent(parent), bounds, skin, background, signals);
            this.update(cx, |this, cx| {
                match built {
                    Ok(webview) => {
                        this.webview = Some(Rc::new(webview));
                        this.page = Page::Open;
                    }
                    Err(failure) => this.page = failure,
                }
                cx.notify();
            })
            .ok();
        });
        let activation = cx.observe_window_activation(window, |this, window, _| {
            if window.is_window_active() {
                if let Some(webview) = &this.webview {
                    let _ = webview.focus();
                }
            }
        });
        let entity = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_, cx| {
            entity.update(cx, |this, _| this.webview = None).ok();
            true
        });
        Self {
            server,
            page: Page::Starting,
            title: TITLE.into(),
            location: None,
            webview: None,
            bounds: None,
            _signals: listen,
            _build: build,
            _activation: activation,
        }
    }

    fn receive(&mut self, signal: Signal, window: &mut Window, cx: &mut Context<Self>) {
        match signal {
            Signal::Title(title) => {
                let title = title.trim();
                let title = if title.is_empty() { TITLE } else { title };
                window.set_window_title(title);
                self.title = SharedString::from(title.to_owned());
            }
            Signal::Location(location) => self.location = Some(location),
            Signal::Browser(url) => cx.open_url(&url),
        }
        cx.notify();
    }

    /// The site on screen when it is not the server, as during a sign-in on another site.
    fn elsewhere(&self) -> Option<String> {
        let location = self.location.as_deref()?;
        if policy::is_server(&self.server, location) || location == "about:blank" {
            return None;
        }
        Url::parse(location).ok()?.host_str().map(str::to_owned)
    }

    fn open_in_browser(&mut self, cx: &mut Context<Self>) {
        let on_screen = self.webview.as_ref().and_then(|webview| webview.url().ok());
        cx.open_url(&policy::browser_target(&self.server, on_screen.as_deref().or(self.location.as_deref())));
    }

    fn reload(&mut self) {
        if let Some(webview) = &self.webview {
            let _ = webview.reload();
        }
    }

    fn return_home(&mut self) {
        if let Some(webview) = &self.webview {
            let _ = webview.load_url(&policy::home(&self.server));
        }
    }

    fn fit(&mut self, viewport: Size<Pixels>) {
        let Some(webview) = &self.webview else { return };
        let wanted = (viewport.width, viewport.height);
        if self.bounds != Some(wanted) && webview.set_bounds(content(viewport)).is_ok() {
            self.bounds = Some(wanted);
        }
    }

    fn render_toolbar(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let elsewhere = self.elsewhere();
        div()
            .h(CAPTION_HEIGHT)
            .flex_shrink_0()
            .pl_4()
            .pr(CAPTION_WIDTH + px(8.))
            .flex()
            .items_center()
            .gap_1()
            .border_b_1()
            .border_color(theme.hairline.opacity(0.5))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .items_center()
                    .gap_2()
                    .window_control_area(WindowControlArea::Drag)
                    .child(div().name().truncate().child(self.title.clone()))
                    .children(elsewhere.clone().map(|host| {
                        div()
                            .flex()
                            .items_center()
                            .gap_1()
                            .flex_shrink_0()
                            .meta()
                            .text_color(theme.ink_secondary)
                            .child(icon("globe", px(14.), theme.ink_secondary))
                            .child(host)
                    })),
            )
            .when(elsewhere.is_some(), |bar| {
                bar.child(
                    pill_button("web-home", "Back to workspace", Tone::Quiet, true, theme)
                        .on_click(cx.listener(|this, _, _, _| this.return_home())),
                )
            })
            .when(self.webview.is_some(), |bar| {
                bar.child(
                    tool("web-reload", "rotate-cw", "Reload", theme)
                        .on_click(cx.listener(|this, _, _, _| this.reload())),
                )
            })
            .child(
                tool("web-browser", "external-link", "Open in browser", theme)
                    .on_click(cx.listener(|this, _, _, cx| this.open_in_browser(cx))),
            )
    }

    fn render_failure(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        let text = match self.page {
            Page::NoRuntime => "This window needs the Microsoft Edge WebView2 Runtime.",
            Page::Failed => "The workspace couldn't open in this window.",
            Page::Starting | Page::Open => return None,
        };
        Some(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_3()
                .child(div().body().text_color(theme.ink_secondary).child(text))
                .child(
                    pill_button("web-fallback", "Open in browser", Tone::Primary, true, theme)
                        .on_click(cx.listener(|this, _, _, cx| this.open_in_browser(cx))),
                ),
        )
    }
}

impl Render for WebWorkspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.fit(window.viewport_size());
        let theme = cx.skin().clone();
        div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme.app)
            .text_color(theme.ink)
            .font_family(theme.font.clone())
            .text_size(px(13.))
            .line_height(px(18.))
            .child(self.render_toolbar(&theme, cx))
            .children(self.render_failure(&theme, cx))
            .child(caption_buttons(window, &theme))
    }
}

pub(super) fn tool(id: &'static str, glyph: &'static str, label: &'static str, theme: &Theme) -> Stateful<Div> {
    let hover = theme.ink_at(0.06);
    div()
        .id(id)
        .h_8()
        .px_2()
        .flex_shrink_0()
        .flex()
        .items_center()
        .gap_1p5()
        .rounded_full()
        .body()
        .text_color(theme.ink_secondary)
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .child(icon(glyph, px(16.), theme.ink_secondary))
        .child(label)
}

/// The web view's place in the window: everything under the toolbar.
pub(super) fn content(viewport: Size<Pixels>) -> Rect {
    let top = f32::from(CAPTION_HEIGHT);
    Rect {
        position: LogicalPosition::new(0.0, f64::from(top)).into(),
        size: LogicalSize::new(
            f64::from(f32::from(viewport.width)),
            f64::from((f32::from(viewport.height) - top).max(0.0)),
        )
        .into(),
    }
}

pub(super) struct Parent(pub(super) RawWindowHandle);

impl HasWindowHandle for Parent {
    fn window_handle(&self) -> Result<rwh::WindowHandle<'_>, rwh::HandleError> {
        // SAFETY: the handle is the GPUI window that asked for the web view, read on this thread just
        // before the build. Closing it during the build fails the build instead of reusing the handle.
        Ok(unsafe { rwh::WindowHandle::borrow_raw(self.0) })
    }
}

pub(super) fn runtime_installed() -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    let mut version = windows_core::PWSTR::null();
    let found = unsafe { GetAvailableCoreWebView2BrowserVersionString(windows_core::PCWSTR::null(), &mut version) };
    found.is_ok() && !webview2_com::take_pwstr(version).is_empty()
}

/// One native account's WebView2 profile on one server: its cookies and storage, kept apart from
/// every browser, other servers and other accounts. Nothing from the desktop's session is copied in.
pub(super) fn profile_folder(profile: &str) -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("Superbot").join("WebView").join(profile))
}

fn build(
    server: &Url,
    profile: &str,
    start: &str,
    parent: Parent,
    bounds: Rect,
    skin: Skin,
    background: Hsla,
    signals: UnboundedSender<Signal>,
) -> Result<WebView, Page> {
    if !runtime_installed() {
        return Err(Page::NoRuntime);
    }
    let mut context = WebContext::new(Some(profile_folder(profile).ok_or(Page::Failed)?));
    let (navigations, popups, titles, pages) = (signals.clone(), signals.clone(), signals.clone(), signals);
    let (navigation_server, popup_server) = (server.clone(), server.clone());
    let fill = Rgba::from(background);
    let channel = |value: f32| (value * 255.0).round() as u8;
    WebViewBuilder::new_with_web_context(&mut context)
        .with_url(start)
        .with_bounds(bounds)
        .with_focused(true)
        .with_devtools(false)
        .with_clipboard(false)
        .with_background_color((channel(fill.r), channel(fill.g), channel(fill.b), 255))
        // An empty list keeps WebView2's defaults, SmartScreen included, which wry would otherwise turn off.
        .with_additional_browser_args("")
        .with_theme(match skin {
            Skin::Midnight => wry::Theme::Dark,
            Skin::Daylight => wry::Theme::Light,
        })
        .with_navigation_handler(move |target| match policy::navigation(&navigation_server, &target) {
            Navigate::Here => true,
            Navigate::Browser => {
                let _ = navigations.send(Signal::Browser(target));
                false
            }
            Navigate::Refuse => false,
        })
        .with_new_window_req_handler(move |target, features| {
            match policy::popup(&popup_server, &target, features.size.is_some()) {
                Popup::App => NewWindowResponse::Allow,
                Popup::Browser => {
                    let _ = popups.send(Signal::Browser(target));
                    NewWindowResponse::Deny
                }
                Popup::Refuse => NewWindowResponse::Deny,
            }
        })
        .with_document_title_changed_handler(move |title| {
            let _ = titles.send(Signal::Title(title));
        })
        .with_on_page_load_handler(move |_, location| {
            let _ = pages.send(Signal::Location(location));
        })
        .build_as_child(&parent)
        .map_err(|_| Page::Failed)
}
