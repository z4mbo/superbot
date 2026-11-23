pub mod agent_panel;
pub mod app_assist;
pub mod chat;
pub mod chrome;
pub mod corner;
pub mod create_panel;
pub mod creator;
pub mod focus;
pub mod inbox;
pub mod message_search;
pub mod model_menu;
pub mod motion;
pub mod new_menu;
pub mod onboarding;
pub mod overlays;
pub mod releases;
pub mod service_logo;
pub mod sidebar;
pub mod sign_in;
pub mod store;
pub mod tile_preview;
mod tooltip;
pub mod workspace;

use gpui_kit::component::input::{Input, InputState};
#[cfg(target_os = "macos")]
use gpui_kit::component::InteractiveElementExt as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use superbot_avatars::face::{face, FacePaint, FaceState, Pose};
use superbot_avatars::mark::{self, Shape};
use superbot_avatars::{Bot, ChatTone, Face, FaceTiming, Mark, Paint};

use crate::api::{AgentSummary, Target};
use crate::app::Desktop;
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

/// Room for the macOS window buttons, which are hidden in full screen.
pub fn traffic_lights_reserve(_window: &Window) -> Pixels {
    #[cfg(target_os = "macos")]
    if !_window.is_fullscreen() {
        return crate::theme::TRAFFIC_LIGHTS_RESERVE;
    }
    px(0.)
}

/// The app owns macOS title-bar presses, and GPUI's Linux backends ignore caption hit tests.
pub const MANUAL_WINDOW_DRAG: bool = cfg!(any(target_os = "macos", target_os = "linux"));

/// Moves the window from an empty strip.
pub fn drag_region(strip: Div, id: &'static str, window: &mut Window, cx: &mut App) -> Stateful<Div> {
    let strip = strip.id(id);
    if !MANUAL_WINDOW_DRAG {
        return strip.window_control_area(WindowControlArea::Drag);
    }
    let state = window.use_keyed_state(id, cx, |_, _| false);
    let strip = strip
        .on_mouse_down_out(window.listener_for(&state, |should_move, _, _, _| *should_move = false))
        .on_mouse_down(
            MouseButton::Left,
            window.listener_for(&state, |should_move, _, window, cx| {
                *should_move = !window.default_prevented();
                if *should_move {
                    gpui_kit::base::GlobalState::suppress_text_selection(cx);
                }
            }),
        )
        .on_mouse_up(MouseButton::Left, window.listener_for(&state, |should_move, _, _, _| *should_move = false))
        .on_mouse_move(window.listener_for(&state, |should_move, event: &MouseMoveEvent, window, cx| {
            if event.pressed_button != Some(MouseButton::Left) {
                *should_move = false;
            } else if std::mem::take(should_move) {
                gpui_kit::base::TextSelection::end(window, cx);
                cx.stop_active_drag(window);
                window.start_window_move();
            }
        }));
    #[cfg(target_os = "macos")]
    let strip = strip.on_double_click(|_, window, _| window.titlebar_double_click());
    strip
}

/// A full page beside the sidebar. Every page shares one inset and one width, and its top strip
/// moves the window, clear of the caption buttons.
pub fn page(content: impl IntoElement, window: &mut Window, cx: &mut App) -> Div {
    div()
        .size_full()
        .flex()
        .flex_col()
        .child(drag_region(div().h(px(52.)).flex_shrink_0(), "page-drag", window, cx))
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

/// The built-in face used where there is no bot yet.
pub fn agent_face(color: Hsla, size: Pixels, theme: &Theme) -> Div {
    agent_face_with_eyes(color, gpui_kit::white(), size, theme)
}

fn agent_face_with_eyes(body: Hsla, eyes: Hsla, size: Pixels, theme: &Theme) -> Div {
    face(size, FacePaint { body, eyes, dark: theme.is_dark(), shape: Shape::Circle }, Pose::default())
}

/// A bot's avatar in a slot of `size`. The local pack's mark takes precedence.
pub fn bot_avatar(
    bot: Bot,
    size: Pixels,
    working: bool,
    watch: Option<SharedString>,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    bot_avatar_with(bot, size, working, AvatarSlot { watch, ..AvatarSlot::default() }, theme, cx)
}

#[derive(Default)]
pub(crate) struct AvatarSlot {
    pub watch: Option<SharedString>,
    pub empty_chat: bool,
    pub looking_down: bool,
    pub back_of_stack: bool,
    pub presence: FaceState,
    pub blink: Option<SharedString>,
}

pub(crate) fn bot_avatar_with(
    bot: Bot,
    size: Pixels,
    working: bool,
    slot: AvatarSlot,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    if let Some(look) = superbot_avatars::look(bot, cx) {
        let id = SharedString::from(format!("avatar-{}", bot.id));
        let mark = Mark::new(id, look, size, theme.ink).working(working);
        return match slot.watch.filter(|_| !slot.empty_chat) {
            Some(key) => mark.watch(key).into_any_element(),
            None => mark.into_any_element(),
        };
    }
    let region = slot.watch.as_deref().unwrap_or("static");
    let id = SharedString::from(format!("face-{}-{region}-{}", bot.id, f32::from(size)));
    let (_, eyes) = theme.identity_paint(bot.color);
    // Bots wear the shared mark inks; a neutral one is black on light and white on dark.
    let body: Hsla = match mark::ink(bot.picked.color, bot.color) {
        Some(value) => gpui_kit::rgb(value).into(),
        None if theme.is_dark() => gpui_kit::white(),
        None => gpui_kit::black(),
    };
    let shape = Shape::for_bot(bot.id, bot.picked.shape);
    let timing = FaceTiming {
        standard: |progress| motion::STANDARD.sample(progress),
        emphasis: |progress| motion::EMPHASIS.sample(progress),
        settle: motion::SETTLE,
        state: motion::STATE,
        ease_in: motion::EASE_IN,
    };
    Face::new(id, bot.id, size, FacePaint { body, eyes, dark: theme.is_dark(), shape }, timing)
        .state(slot.presence)
        .blink_in(slot.blink)
        .watch(slot.watch)
        .looking_down(slot.looking_down)
        .contact_shadow(!slot.back_of_stack)
        .into_any_element()
}

pub(crate) fn face_state(agent: Option<&AgentSummary>, asleep: bool, working: bool) -> FaceState {
    let failed = agent.is_some_and(|agent| agent.status == "failed");
    let waiting = agent.is_some_and(AgentSummary::waiting_on_you);
    let working = working || agent.is_some_and(AgentSummary::working);
    state_from_signals(asleep, failed, waiting, working)
}

fn state_from_signals(asleep: bool, failed: bool, waiting: bool, working: bool) -> FaceState {
    match (asleep, failed, waiting, working) {
        (true, _, _, _) => FaceState::Asleep,
        (_, true, _, _) => FaceState::Failed,
        (_, _, true, _) => FaceState::Waiting,
        (_, _, _, true) => FaceState::Working,
        _ => FaceState::Rest,
    }
}

impl Desktop {
    pub(crate) fn face_blink_scope(target: &Target) -> Option<SharedString> {
        match target {
            Target::Agent(id) => Some(format!("face-blink:agent:{id}").into()),
            Target::Conversation { thread, .. } => Some(format!("face-blink:thread:{thread}").into()),
            Target::Group(_) => None,
        }
    }

    pub(crate) fn roster_avatar(&self, agent: &AgentSummary, size: Pixels, theme: &Theme, cx: &App) -> AnyElement {
        let presence = face_state(Some(agent), self.avatar_asleep(&agent.id), false);
        bot_avatar_with(agent.avatar(), size, false, AvatarSlot { presence, ..AvatarSlot::default() }, theme, cx)
    }
}

#[cfg(test)]
mod avatar_tests {
    use super::{face_state, state_from_signals};
    use crate::api::AgentSummary;
    use superbot_avatars::face::FaceState;

    #[test]
    fn presence_obeys_precedence() {
        assert_eq!(state_from_signals(true, true, true, true), FaceState::Asleep);
        assert_eq!(state_from_signals(false, true, true, true), FaceState::Failed);
        assert_eq!(state_from_signals(false, false, true, true), FaceState::Waiting);
        assert_eq!(state_from_signals(false, false, false, true), FaceState::Working);
        assert_eq!(state_from_signals(false, false, false, false), FaceState::Rest);
    }

    #[test]
    fn the_face_reads_only_the_existing_roster_signals_and_local_run_input() {
        for (status, thread_status, working, expected) in [
            ("idle", "running", false, FaceState::Working),
            ("running", "waiting_input", true, FaceState::Waiting),
            ("idle", "waiting_takeover", false, FaceState::Waiting),
            ("failed", "idle", false, FaceState::Failed),
            ("idle", "idle", true, FaceState::Working),
            ("idle", "idle", false, FaceState::Rest),
        ] {
            let agent: AgentSummary = serde_json::from_value(serde_json::json!({
                "id": "fixture-bot",
                "name": "Fixture",
                "status": status,
                "threadStatus": thread_status,
            }))
            .unwrap();
            assert_eq!(face_state(Some(&agent), false, working), expected);
        }
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
