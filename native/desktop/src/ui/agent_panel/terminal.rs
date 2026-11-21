use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use superbot_features::ComputerTerminal;
use url::Url;

use super::*;
use crate::control::ControlLease;
use crate::runtime::network;
use crate::terminal::{self as wire, Connection, Event};

/// Control is held while the terminal is open, and renewed this often so it does not lapse.
const CONTROL_HEARTBEAT: Duration = Duration::from_secs(15);
const TOOLBAR: Pixels = px(48.);
const HEADER: Pixels = px(56.);
const FONT_SIZE: Pixels = px(13.);
const LINE: Pixels = px(18.);
const PADDING: Pixels = px(12.);
const SCROLLBACK: usize = 2000;

static TERMINALS: AtomicU64 = AtomicU64::new(0);

enum Phase {
    Opening,
    Live,
    Ended(String),
}

/// An agent's terminal, open in the side panel. Opening it takes control of the computer, as
/// typing into its screen does; dropping it closes the socket and hands control back.
pub(super) struct TerminalSession {
    serial: u64,
    phase: Phase,
    parser: vt100::Parser,
    size: (u16, u16),
    scrolled: usize,
    connection: Option<Connection>,
    lease: Option<ControlLease>,
    focus: FocusHandle,
    _tasks: Vec<Task<()>>,
}

impl TerminalSession {
    fn send(&self, bytes: &[u8]) {
        if let (Phase::Live, Some(connection)) = (&self.phase, &self.connection) {
            connection.send(wire::input_frame(bytes));
        }
    }

    /// Fits the terminal to the space it has, telling the shell when that changes.
    fn fit(&mut self, cols: u16, rows: u16) {
        if self.size == (cols, rows) {
            return;
        }
        self.size = (cols, rows);
        self.parser.screen_mut().set_size(rows, cols);
        if let (Phase::Live, Some(connection)) = (&self.phase, &self.connection) {
            connection.send(wire::resize_frame(cols, rows));
        }
    }
}

/// Where a terminal's socket is, and the origin it is opened from: the signed-in server, whose
/// screen proxy carries both the screen and the terminal.
fn socket_target(server: &str, issued: &ComputerTerminal) -> Result<(Url, String, String), String> {
    let unavailable = || "This computer's terminal can't be shown in the app.".to_owned();
    let server = Url::parse(server).map_err(|_| unavailable())?;
    let address = issued.url.as_deref().ok_or_else(|| "The terminal isn't ready yet. Try again.".to_owned())?;
    let socket = wire::socket_address(&server, address).ok_or_else(unavailable)?;
    let proof = issued.socket_session.clone().ok_or_else(unavailable)?;
    Ok((socket, server.origin().ascii_serialization(), proof))
}

/// A screen the computer cannot show right now (its screens are full, or its display is not
/// ready) still leaves the terminal to answer for itself; anything else ends the opening.
fn screen_problem_leaves_terminal(error: &Error) -> bool {
    matches!(error, Error::Server { status: 409, .. })
}

impl Desktop {
    fn terminal_mut(&mut self) -> Option<&mut TerminalSession> {
        self.agent_panel.as_mut()?.terminal.as_mut()
    }

    /// The terminal session `serial` opened, if it is still the one open: a late answer for a
    /// terminal that was closed or opened again is dropped, along with any control it carries.
    fn terminal_of(&mut self, serial: u64) -> Option<&mut TerminalSession> {
        self.terminal_mut().filter(|terminal| terminal.serial == serial)
    }

    pub(super) fn open_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let Some((server, controls)) =
            self.api.as_ref().map(|api| (api.client.server().to_owned(), api.controls.clone()))
        else {
            return;
        };
        let Some(panel) = self
            .agent_panel
            .as_mut()
            .filter(|panel| panel.width.target() == PANEL_WIDTH)
        else {
            return;
        };
        if panel.terminal.is_some() {
            return;
        }
        let agent_id = panel.agent_id.clone();
        let has_screen = matches!(&panel.computer, Some(ComputerView::Ready(status)) if status.screen_available);
        let serial = TERMINALS.fetch_add(1, Ordering::Relaxed);
        let focus = cx.focus_handle();
        let heartbeat = {
            let (features, space, agent) = (features.clone(), space.clone(), agent_id.clone());
            cx.spawn(async move |this, cx| loop {
                cx.background_executor().timer(CONTROL_HEARTBEAT).await;
                let open = this
                    .update(cx, |this, _| this.terminal_of(serial).is_some_and(|terminal| terminal.lease.is_some()));
                match open {
                    Ok(true) => {
                        let (features, space, agent) = (features.clone(), space.clone(), agent.clone());
                        let _ = network(async move { features.space(space).computer_heartbeat(&agent).await }).await;
                    }
                    Ok(false) => {}
                    Err(_) => break,
                }
            })
        };
        panel.screen = None;
        panel.terminal = Some(TerminalSession {
            serial,
            phase: Phase::Opening,
            parser: vt100::Parser::new(24, 80, SCROLLBACK),
            size: (80, 24),
            scrolled: 0,
            connection: None,
            lease: None,
            focus: focus.clone(),
            _tasks: vec![heartbeat],
        });
        window.focus(&focus, cx);
        let taking = ControlLease::acquire(&controls, (features.clone(), space.clone()), agent_id.clone());
        let read = agent_id.clone();
        let work = async move {
            let lease = taking.await?;
            let space = features.space(space);
            // The computer learns of a control lease only from an interactive screen, and its
            // terminal starts only for the lease it knows.
            if has_screen {
                if let Err(error) = space.computer_screen(&read).await {
                    if !screen_problem_leaves_terminal(&error) {
                        return Err(error);
                    }
                }
            }
            let issued = space.computer_terminal(&read).await?;
            Ok((lease, issued))
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            let Some(terminal) = this.terminal_of(serial) else { return };
            let (lease, issued) = match result {
                Ok(opened) => opened,
                Err(error) => {
                    terminal.phase = Phase::Ended(api::explain(&error));
                    return;
                }
            };
            match socket_target(&server, &issued) {
                Ok((socket, origin, proof)) => {
                    terminal.lease = Some(lease);
                    this.connect_terminal(serial, socket, origin, proof, window, cx);
                }
                Err(reason) => terminal.phase = Phase::Ended(reason),
            }
        });
        cx.notify();
    }

    fn connect_terminal(
        &mut self,
        serial: u64,
        socket: Url,
        origin: String,
        proof: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (connection, mut events) = wire::connect(socket, origin, proof);
        let listen = cx.spawn_in(window, async move |this, cx| {
            while let Some(event) = events.recv().await {
                let heard = this.update(cx, |this, cx| {
                    let Some(terminal) = this.terminal_of(serial) else { return };
                    match event {
                        Event::Opened => {
                            terminal.phase = Phase::Live;
                            if let Some(connection) = &terminal.connection {
                                connection.send(wire::resize_frame(terminal.size.0, terminal.size.1));
                            }
                        }
                        Event::Output(bytes) => {
                            terminal.parser.process(&bytes);
                            terminal.scrolled = 0;
                            terminal.parser.screen_mut().set_scrollback(0);
                        }
                        Event::Closed(reason) => {
                            terminal.connection = None;
                            terminal.lease = None;
                            terminal.phase = Phase::Ended(reason.unwrap_or_else(|| "The terminal closed.".to_owned()));
                        }
                    }
                    cx.notify();
                });
                if heard.is_err() {
                    break;
                }
            }
        });
        if let Some(terminal) = self.terminal_of(serial) {
            terminal.connection = Some(connection);
            terminal._tasks.push(listen);
        }
    }

    pub(super) fn close_terminal(&mut self, cx: &mut Context<Self>) {
        if let Some(panel) = self.agent_panel.as_mut() {
            if panel.terminal.take().is_some() {
                panel.computer = None;
                cx.notify();
            }
        }
    }

    fn reopen_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = self.agent_panel.as_mut() {
            panel.terminal = None;
        }
        self.open_terminal(window, cx);
    }

    fn type_into_terminal(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;
        let modifiers = &keystroke.modifiers;
        let Some(terminal) = self.terminal_mut() else { return };
        if modifiers.control && modifiers.shift && keystroke.key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                terminal.send(text.as_bytes());
            }
            cx.stop_propagation();
            return;
        }
        if modifiers.platform {
            return;
        }
        if let Some(bytes) =
            wire::key_bytes(&keystroke.key, keystroke.key_char.as_deref(), modifiers.control, modifiers.alt)
        {
            terminal.send(&bytes);
            cx.stop_propagation();
        }
    }

    fn scroll_terminal(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        let Some(terminal) = self.terminal_mut() else { return };
        let lines = (f32::from(event.delta.pixel_delta(LINE).y) / f32::from(LINE)).round() as isize;
        let wanted = (terminal.scrolled as isize + lines).clamp(0, SCROLLBACK as isize) as usize;
        terminal.parser.screen_mut().set_scrollback(wanted);
        terminal.scrolled = terminal.parser.screen().scrollback();
        cx.notify();
    }

    pub(super) fn render_terminal(
        &mut self,
        name: &str,
        window: &mut Window,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let font_id = window.text_system().resolve_font(&font(theme.mono.clone()));
        let advance = window.text_system().advance(font_id, FONT_SIZE, 'm').map(|size| size.width).unwrap_or(px(7.8));
        let viewport = window.viewport_size();
        let width = panel_width(viewport.width) - px(1.) - PADDING * 2.;
        let height = viewport.height - HEADER - TOOLBAR - PADDING * 2.;
        let cols = (f32::from(width) / f32::from(advance)).floor().clamp(20., 500.) as u16;
        let rows = (f32::from(height) / f32::from(LINE)).floor().clamp(5., 200.) as u16;
        let focused = self
            .agent_panel
            .as_ref()
            .and_then(|panel| panel.terminal.as_ref())
            .is_some_and(|terminal| terminal.focus.is_focused(window));
        let Some(terminal) = self.terminal_mut() else { return div().into_any_element() };
        terminal.fit(cols, rows);
        let status = match &terminal.phase {
            Phase::Opening => Some("Opening…".to_owned()),
            Phase::Live if terminal.scrolled > 0 => Some("Scrolled back".to_owned()),
            Phase::Live => None,
            Phase::Ended(_) => None,
        };
        let ended = match &terminal.phase {
            Phase::Ended(reason) => Some(reason.clone()),
            _ => None,
        };
        let live = matches!(terminal.phase, Phase::Live);
        let focus = terminal.focus.clone();
        let lines = grid(terminal.parser.screen(), live && focused && terminal.scrolled == 0, theme);
        let hover = theme.ink_at(0.04);
        let toolbar = div()
            .h(TOOLBAR)
            .flex_shrink_0()
            .px_3()
            .flex()
            .items_center()
            .gap_2()
            .border_b_1()
            .border_color(theme.ink_at(0.06))
            .child(
                div()
                    .id("terminal-back")
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
                    .on_click(cx.listener(|this, _, _, cx| this.close_terminal(cx)))
                    .child(icon("chevron-left", px(14.), theme.ink_secondary))
                    .child("Computer"),
            )
            .child(div().flex_1().min_w_0().name().text_color(theme.ink).truncate().child(format!("{name}'s terminal")))
            .children(status.map(|status| div().meta().text_color(theme.ink_tertiary).child(status)));
        let body = div()
            .id("agent-terminal")
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .p(PADDING)
            .bg(theme.composer)
            .font_family(theme.mono.clone())
            .text_size(FONT_SIZE)
            .line_height(LINE)
            .text_color(theme.ink)
            .track_focus(&focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| this.type_into_terminal(event, cx)))
            .on_scroll(cx.listener(|this, event: &ScrollEvent, _, cx| this.scroll_terminal(event, cx)))
            .on_mouse_down(MouseButton::Left, move |_, window, cx| window.focus(&focus, cx))
            .children(lines)
            .children(ended.map(|reason| {
                div()
                    .absolute()
                    .bottom(px(12.))
                    .left(px(12.))
                    .right(px(12.))
                    .flex()
                    .items_center()
                    .gap_3()
                    .px_3()
                    .py_2()
                    .rounded(radius::CARD)
                    .bg(theme.panel)
                    .border_1()
                    .border_color(theme.ink_at(0.1))
                    .font_family(theme.font.clone())
                    .child(div().flex_1().body().text_color(theme.ink_secondary).child(reason))
                    .child(
                        crate::ui::pill_button("terminal-retry", "Open again", crate::ui::Tone::Quiet, true, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.reopen_terminal(window, cx))),
                    )
            }));
        div().size_full().flex().flex_col().child(toolbar).child(body).into_any_element()
    }
}

/// The screen's rows as divs, each a run of cells that share a look.
fn grid(screen: &vt100::Screen, cursor: bool, theme: &Theme) -> Vec<Div> {
    runs(screen, cursor)
        .into_iter()
        .map(|row| {
            div()
                .h(LINE)
                .flex()
                .whitespace_nowrap()
                .children(row.into_iter().map(|(text, look)| look.span(text, theme)))
        })
        .collect()
}

/// Each row of the screen as runs of text that share a look; the cursor shows as inverse.
fn runs(screen: &vt100::Screen, cursor: bool) -> Vec<Vec<(String, Look)>> {
    let (rows, cols) = screen.size();
    let (cursor_row, cursor_col) = screen.cursor_position();
    let cursor = cursor && !screen.hide_cursor();
    (0..rows)
        .map(|row| {
            let mut runs: Vec<(String, Look)> = Vec::new();
            for col in 0..cols {
                let Some(cell) = screen.cell(row, col) else { continue };
                if cell.is_wide_continuation() {
                    continue;
                }
                let text = if cell.has_contents() { cell.contents() } else { " " };
                let look = Look {
                    fg: cell.fgcolor(),
                    bg: cell.bgcolor(),
                    bold: cell.bold(),
                    inverse: cell.inverse() != (cursor && row == cursor_row && col == cursor_col),
                };
                match runs.last_mut() {
                    Some((run, last)) if *last == look => run.push_str(text),
                    _ => runs.push((text.to_owned(), look)),
                }
            }
            runs
        })
        .collect()
}

#[derive(Clone, Copy, PartialEq)]
struct Look {
    fg: vt100::Color,
    bg: vt100::Color,
    bold: bool,
    inverse: bool,
}

impl Look {
    fn span(self, text: String, theme: &Theme) -> Div {
        let fg = color(self.fg).unwrap_or(theme.ink);
        let bg = color(self.bg);
        let (fg, bg) = if self.inverse { (bg.unwrap_or(theme.composer), Some(fg)) } else { (fg, bg) };
        div()
            .flex_shrink_0()
            .text_color(fg)
            .when_some(bg, |span, bg| span.bg(bg))
            .when(self.bold, |span| span.font_weight(FontWeight::BOLD))
            .child(text)
    }
}

/// The xterm palette for indexed colours; `None` keeps the theme's own ink or background.
fn color(color: vt100::Color) -> Option<Hsla> {
    const BASE: [u32; 16] = [
        0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666, 0xf14c4c, 0x23d18b,
        0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
    ];
    let value = match color {
        vt100::Color::Default => return None,
        vt100::Color::Rgb(r, g, b) => (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b),
        vt100::Color::Idx(index) if index < 16 => BASE[usize::from(index)],
        vt100::Color::Idx(index) if index >= 232 => {
            let level = 8 + 10 * u32::from(index - 232);
            (level << 16) | (level << 8) | level
        }
        vt100::Color::Idx(index) => {
            let cube = u32::from(index - 16);
            let level = |step: u32| if step == 0 { 0 } else { 55 + step * 40 };
            (level(cube / 36) << 16) | (level(cube / 6 % 6) << 8) | level(cube % 6)
        }
    };
    Some(rgb(value).into())
}

#[cfg(test)]
mod tests {
    use superbot_features::ComputerTerminal;

    use super::{color, runs, screen_problem_leaves_terminal, socket_target};

    #[test]
    fn a_terminal_opens_only_with_its_proof_on_the_signed_in_server() {
        let issued = |url: Option<&str>, proof: Option<&str>| ComputerTerminal {
            url: url.map(str::to_owned),
            socket_session: proof.map(str::to_owned),
        };
        let address = "http://127.0.0.1:5173/novnc/session/control/1900000000.AbC/vnc.html";
        let (socket, origin, proof) =
            socket_target("http://127.0.0.1:5173", &issued(Some(address), Some("p"))).unwrap();
        assert_eq!(socket.as_str(), "ws://127.0.0.1:5173/novnc/session/control/1900000000.AbC/websockify");
        assert_eq!((origin.as_str(), proof.as_str()), ("http://127.0.0.1:5173", "p"));
        assert!(socket_target("http://127.0.0.1:5173", &issued(Some(address), None)).is_err());
        assert!(socket_target("http://127.0.0.1:5173", &issued(None, Some("p"))).is_err());
    }

    #[test]
    fn output_is_drawn_as_runs_that_share_a_look() {
        let mut parser = vt100::Parser::new(2, 12, 0);
        parser.process(b"\x1b[31mred\x1b[0m ok");
        let rows = runs(parser.screen(), true);
        assert_eq!(rows.len(), 2);
        let first = &rows[0];
        assert_eq!(first[0].0, "red");
        assert_eq!(first[0].1.fg, vt100::Color::Idx(1));
        assert_eq!(first[1].0, " ok");
        assert!(first.iter().any(|(text, look)| look.inverse && text == " "));
        let hidden = runs(parser.screen(), false);
        assert!(hidden[0].iter().all(|(_, look)| !look.inverse));
    }

    #[test]
    fn only_an_unavailable_screen_still_opens_the_terminal() {
        let server = |status: u16| superbot_features::Error::Server { status, code: None, message: "fixture".into() };
        assert!(screen_problem_leaves_terminal(&server(409)));
        for status in [401, 403, 404, 500] {
            assert!(!screen_problem_leaves_terminal(&server(status)), "{status}");
        }
        assert!(!screen_problem_leaves_terminal(&superbot_features::Error::Protocol("fixture")));
    }

    #[test]
    fn indexed_colours_follow_the_xterm_palette() {
        assert!(color(vt100::Color::Default).is_none());
        assert_eq!(color(vt100::Color::Idx(1)), Some(gpui_kit::rgb(0xcd3131).into()));
        assert_eq!(color(vt100::Color::Idx(16)), Some(gpui_kit::rgb(0x000000).into()));
        assert_eq!(color(vt100::Color::Idx(231)), Some(gpui_kit::rgb(0xffffff).into()));
        assert_eq!(color(vt100::Color::Idx(255)), Some(gpui_kit::rgb(0xeeeeee).into()));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod close_tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn closing_detaches_the_terminal_immediately_and_reversing_does_not_reopen_it() {
        crate::test_support::headless(|cx| {
            let at = Instant::now();
            let mut panel = AgentPanel::new("bot-a".into(), PanelTab::Computer, Tween::at_rest(PANEL_WIDTH, at));
            panel.terminal = Some(TerminalSession {
                serial: 1,
                phase: Phase::Live,
                parser: vt100::Parser::new(24, 80, SCROLLBACK),
                size: (24, 80),
                scrolled: 0,
                connection: None,
                lease: None,
                focus: cx.focus_handle(),
                _tasks: vec![],
            });
            panel.close(at, false);
            assert!(panel.terminal.is_none());
            assert!(panel.width.moving(at));
            transition::aim(&mut panel.width, true, at + Duration::from_millis(50), false);
            assert!(panel.terminal.is_none());
        });
    }
}
