use std::cell::Cell;
use std::rc::Rc;
use std::time::Instant;

use gpui_kit::base::ElementExt as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::app::{Desktop, Session, View};
use crate::theme::{mix, ActiveTheme, Theme};
use crate::ui::agent_panel::agent_panel_needs_sidebar_space;
#[cfg(not(target_os = "macos"))]
use crate::ui::overlays::caption_buttons;

use crate::ui::focus::{self, Ring};
use crate::ui::motion::{self, Colors, Pointer};
use crate::ui::Type;

/// A segment track paints its indicator behind its buttons, using the measured width of
/// the selected button. Its motion is local to the track, even while the panel is sliding.
pub(crate) struct SegmentTrack {
    selected: Rc<Cell<Option<Bounds<Pixels>>>>,
    motion: Rc<Cell<Option<motion::Tween<(Pixels, Pixels)>>>>,
    fill: Hsla,
    indicator: Hsla,
}

impl SegmentTrack {
    pub(crate) fn new(id: impl Into<ElementId>, theme: &Theme, window: &mut Window, cx: &mut App) -> Self {
        let motion = window.use_keyed_state(id, cx, |_, _| Rc::new(Cell::new(None)));
        Self {
            selected: Rc::default(),
            motion: motion.read(cx).clone(),
            fill: theme.ink_at(0.05),
            indicator: theme.ink_at(0.10),
        }
    }

    pub(crate) fn button(&self, button: Stateful<Div>, chosen: bool) -> Stateful<Div> {
        let selected = self.selected.clone();
        button.when(chosen, |button| button.on_prepaint(move |bounds, _, _| selected.set(Some(bounds))))
    }

    pub(crate) fn control(&self, button: Stateful<Div>, chosen: bool, theme: &Theme) -> focus::FocusControl {
        let fill = Colors::ink(theme, 0., if chosen { 0. } else { 0.04 }, 0.08);
        let track = mix(theme.app, theme.ink, 0.05);
        let selected_press = mix(track, theme.ink, 0.08);
        let label = Colors::new(if chosen { theme.ink } else { theme.ink_secondary }, theme.ink, theme.ink);
        let button = self.button(button, chosen).role(Role::Tab).aria_selected(chosen).font_weight(FontWeight::MEDIUM);
        focus::control(button, Ring::InnerPill, theme).tint(Pointer::BUTTON, move |button, levels| {
            let fill = if chosen { selected_press.opacity(levels.press) } else { fill.sample(levels) };
            button.bg(fill).text_color(label.sample(levels))
        })
    }

    pub(crate) fn element(&self) -> Div {
        let selected = self.selected.clone();
        let tween = self.motion.clone();
        let color = self.indicator;
        let indicator = canvas(
            |_, _, _| (),
            move |track, _, window, cx| {
                let Some(mut bounds) = selected.get() else { return };
                let key = (bounds.left() - track.left(), bounds.size.width);
                let now = Instant::now();
                let mut position = tween.get().unwrap_or_else(|| motion::Tween::at_rest(key, now));
                let span = motion::duration(motion::SLIDE, cx.reduce_motion());
                let interpolate = |(left, width), (next_left, next_width), progress| {
                    (left + (next_left - left) * progress, width + (next_width - width) * progress)
                };
                position.aim(key, now, span, motion::EMPHASIS, interpolate);
                let (left, width) = position.sample(now, motion::EMPHASIS, interpolate);
                tween.set(Some(position));
                if position.moving(now) {
                    window.request_animation_frame();
                }
                bounds.origin.x = track.left() + left;
                bounds.size.width = width;
                window.paint_quad(fill(bounds, color).corner_radii(Corners::all(bounds.size.height / 2.)));
            },
        );
        div().relative().flex().p(px(3.)).rounded_full().bg(self.fill).child(indicator.absolute().inset_0())
    }
}

/// The label and its enclosing row own the click, leaving the switch to draw just its track and knob.
pub(crate) fn switch(on: bool, enabled: bool, theme: &Theme) -> focus::FocusControl {
    let ink = theme.ink;
    let app = theme.app;
    let track = div().id("switch-track").w(px(32.)).h(px(18.)).flex_shrink_0().rounded_full();
    let target = f32::from(on);
    let knob = move |position: f32, tone, pressure| {
        let width = px(14.) + px(2.) * pressure;
        div()
            .absolute()
            .left(px(2.) + (px(28.) - width) * position)
            .top(px(2.))
            .w(width)
            .h(px(14.))
            .rounded_full()
            .bg(tone)
    };
    focus::decorate(track).tint_in(Pointer::BUTTON, move |track, levels, window, cx| {
        let position = motion::value("switch-position", target, motion::SLIDE, motion::EMPHASIS, window, cx);
        let tint = motion::value("switch-color", target, motion::HOVER, motion::STANDARD, window, cx);
        let (hover, press) = if enabled { (levels.hover, levels.press) } else { (0., 0.) };
        let opacity = (0.18 + 0.06 * hover) * (1. - tint) + (1. - 0.14 * hover) * tint;
        track.when(!enabled, |track| track.opacity(0.4)).bg(ink.opacity(opacity)).child(knob(
            position,
            mix(ink, app, tint),
            press,
        ))
    })
}

pub(crate) fn labelled_switch(
    button: Stateful<Div>,
    label: String,
    on: bool,
    enabled: bool,
    theme: &Theme,
) -> AnyElement {
    let button = button
        .min_h(px(32.))
        .px(px(14.))
        .flex()
        .items_center()
        .gap_2()
        .role(Role::Switch)
        .aria_toggled(on.into())
        .child(div().body().child(label))
        .child(switch(on, enabled, theme));
    if enabled {
        focus::control(button.cursor_pointer(), Ring::TrailingSwitch, theme).into_any_element()
    } else {
        focus::decorate(button).into_any_element()
    }
}

impl Desktop {
    pub(super) fn sidebar_hidden(&self, window: &Window) -> bool {
        !self.inbox.open
            && self.view == View::Chat
            && self.agent_panel_reserves_sidebar()
            && agent_panel_needs_sidebar_space(window.viewport_size().width)
    }
}

impl Render for Desktop {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.skin().clone();
        let content = match self.session {
            Session::Restoring => self.render_restoring(window, cx),
            Session::SignedOut => self.render_sign_in(window, cx),
            Session::SignedIn if self.onboarding.page.is_some() => {
                self.render_onboarding(window, cx).unwrap_or_else(|| div().into_any_element())
            }
            Session::SignedIn => {
                let agent_layout = self.agent_panel_layout(window, cx);
                let main = match self.view {
                    View::Chat => self.render_chat(window, cx),
                    View::Store => self.render_store(window, cx),
                    View::Workspace => self.render_workspace(window, cx),
                };
                self.sync_inbox(window, cx);
                let hide_sidebar = self.sidebar_hidden(window);
                let side = match self.render_inbox_panel(window, cx) {
                    Some(inbox) => Some(inbox),
                    None if self.view == View::Chat => agent_layout
                        .and_then(|layout| self.render_agent_panel(layout, window, cx))
                        .or_else(|| self.render_app_assist(window, cx)),
                    None => None,
                };
                div()
                    .size_full()
                    .flex()
                    .children((!hide_sidebar).then(|| self.render_sidebar(window, cx)))
                    .child(div().flex_1().min_w_0().h_full().child(main))
                    .children(side)
                    .into_any_element()
            }
        };
        let frame = div()
            .id("desktop")
            .relative()
            .size_full()
            .bg(theme.app)
            .text_color(theme.ink)
            .font_family(theme.font.clone())
            .text_size(px(13.))
            .line_height(px(18.))
            .child(content);
        #[cfg(not(target_os = "macos"))]
        let frame = frame.child(caption_buttons(window, &theme));
        frame
            .children(self.render_menu(window, cx))
            .children(self.render_dialog(cx))
            .children(self.render_create_panel(cx))
            .children(self.render_version_switch(cx))
            .children(self.render_store_confirm(cx))
            .children(self.render_notice(cx))
    }
}
