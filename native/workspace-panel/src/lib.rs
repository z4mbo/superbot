//! Native management for one Superbot space: its bots, shared groups, people,
//! invites, files, ticket board, routines, approvals and run activity.
//!
//! The host application signs in with `superbot-client` and hands this crate a
//! clone of that [`Client`]. Everything shown is read through
//! `superbot-features`; the server decides what the account may do, and the
//! panel shows a refusal where it happens.
//!
//! # Opening it
//!
//! ```no_run
//! use superbot_workspace_panel::{open, PanelEvent, Section};
//! # fn host(client: superbot_client::Client, cx: &mut gpui_kit::App) -> gpui_kit::Result<()> {
//! // In its own window, on the People section.
//! let panel = open(client, "space-id", Some(Section::People), cx)?;
//! cx.subscribe(&panel, |_, event: &PanelEvent, _| match event {
//!     PanelEvent::OpenBot { bot_id } => println!("show the chat with {bot_id}"),
//!     PanelEvent::SessionExpired => println!("back to sign in"),
//!     _ => {}
//! })
//! .detach();
//! # Ok(())
//! # }
//! ```
//!
//! To place the panel inside a window the host already owns (a page or the
//! side panel), build the view with [`WorkspacePanel::build`] and render the
//! returned entity as a child.
//!
//! Call `gpui_kit::init` before either. The panel follows the host's GPUI Kit
//! theme mode (dark is Midnight, light is Daylight); [`theme::set_skin`] pins
//! it instead.

mod format;
mod icons;
mod panel;
mod remote;
mod sections;
pub mod theme;
mod ui;

use gpui_kit::component::TitleBar;
use gpui_kit::prelude::*;
use gpui_kit::{
    div, px, size, App, Bounds, Entity, Global, SharedString, WeakEntity, Window, WindowBounds,
    WindowHandle, WindowOptions,
};
use superbot_client::Client;

pub use panel::{PanelEvent, Section, WorkspacePanel};

struct OpenPanels(Vec<OpenPanel>);

impl Global for OpenPanels {}

struct OpenPanel {
    server: String,
    space_id: SharedString,
    window: WindowHandle<gpui_kit::base::Root>,
    panel: WeakEntity<WorkspacePanel>,
}

struct PanelWindow {
    panel: Entity<WorkspacePanel>,
}

impl Render for PanelWindow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(t.app)
            .text_color(t.ink)
            .child(TitleBar::new().child(div().text_size(px(13.)).child("Workspace")))
            .child(div().flex_1().min_h_0().child(self.panel.clone()))
    }
}

/// Opens the workspace panel for `space_id` in its own window and returns the
/// panel, so the host can subscribe to its [`PanelEvent`]s.
///
/// `client` is a clone of the host's signed-in client. `initial` chooses the
/// section shown first; `None` shows bots. Calling this again for a space
/// whose window is still open brings that window forward, and moves it to
/// `initial` when one is given, instead of opening a second one.
///
/// The window uses the same title bar as the host (`TitleBar`), so call
/// `gpui_kit::init` first. Network requests run on a Tokio runtime this crate
/// owns (or the one already entered on the calling thread); results are
/// applied on the GUI thread.
pub fn open(
    client: Client,
    space_id: impl Into<SharedString>,
    initial: Option<Section>,
    cx: &mut App,
) -> gpui_kit::Result<Entity<WorkspacePanel>> {
    let space_id = space_id.into();
    let server = client.server().to_owned();

    if !cx.has_global::<OpenPanels>() {
        cx.set_global(OpenPanels(Vec::new()));
    }
    let same_space = |open: &OpenPanel| open.server == server && open.space_id == space_id;
    let existing = cx
        .global::<OpenPanels>()
        .0
        .iter()
        .find(|open| same_space(open))
        .and_then(|open| Some((open.window, open.panel.upgrade()?)));
    if let Some((window, panel)) = existing {
        let brought_forward = window.update(cx, |_, window, cx| {
            window.activate_window();
            if let Some(section) = initial {
                panel.update(cx, |panel, cx| panel.show(section, window, cx));
            }
        });
        if brought_forward.is_ok() {
            return Ok(panel);
        }
    }
    cx.global_mut::<OpenPanels>()
        .0
        .retain(|open| open.panel.upgrade().is_some() && !same_space(open));

    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1040.), px(720.)),
            cx,
        ))),
        window_min_size: Some(size(px(760.), px(520.))),
        ..TitleBar::window_options()
    };
    let mut built = None;
    let (window, _) = gpui_kit::open_window(options, cx, |window, cx| {
        let panel = WorkspacePanel::build(client, space_id.clone(), initial, window, cx);
        built = Some(panel.clone());
        cx.new(|_| PanelWindow { panel })
    })?;
    let panel = built.expect("open_window ran its build closure");
    let window = window
        .downcast::<gpui_kit::base::Root>()
        .expect("gpui_kit::open_window roots every window in a Base Root");

    cx.global_mut::<OpenPanels>().0.push(OpenPanel {
        server,
        space_id,
        window,
        panel: panel.downgrade(),
    });
    Ok(panel)
}
