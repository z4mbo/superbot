use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::*;

use crate::api::{AgentSummary, Target};
use crate::app::{Desktop, MenuKind};
use crate::theme::{radius, Theme};
use crate::ui::{bot_avatar_with, AvatarSlot, Type};
use superbot_avatars::face::FaceState;

const OPEN_DELAY: Duration = Duration::from_millis(250);
const POP: Duration = Duration::from_millis(200);
const WIDTH: Pixels = px(260.);

/// The pinned tile whose latest line shows beside it, the rest of the pointer that will open one,
/// and each tile's place in the keyboard order and on screen.
#[derive(Default)]
pub struct TilePreview {
    shown: Option<String>,
    waiting: Option<Task<()>>,
    focus: HashMap<String, FocusHandle>,
    bounds: HashMap<String, Rc<Cell<Bounds<Pixels>>>>,
}

impl Desktop {
    /// The pointer came to rest on, or left, a pinned tile. A tile with nothing to quote opens nothing.
    pub fn hover_tile(&mut self, agent: &str, hovered: bool, quotable: bool, cx: &mut Context<Self>) {
        self.close_tile_preview(cx);
        if !hovered || !quotable {
            return;
        }
        let agent = agent.to_owned();
        self.tile_preview.waiting = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(OPEN_DELAY).await;
            this.update(cx, |this, cx| {
                this.tile_preview.waiting = None;
                this.tile_preview.shown = Some(agent);
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn close_tile_preview(&mut self, cx: &mut Context<Self>) {
        self.tile_preview.waiting = None;
        if self.tile_preview.shown.take().is_some() {
            cx.notify();
        }
    }

    /// Drops a preview whose tile is no longer drawn, without asking for another frame.
    pub fn forget_tile_preview(&mut self) {
        self.tile_preview.waiting = None;
        self.tile_preview.shown = None;
    }

    /// The tile's stop in the Tab order. It lasts as long as the window, so focus survives redraws.
    pub fn tile_focus(&mut self, agent: &str, cx: &mut Context<Self>) -> FocusHandle {
        self.tile_preview.focus.entry(agent.to_owned()).or_insert_with(|| cx.focus_handle().tab_stop(true)).clone()
    }

    /// Where the tile was last drawn, filled in as it is laid out.
    pub fn tile_bounds(&mut self, agent: &str) -> Rc<Cell<Bounds<Pixels>>> {
        self.tile_preview.bounds.entry(agent.to_owned()).or_default().clone()
    }

    /// Enter or Space opens the bot; the menu key or Shift+F10 opens its actions at the tile's
    /// centre. Returns whether the key was the tile's.
    pub fn tile_key(&mut self, agent: &str, key: &Keystroke, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(command) = TileKey::of(key) else { return false };
        self.close_tile_preview(cx);
        match command {
            TileKey::Open => self.open(Target::Agent(agent.to_owned()), window, cx),
            TileKey::Menu => {
                let at = self.tile_bounds(agent).get().center();
                self.open_menu(MenuKind::Agent(agent.to_owned()), at, cx);
            }
        }
        true
    }

    pub fn tile_preview_shown(&self, agent: &str) -> bool {
        self.tile_preview.shown.as_deref() == Some(agent)
    }
}

#[derive(Debug, PartialEq)]
enum TileKey {
    Open,
    Menu,
}

pub(super) fn is_menu_key(key: &Keystroke) -> bool {
    TileKey::of(key) == Some(TileKey::Menu)
}

impl TileKey {
    fn of(key: &Keystroke) -> Option<Self> {
        match (key.key.as_str(), key.modifiers) {
            ("enter" | "space", modifiers) if !modifiers.modified() => Some(Self::Open),
            ("menu", _) => Some(Self::Menu),
            ("f10", modifiers) if modifiers.shift && !modifiers.control && !modifiers.alt => Some(Self::Menu),
            _ => None,
        }
    }
}

/// The bot's latest words beside its tile, 8px past its end and 6px below its top: its face and
/// name, then two lines of what it last said. It never takes the pointer.
pub fn tile_preview(
    agent: &AgentSummary,
    text: String,
    tile_width: Pixels,
    presence: FaceState,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let slot = AvatarSlot { presence, ..AvatarSlot::default() };
    let card = div()
        .w(WIDTH)
        .px(px(11.))
        .py(px(9.))
        .rounded(radius::CARD)
        .bg(theme.composer)
        .border_1()
        .border_color(theme.ink_at(0.1))
        .child(
            div()
                .flex()
                .min_w_0()
                .items_center()
                .gap_1p5()
                .child(bot_avatar_with(agent.avatar(), px(16.), agent.working(), slot, theme, cx))
                .child(div().min_w_0().name().font_weight(FontWeight::SEMIBOLD).truncate().child(agent.name.clone())),
        )
        .child(div().mt_1().body().text_color(theme.ink_secondary).line_clamp(2).child(text));
    let card = if cx.reduce_motion() {
        card.into_any_element()
    } else {
        // easeOutQuint is the reference curve, cubic-bezier(0.22, 1, 0.36, 1).
        card.with_animation(
            SharedString::from(format!("tile-preview-{}", agent.id)),
            Animation::new(POP).with_easing(ease_out_quint()),
            |card, delta| card.opacity(delta).mt(px(6.) * (1. - delta)),
        )
        .into_any_element()
    };
    deferred(
        anchored()
            .position_mode(AnchoredPositionMode::Local)
            .position(point(tile_width + px(8.), px(6.)))
            .snap_to_window_with_margin(px(8.))
            .child(card),
    )
    .with_priority(1)
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use gpui_kit::Keystroke;

    use super::TileKey;

    #[test]
    fn tile_keys_follow_the_simple_sidebar() {
        fn of(key: &'static str) -> Option<TileKey> {
            TileKey::of(&Keystroke::parse(key).unwrap())
        }
        assert_eq!(of("enter"), Some(TileKey::Open));
        assert_eq!(of("space"), Some(TileKey::Open));
        assert_eq!(of("menu"), Some(TileKey::Menu));
        assert_eq!(of("shift-f10"), Some(TileKey::Menu));
        for other in ["f10", "shift-enter", "ctrl-space", "tab", "shift-tab", "escape", "a"] {
            assert_eq!(of(other), None, "{other}");
        }
    }
}
