use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::sync::mpsc::unbounded_channel;
use url::Url;

use super::*;
use crate::runtime::{detach, network};
use crate::web::screen::{parent_window, ScreenDocument, ScreenFailure, ScreenState, ScreenView};

/// How often an open screen checks in: it keeps the computer awake, and control alive while held.
const HEARTBEAT: Duration = Duration::from_secs(60);
const CONTROL_HEARTBEAT: Duration = Duration::from_secs(15);
const PANEL_HEADER: Pixels = px(56.);
const SCREEN_TOOLBAR: Pixels = px(48.);

static SESSIONS: AtomicU64 = AtomicU64::new(0);

pub(super) enum ScreenPhase {
    Opening,
    Live,
    Unavailable(String),
}

pub(super) struct ControlLease {
    owner: (Features, String),
    agent: String,
    id: Option<String>,
}

impl ControlLease {
    pub(super) async fn acquire(owner: (Features, String), agent: String) -> Result<Self, superbot_client::Error> {
        let control = owner.0.space(&owner.1).take_computer_control(&agent).await?;
        Ok(Self { owner, agent, id: Some(control.lease_id) })
    }
}

impl Drop for ControlLease {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            let ((features, space), agent) = (self.owner.clone(), self.agent.clone());
            detach(async move { features.space(space).release_computer_control(&agent, &id).await });
        }
    }
}

/// An agent's live screen, open in the side panel. Dropping it closes the view and hands back
/// control this account still holds.
pub(super) struct ScreenSession {
    serial: u64,
    agent_id: String,
    phase: ScreenPhase,
    state: Option<ScreenState>,
    busy: bool,
    view: Option<Rc<ScreenView>>,
    lease: Option<ControlLease>,
    placed: Option<(Bounds<Pixels>, bool)>,
    owner: (Features, String),
    _tasks: Vec<Task<()>>,
}

impl ScreenSession {
    fn unavailable(&mut self, message: impl Into<String>) {
        self.view = None;
        self.lease = None;
        self.busy = false;
        self.phase = ScreenPhase::Unavailable(message.into());
    }
}

/// The screen page on the server this app is signed in to. Screens are proxied under `/novnc/`
/// on the web origin; the API can name that origin differently (localhost or 127.0.0.1), so the
/// page is loaded from the signed-in server, as the web client loads it from its own origin.
fn screen_address(server: &Url, issued: &str) -> Option<String> {
    let issued = Url::parse(issued).ok()?;
    if !matches!(issued.scheme(), "http" | "https") || !issued.path().starts_with("/novnc/session/") {
        return None;
    }
    let mut page = server.clone();
    page.set_path(issued.path());
    page.set_query(issued.query());
    page.set_fragment(issued.fragment());
    Some(page.into())
}

/// Where the screen sits in the window: the panel below its header and the screen's toolbar.
fn screen_bounds(viewport: Size<Pixels>) -> Bounds<Pixels> {
    let width = panel_width(viewport.width) - px(1.);
    let top = PANEL_HEADER + SCREEN_TOOLBAR;
    Bounds::new(point(viewport.width - width, top), size(width, (viewport.height - top).max(px(0.))))
}

impl Desktop {
    fn screen(&self) -> Option<&ScreenSession> {
        self.agent_panel.as_ref()?.screen.as_ref()
    }

    fn screen_of(&mut self, serial: u64) -> Option<&mut ScreenSession> {
        self.agent_panel.as_mut()?.screen.as_mut().filter(|screen| screen.serial == serial)
    }

    pub(super) fn open_screen(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(owner) = self.features() else { return };
        let Some(panel) = self.agent_panel.as_mut() else { return };
        let serial = SESSIONS.fetch_add(1, Ordering::Relaxed);
        let agent_id = panel.agent_id.clone();
        let heartbeat = cx.spawn(async move |this, cx| loop {
            let Some((work, every)) = this
                .update(cx, |this, _| {
                    let screen = this.screen().filter(|screen| screen.serial == serial)?;
                    let ((features, space), agent) = (screen.owner.clone(), screen.agent_id.clone());
                    let every = if screen.lease.is_some() { CONTROL_HEARTBEAT } else { HEARTBEAT };
                    Some((async move { features.space(space).computer_heartbeat(&agent).await }, every))
                })
                .ok()
                .flatten()
            else {
                break;
            };
            let _ = network(work).await;
            cx.background_executor().timer(every).await;
        });
        panel.screen = Some(ScreenSession {
            serial,
            agent_id,
            phase: ScreenPhase::Opening,
            state: None,
            lease: None,
            busy: false,
            view: None,
            placed: None,
            owner,
            _tasks: vec![heartbeat],
        });
        self.load_screen(serial, window, cx);
        cx.notify();
    }

    pub(crate) fn close_screen(&mut self, cx: &mut Context<Self>) {
        if let Some(panel) = self.agent_panel.as_mut() {
            if panel.screen.take().is_some() {
                panel.computer = None;
                cx.notify();
            }
        }
    }

    /// Reads the screen's address for this account (interactive while it holds control) and
    /// shows it, building the view the first time.
    fn load_screen(&mut self, serial: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(server) = self.api.as_ref().and_then(|api| Url::parse(api.client.server()).ok()) else { return };
        let Some(screen) = self.screen_of(serial) else { return };
        let ((features, space), agent) = (screen.owner.clone(), screen.agent_id.clone());
        let work = async move { features.space(space).computer_screen(&agent).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            let issued = match result {
                Ok(screen) => screen,
                Err(error) => {
                    if let Some(screen) = this.screen_of(serial) {
                        screen.unavailable(api::explain(&error));
                    }
                    return;
                }
            };
            let Some(screen) = this.screen_of(serial) else { return };
            screen.busy = false;
            let Some(address) = issued.url else {
                screen.unavailable("The screen isn't ready yet. Start the computer and try again.");
                return;
            };
            let Some(url) = screen_address(&server, &address) else {
                screen.unavailable("This computer's screen can't be shown in the app.");
                return;
            };
            let page = ScreenDocument { url, session: issued.screen_session };
            match &screen.view {
                Some(view) => {
                    screen.state = None;
                    if view.load(&page).is_err() {
                        screen.unavailable("The screen couldn't open. Try again.");
                    }
                }
                None => this.build_screen(serial, server, page, window, cx),
            }
        });
    }

    fn build_screen(
        &mut self,
        serial: u64,
        server: Url,
        page: ScreenDocument,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (states, mut received) = unbounded_channel();
        let listen = cx.spawn(async move |this, cx| {
            while let Some(state) = received.recv().await {
                let heard = this.update(cx, |this, cx| {
                    if let Some(screen) = this.screen_of(serial) {
                        screen.state = Some(state);
                        cx.notify();
                    }
                });
                if heard.is_err() {
                    break;
                }
            }
        });
        // The system web view pumps window messages while it starts, so it is built outside any update.
        let build = cx.spawn_in(window, async move |this, cx| {
            let Ok(Some((parent, bounds, background))) = this.update_in(cx, |_, window, cx| {
                Some((parent_window(window)?, screen_bounds(window.viewport_size()), cx.skin().app))
            }) else {
                return;
            };
            let built = ScreenView::build(parent, &server, &page, bounds, background, states);
            this.update(cx, |this, cx| {
                let Some(screen) = this.screen_of(serial) else { return };
                match built {
                    Ok(view) => {
                        screen.view = Some(Rc::new(view));
                        screen.placed = Some((bounds, true));
                        screen.phase = ScreenPhase::Live;
                    }
                    Err(failure) => {
                        screen.unavailable(match failure {
                            ScreenFailure::NoRuntime => "The screen needs the Microsoft Edge WebView2 Runtime.",
                            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
                            ScreenFailure::Unsupported => "Live screens aren't available on this system yet.",
                            ScreenFailure::Failed => "The screen couldn't open. Try again.",
                        });
                    }
                }
                cx.notify();
            })
            .ok();
        });
        if let Some(screen) = self.screen_of(serial) {
            screen._tasks.extend([listen, build]);
        }
    }

    /// Takes control of the computer, or hands it back, then reloads the screen for the new role.
    fn switch_control(&mut self, take: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(screen) = self.agent_panel.as_mut().and_then(|panel| panel.screen.as_mut()) else { return };
        if screen.busy {
            return;
        }
        screen.busy = true;
        let serial = screen.serial;
        let owner = screen.owner.clone();
        let agent = screen.agent_id.clone();
        let held = screen.lease.as_ref().and_then(|lease| lease.id.clone());
        let work = async move {
            match (take, held) {
                (true, _) => ControlLease::acquire(owner, agent).await.map(Some),
                (false, Some(id)) => owner.0.space(owner.1).release_computer_control(&agent, &id).await.map(|()| None),
                (false, None) => Ok(None),
            }
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            let Some(screen) = this.screen_of(serial) else { return };
            match result {
                Ok(lease) => {
                    if !take {
                        if let Some(previous) = &mut screen.lease {
                            previous.id = None;
                        }
                    }
                    screen.lease = lease;
                    this.load_screen(serial, window, cx);
                }
                Err(error) => {
                    screen.busy = false;
                    if let Some(panel) = this.agent_panel.as_mut() {
                        panel.problem = Some(api::explain(&error));
                    }
                }
            }
        });
        cx.notify();
    }

    /// Keeps the view over the panel's screen area, and out of sight while a menu or dialog
    /// is open, since the system web view draws above the app.
    fn place_screen(&mut self, window: &Window) {
        let covered = self.menu.is_some() || self.dialog.is_some();
        let bounds = screen_bounds(window.viewport_size());
        let Some(screen) = self.agent_panel.as_mut().and_then(|panel| panel.screen.as_mut()) else { return };
        let Some(view) = &screen.view else { return };
        let wanted = (bounds, !covered);
        if screen.placed != Some(wanted) {
            view.place(bounds);
            view.show(!covered);
            screen.placed = Some(wanted);
        }
    }

    pub(super) fn render_screen(
        &mut self,
        name: &str,
        window: &Window,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.place_screen(window);
        let Some(screen) = self.screen() else { return div().into_any_element() };
        let controlled_by_other = matches!(
            self.agent_panel.as_ref().and_then(|panel| panel.computer.as_ref()),
            Some(ComputerView::Ready(status)) if status.controlled_by_other
        );
        let holding = screen.lease.is_some();
        let busy = screen.busy;
        let live = matches!(screen.phase, ScreenPhase::Live);
        let status = match (&screen.phase, screen.state) {
            (ScreenPhase::Opening, _) | (ScreenPhase::Live, None | Some(ScreenState::Loading)) => "Opening…",
            (ScreenPhase::Live, Some(ScreenState::Connecting)) => "Connecting…",
            (ScreenPhase::Live, Some(ScreenState::Connected)) if holding => "You have control",
            (ScreenPhase::Live, Some(ScreenState::Connected)) => "Watching",
            (ScreenPhase::Live, Some(ScreenState::Disconnected)) => "Disconnected",
            (ScreenPhase::Live, Some(ScreenState::Failed)) => "Couldn't connect",
            (ScreenPhase::Unavailable(_), _) => "",
        };
        let unavailable = match &screen.phase {
            ScreenPhase::Unavailable(reason) => Some(reason.clone()),
            _ => None,
        };
        let hover = theme.ink_at(0.04);
        let control = (live && !controlled_by_other).then(|| {
            let label = match (holding, busy) {
                (false, false) => "Take control",
                (false, true) => "Taking control…",
                (true, false) => "Hand back",
                (true, true) => "Handing back…",
            };
            crate::ui::pill_button(
                "screen-control",
                label,
                if holding { crate::ui::Tone::Quiet } else { crate::ui::Tone::Primary },
                !busy,
                theme,
            )
            .h_7()
            .on_click(cx.listener(move |this, _, window, cx| this.switch_control(!holding, window, cx)))
        });
        let toolbar = div()
            .h(SCREEN_TOOLBAR)
            .flex_shrink_0()
            .px_3()
            .flex()
            .items_center()
            .gap_2()
            .border_b_1()
            .border_color(theme.ink_at(0.06))
            .child(
                div()
                    .id("screen-back")
                    .h_7()
                    .px_1()
                    .flex()
                    .items_center()
                    .gap_1()
                    .rounded(radius::FIELD)
                    .body()
                    .text_color(theme.ink_secondary)
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(|this, _, _, cx| this.close_screen(cx)))
                    .child(icon("chevron-left", px(14.), theme.ink_secondary))
                    .child("Computer"),
            )
            .child(div().flex_1().min_w_0().name().text_color(theme.ink).truncate().child(format!("{name}'s screen")))
            .when(!status.is_empty(), |bar| bar.child(div().meta().text_color(theme.ink_tertiary).child(status)))
            .children(control);
        let body = div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_3()
            .px_6()
            .bg(theme.composer)
            .map(|body| match unavailable {
                Some(reason) => body
                    .child(icon("monitor-off", px(28.), theme.ink_tertiary))
                    .child(div().body().text_color(theme.ink_secondary).text_center().child(reason))
                    .child(
                        crate::ui::pill_button("screen-retry", "Try again", crate::ui::Tone::Quiet, true, theme)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.close_screen(cx);
                                this.open_screen(window, cx);
                            })),
                    ),
                None => body.child(Spinner::new().with_size(px(16.)).color(theme.ink_tertiary)),
            });
        div().size_full().flex().flex_col().child(toolbar).child(body).into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use gpui_kit::{point, px, size};
    use url::Url;

    use super::{screen_address, screen_bounds};

    #[tokio::test]
    async fn abandoning_an_acquired_control_lease_releases_that_exact_lease() {
        use serde_json::{json, Value};
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for (route, input, output) in [
                ("takeover", json!({"botId": "bot-a"}), json!({"leaseId": "first-lease"})),
                ("release", json!({"botId": "bot-a", "leaseId":"first-lease"}), json!({"ok": true})),
            ] {
                let mut socket = BufReader::new(listener.accept().await.unwrap().0);
                let mut headers = String::new();
                while !headers.ends_with("\r\n\r\n") {
                    assert_ne!(socket.read_line(&mut headers).await.unwrap(), 0);
                }
                let headers = headers.to_lowercase();
                assert!(headers.starts_with(&format!("post /rpc/computer/{route} ")));
                assert!(headers.contains("x-rakazo-space-id: space-a\r\n"));
                let length = headers.lines().find_map(|line| line.strip_prefix("content-length: ")).unwrap();
                let mut body = vec![0; length.parse().unwrap()];
                socket.read_exact(&mut body).await.unwrap();
                assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), json!({"json":input}));
                let body = json!({"json":output}).to_string();
                let response =
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.get_mut().write_all(response.as_bytes()).await.unwrap();
            }
        });
        let client = superbot_client::Client::new(&origin).unwrap().with_token("test.signature").unwrap();
        let owner = (super::Features::new(client), "space-a".into());
        let granted = super::ControlLease::acquire(owner, "bot-a".into()).await.unwrap();
        drop(granted);
        tokio::time::timeout(super::Duration::from_secs(5), server).await.unwrap().unwrap();
    }

    #[test]
    fn a_screen_loads_from_the_signed_in_server() {
        let server = Url::parse("http://127.0.0.1:5173").unwrap();
        assert_eq!(
            screen_address(&server, "http://localhost:5173/novnc/session/view/9.abc/embed.html?x=1").as_deref(),
            Some("http://127.0.0.1:5173/novnc/session/view/9.abc/embed.html?x=1"),
        );
        for issued in ["desktop://screen?code=1", "http://127.0.0.1:5173/app", "not a url"] {
            assert_eq!(screen_address(&server, issued), None, "{issued}");
        }
    }

    #[test]
    fn the_screen_fills_the_panel_below_its_toolbar() {
        let bounds = screen_bounds(size(px(1280.), px(800.)));
        assert_eq!(bounds.origin, point(px(712.), px(104.)));
        assert_eq!(bounds.size, size(px(568.), px(696.)));
    }
}
