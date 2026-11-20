pub mod agent_panel;
pub mod app_assist;
pub mod chat;
pub mod chrome;
pub mod corner;
pub mod create_panel;
pub mod creator;
pub mod inbox;
pub mod message_search;
pub mod model_menu;
pub mod new_menu;
pub mod overlays;
pub mod releases;
pub mod service_logo;
pub mod sidebar;
pub mod sign_in;
pub mod store;
pub mod tile_preview;
pub mod workspace;

use gpui_kit::component::input::{Input, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use superbot_avatars::{Bot, ChatTone, Mark, Paint};

use crate::theme::{radius, Theme};

pub fn icon(name: &str, size: Pixels, color: Hsla) -> Svg {
    svg().path(SharedString::from(format!("icons/{name}.svg"))).size(size).flex_shrink_0().text_color(color)
}

/// The type table: one call per row, so no view invents a size.
pub trait Type: Styled + Sized {
    fn title(self) -> Self {
        self.text_size(px(20.)).line_height(px(28.)).font_weight(FontWeight::SEMIBOLD)
    }
    fn page_title(self) -> Self {
        self.text_size(px(26.)).line_height(px(32.)).font_weight(FontWeight::SEMIBOLD)
    }
    fn section(self) -> Self {
        self.text_size(px(17.)).line_height(px(24.)).font_weight(FontWeight::SEMIBOLD)
    }
    fn bubble(self) -> Self {
        self.text_size(px(15.)).line_height(px(22.))
    }
    fn item(self) -> Self {
        self.text_size(px(14.)).line_height(px(20.))
    }
    fn name(self) -> Self {
        self.text_size(px(14.)).line_height(px(20.)).font_weight(FontWeight::MEDIUM)
    }
    fn body(self) -> Self {
        self.text_size(px(13.)).line_height(px(18.))
    }
    fn meta(self) -> Self {
        self.text_size(px(12.)).line_height(px(16.))
    }
}

impl<T: Styled + Sized> Type for T {}

/// A full page beside the sidebar. Every page shares one inset and one width, and its top strip
/// moves the window, clear of the caption buttons.
pub fn page(content: impl IntoElement) -> Div {
    div()
        .size_full()
        .flex()
        .flex_col()
        .child(div().h(px(52.)).flex_shrink_0().window_control_area(WindowControlArea::Drag))
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .justify_center()
                .px_8()
                .child(div().size_full().max_w(px(960.)).flex().flex_col().child(content)),
        )
}

/// A bot's face: its colour, two eyes. The only mark in the app that gets a plate.
pub fn agent_face(color: Hsla, size: Pixels) -> Div {
    let eye = size * 0.14;
    div()
        .size(size)
        .flex_shrink_0()
        .rounded_full()
        .bg(color)
        .flex()
        .items_center()
        .justify_center()
        .gap(size * 0.16)
        .pb(size * 0.06)
        .children((0..2).map(|_| div().w(eye).h(eye * 1.5).rounded_full().bg(gpui_kit::white())))
}

/// A bot's avatar in a slot of `size`: the local avatar pack's mark when one is installed,
/// otherwise [`agent_face`]. `watch` names the mark for a region made with `watch_region`.
pub fn bot_avatar(
    bot: Bot,
    size: Pixels,
    working: bool,
    watch: Option<SharedString>,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    match superbot_avatars::look(bot, cx) {
        Some(look) => {
            let id = SharedString::from(format!("avatar-{}", bot.id));
            let mark = Mark::new(id, look, size, theme.ink).working(working);
            match watch {
                Some(key) => mark.watch(key).into_any_element(),
                None => mark.into_any_element(),
            }
        }
        None => agent_face(theme.identity_for(bot.color), size).into_any_element(),
    }
}

/// The colour that stands for this bot in text: its mark's colour when the avatar pack draws it.
pub fn bot_ink(bot: Bot, theme: &Theme, cx: &App) -> Hsla {
    match superbot_avatars::look(bot, cx).map(|look| look.paint) {
        Some(Paint::Color(color)) => color,
        Some(Paint::Gradient(stops)) => stops[stops.len() / 2],
        Some(Paint::Ink) => theme.ink,
        None => theme.identity_for(bot.color),
    }
}

/// The colours of a chat with this bot, when the avatar pack recolours chats.
pub fn chat_tone(bot: Bot, theme: &Theme, cx: &App) -> Option<ChatTone> {
    superbot_avatars::chat_tone(&superbot_avatars::look(bot, cx)?, theme.is_dark(), cx)
}

pub fn initials(name: &str) -> String {
    let mut letters =
        name.split_whitespace().filter_map(|word| word.chars().next()).filter(|letter| letter.is_alphanumeric());
    let first = letters.next();
    let last = letters.last();
    first.into_iter().chain(last).flat_map(char::to_uppercase).collect()
}

pub fn person_face(name: &str, size: Pixels, theme: &Theme) -> Div {
    div()
        .size(size)
        .flex_shrink_0()
        .rounded_full()
        .bg(theme.ink_at(0.08))
        .border_1()
        .border_color(theme.ink_at(0.06))
        .flex()
        .items_center()
        .justify_center()
        .text_size(size * 0.38)
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.ink)
        .child(initials(name))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    /// The one primary action of a view: a neutral ink pill.
    Primary,
    Quiet,
    Danger,
}

pub fn pill_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    tone: Tone,
    enabled: bool,
    theme: &Theme,
) -> Stateful<Div> {
    let (fill, ink, hover) = match tone {
        Tone::Primary => (theme.ink, theme.app, theme.ink_at(0.86)),
        Tone::Quiet => (theme.control, theme.ink, theme.raised_hover),
        Tone::Danger => (theme.control, theme.danger, theme.raised_hover),
    };
    div()
        .id(id)
        .h_8()
        .px_3p5()
        .flex_shrink_0()
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .gap_1p5()
        .body()
        .font_weight(FontWeight::MEDIUM)
        .bg(fill)
        .text_color(ink)
        .when(enabled, |pill| pill.cursor_pointer().hover(move |style| style.bg(hover)))
        .when(!enabled, |pill| pill.opacity(0.5))
        .child(label.into())
}

/// A filter chip: ink when chosen, quiet otherwise.
pub fn chip(id: impl Into<ElementId>, label: impl Into<SharedString>, chosen: bool, theme: &Theme) -> Stateful<Div> {
    let hover = theme.raised_hover;
    div()
        .id(id)
        .h_8()
        .px_3p5()
        .flex_shrink_0()
        .rounded_full()
        .flex()
        .items_center()
        .body()
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer()
        .map(|chip| {
            if chosen {
                chip.bg(theme.ink).text_color(theme.app)
            } else {
                chip.bg(theme.control.opacity(0.7)).text_color(theme.ink).hover(move |style| style.bg(hover))
            }
        })
        .child(label.into())
}

/// A labelled text field. The label is always visible; a placeholder is never the label.
pub fn field(label: &'static str, state: &Entity<InputState>, theme: &Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .gap_1p5()
        .child(div().meta().font_weight(FontWeight::MEDIUM).text_color(theme.ink_tertiary).child(label))
        .child(field_box(theme).child(Input::new(state).appearance(false).bordered(false)))
}

pub fn field_box(theme: &Theme) -> Div {
    div()
        .min_h_9()
        .px_2()
        .flex()
        .items_center()
        .rounded(radius::FIELD)
        .bg(theme.inset)
        .border_1()
        .border_color(theme.hairline.opacity(0.5))
}

/// An inline error: next to what failed, with what to do next already in its words.
pub fn error_line(text: impl Into<SharedString>, theme: &Theme) -> Div {
    div()
        .flex()
        .items_start()
        .gap_2()
        .px_3()
        .py_2()
        .rounded(radius::CARD)
        .bg(theme.danger.opacity(0.1))
        .body()
        .text_color(theme.danger)
        .child(icon("circle-alert", px(14.), theme.danger).mt(px(2.)))
        .child(div().flex_1().min_w_0().child(text.into()))
}

pub fn empty_line(text: impl Into<SharedString>, theme: &Theme) -> Div {
    div().body().text_color(theme.ink_tertiary).child(text.into())
}
