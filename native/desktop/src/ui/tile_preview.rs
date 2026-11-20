use std::time::Duration;

use gpui_kit::*;

use crate::api::AgentSummary;
use crate::app::Desktop;
use crate::theme::{radius, Theme};
use crate::ui::{bot_avatar, Type};

const OPEN_DELAY: Duration = Duration::from_millis(250);
const POP: Duration = Duration::from_millis(200);
const WIDTH: Pixels = px(260.);

/// The pinned tile whose latest line shows beside it, and the rest of the pointer that will open one.
#[derive(Default)]
pub struct TilePreview {
    shown: Option<String>,
    waiting: Option<Task<()>>,
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
        self.tile_preview = TilePreview::default();
    }

    pub fn tile_preview_shown(&self, agent: &str) -> bool {
        self.tile_preview.shown.as_deref() == Some(agent)
    }
}

/// The bot's latest words beside its tile, 8px past its end and 6px below its top: its face and
/// name, then two lines of what it last said. It never takes the pointer.
pub fn tile_preview(agent: &AgentSummary, text: String, tile_width: Pixels, theme: &Theme, cx: &App) -> AnyElement {
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
                .child(bot_avatar(agent.avatar(), px(16.), agent.working(), None, theme, cx))
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
