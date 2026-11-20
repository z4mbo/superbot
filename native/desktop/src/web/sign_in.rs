use std::rc::Rc;

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use url::Url;
use wry::raw_window_handle::HasWindowHandle;
use wry::{NewWindowResponse, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows};

use super::policy::{self, Return, SignInStep};
use super::window::{content, profile_folder, tool, Parent};
use super::Returned;
use crate::theme::{ActiveTheme, Skin, CAPTION_HEIGHT, CAPTION_WIDTH};
use crate::ui::overlays::caption_buttons;
use crate::ui::{empty_line, icon, Type};

const TITLE: &str = "Sign in";

type Done = Box<dyn FnOnce(Returned, &mut App)>;

enum Signal {
    Title(String),
    Location(String),
    Browser(String),
    Returned(Returned),
}

pub fn open(profile: String, authorization_url: String, expected: Return, done: Done, cx: &mut App) {
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(560.), px(720.)), cx))),
        window_min_size: Some(size(px(420.), px(480.))),
        titlebar: Some(TitlebarOptions {
            title: Some(TITLE.into()),
            appears_transparent: true,
            traffic_light_position: None,
        }),
        ..Default::default()
    };
    let done = Rc::new(std::cell::RefCell::new(Some(done)));
    let held = done.clone();
    let opened = gpui_kit::open_window(options, cx, move |window, cx| {
        cx.new(|cx| SignInWindow::new(profile, authorization_url, expected, held, window, cx))
    });
    if opened.is_err() {
        if let Some(done) = done.borrow_mut().take() {
            done(Returned::Closed, cx);
        }
    }
}

struct SignInWindow {
    title: SharedString,
    location: Option<String>,
    failed: bool,
    webview: Option<Rc<WebView>>,
    bounds: Option<(Pixels, Pixels)>,
    done: Rc<std::cell::RefCell<Option<Done>>>,
    _signals: Task<()>,
    _build: Task<()>,
}

impl SignInWindow {
    fn new(
        profile: String,
        start: String,
        expected: Return,
        done: Rc<std::cell::RefCell<Option<Done>>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (signals, mut received) = unbounded_channel();
        let listen = cx.spawn_in(window, async move |this, cx| {
            while let Some(signal) = received.recv().await {
                if this.update_in(cx, |this, window, cx| this.receive(signal, window, cx)).is_err() {
                    break;
                }
            }
        });
        let build = cx.spawn_in(window, async move |this, cx| {
            let Ok(Some((parent, bounds, skin, background))) = this.update_in(cx, |_, window, cx| {
                let parent = window.window_handle().ok()?.as_raw();
                Some((parent, content(window.viewport_size()), cx.skin().skin, cx.skin().app))
            }) else {
                return;
            };
            let built = build(&profile, &start, expected, Parent(parent), bounds, skin, background, signals);
            this.update(cx, |this, cx| {
                match built {
                    Some(webview) => this.webview = Some(Rc::new(webview)),
                    None => this.failed = true,
                }
                cx.notify();
            })
            .ok();
        });
        let closing = done.clone();
        let entity = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_, cx| {
            entity.update(cx, |this, _| this.webview = None).ok();
            let pending = closing.borrow_mut().take();
            if let Some(done) = pending {
                done(Returned::Closed, cx);
            }
            true
        });
        Self {
            title: TITLE.into(),
            location: None,
            failed: false,
            webview: None,
            bounds: None,
            done,
            _signals: listen,
            _build: build,
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
            Signal::Returned(returned) => self.finish(returned, window, cx),
        }
        cx.notify();
    }

    fn finish(&mut self, returned: Returned, window: &mut Window, cx: &mut Context<Self>) {
        self.webview = None;
        let pending = self.done.borrow_mut().take();
        if let Some(done) = pending {
            done(returned, cx);
        }
        window.remove_window();
    }

    /// The site the person is signing in on, named in the toolbar.
    fn site(&self) -> Option<String> {
        Url::parse(self.location.as_deref()?).ok()?.host_str().map(str::to_owned)
    }

    fn fit(&mut self, viewport: Size<Pixels>) {
        let Some(webview) = &self.webview else { return };
        let wanted = (viewport.width, viewport.height);
        if self.bounds != Some(wanted) && webview.set_bounds(content(viewport)).is_ok() {
            self.bounds = Some(wanted);
        }
    }
}

impl Render for SignInWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.fit(window.viewport_size());
        let theme = cx.skin().clone();
        let site = self.site();
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
            .child(
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
                            .child(div().min_w_0().name().truncate().child(self.title.clone()))
                            .children(site.map(|host| {
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
                    .child(
                        tool("sign-in-browser", "external-link", "Open in browser", &theme)
                            .on_click(cx.listener(|this, _, window, cx| this.finish(Returned::Browser, window, cx))),
                    ),
            )
            .when(self.failed, |page| {
                page.child(
                    div()
                        .flex_1()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(empty_line("The sign-in page couldn't open in this window.", &theme)),
                )
            })
            .child(caption_buttons(window, &theme))
    }
}

fn build(
    profile: &str,
    start: &str,
    expected: Return,
    parent: Parent,
    bounds: wry::Rect,
    skin: Skin,
    background: Hsla,
    signals: UnboundedSender<Signal>,
) -> Option<WebView> {
    let mut context = WebContext::new(Some(profile_folder(profile)?));
    let (navigations, popups, titles, pages) = (signals.clone(), signals.clone(), signals.clone(), signals);
    let opener = expected.redirect().clone();
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
        .with_navigation_handler(move |target| match policy::sign_in_navigation(&expected, &target) {
            SignInStep::Here => true,
            SignInStep::Returned(returned) => {
                let _ = navigations.send(Signal::Returned(returned));
                false
            }
            SignInStep::Browser => {
                let _ = navigations.send(Signal::Browser(target));
                false
            }
            SignInStep::Refuse => false,
        })
        .with_new_window_req_handler(move |target, features| {
            match policy::popup(&opener, &target, features.size.is_some()) {
                policy::Popup::App => NewWindowResponse::Allow,
                policy::Popup::Browser => {
                    let _ = popups.send(Signal::Browser(target));
                    NewWindowResponse::Deny
                }
                policy::Popup::Refuse => NewWindowResponse::Deny,
            }
        })
        .with_document_title_changed_handler(move |title| {
            let _ = titles.send(Signal::Title(title));
        })
        .with_on_page_load_handler(move |_, location| {
            let _ = pages.send(Signal::Location(location));
        })
        .build_as_child(&parent)
        .ok()
}
