use std::time::Instant;

use chrono::Local;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::text::TextView;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::{AgentSummary, GroupMember, Target};
use crate::app::conversation::MentionList;
use crate::app::{Desktop, View};
use crate::clock;
use crate::outbox;
use crate::theme::{radius, ActiveTheme, Theme, BUBBLE_MAX, CAPTION_WIDTH, CHAT_COLUMN};
use crate::transcript::{place, Entry, Join, Part, Place, Speaker};
use superbot_avatars::{Bot, ChatTone, Mark};

use crate::ui::focus::{self, Ring};
use crate::ui::motion::{self, Colors, Pointer};
use crate::ui::tooltip;
#[cfg(target_os = "macos")]
use crate::ui::traffic_lights_reserve;
use crate::ui::{
    bot_avatar_with, bot_ink, chat_tone, drag_region, error_line, face_state, icon, pill_button, AvatarSlot, Tone, Type,
};

mod composer;
mod file;
mod transitions;
pub(crate) use transitions::ChatMotion;

const HEADER_HEIGHT: Pixels = px(61.);

fn transcript_fade(color: Hsla, height: Pixels, top_alpha: f32, bottom_alpha: f32) -> Div {
    div().absolute().left_0().right_0().h(height).bg(linear_gradient(
        180.,
        linear_color_stop(color.opacity(top_alpha), 0.),
        linear_color_stop(color.opacity(bottom_alpha), 1.),
    ))
}

fn model_label_opacity(key: (Target, String), window: &mut Window, cx: &mut App) -> f32 {
    let now = Instant::now();
    let state = window.use_keyed_state("header-model-label", cx, |_, _| (key.clone(), motion::Tween::at_rest(1., now)));
    let reduced_motion = cx.reduce_motion();
    state.update(cx, |state, _| {
        let (opacity, moving) = model_label_frame(state, key, now, reduced_motion);
        if moving {
            window.request_animation_frame();
        }
        opacity
    })
}

fn model_label_frame(
    (previous, alpha): &mut ((Target, String), motion::Tween<f32>),
    key: (Target, String),
    now: Instant,
    reduced_motion: bool,
) -> (f32, bool) {
    let span = motion::duration(motion::FADE, reduced_motion);
    let interpolate = |from, to, progress| from + (to - from) * progress;
    if previous.0 == key.0 && previous.1 != key.1 {
        *alpha = motion::Tween::at_rest(0.4, now);
    } else if previous.0 != key.0 {
        *alpha = motion::Tween::at_rest(1., now);
    }
    *previous = key;
    alpha.aim(1., now, span, motion::STANDARD, interpolate);
    (alpha.sample(now, motion::STANDARD, interpolate), alpha.moving(now))
}

#[cfg(test)]
mod header_motion_tests {
    use super::{model_label_frame, motion, Instant, Target};

    #[test]
    fn reduced_motion_shows_a_changed_model_label_at_full_opacity() {
        let now = Instant::now();
        let agent = Target::Agent("fixture".into());
        let mut state = ((agent.clone(), "Before".into()), motion::Tween::at_rest(1., now));
        let next = (agent, "After".into());
        assert_eq!(model_label_frame(&mut state, next.clone(), now, false), (0.4, true));
        assert_eq!(model_label_frame(&mut state, next, now + motion::FADE / 2, true), (1., false));
    }
}

/// The chat capsule's lift, as the reference draws it: a soft drop in light and none in dark, where
/// a shadow on the dark window only reads as a smudge around the pill.
fn capsule_shadow(theme: &Theme) -> Vec<BoxShadow> {
    if theme.is_dark() {
        return Vec::new();
    }
    // GPUI (gpui-pre 0.3.12) takes `blur_radius` as the Gaussian sigma; CSS blur is twice it.
    let shadow = |color: u32, y: f32, blur: f32, spread: f32| BoxShadow {
        color: rgba(color).into(),
        offset: point(px(0.), px(y)),
        blur_radius: px(blur / 2.),
        spread_radius: px(spread),
        inset: false,
    };
    vec![shadow(0x1a1a1a14, 4., 12., -1.), shadow(0x2222220f, 2., 4., -2.)]
}

impl Desktop {
    pub(super) fn render_chat(
        &mut self,
        panel_width: Pixels,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.prepare_cards(window, cx);
        self.sync_agent_info(window, cx);
        self.sync_app_assist(window, cx);
        let theme = cx.skin().clone();
        let has_pending_local = self.pending_local_write().is_some();
        let Some(chat) = self.chat.as_mut() else {
            return self.render_no_conversation(&theme, window, cx);
        };
        let target = chat.target.clone();
        let active = chat.working || chat.local_turn.is_some();
        let quiet = chat.entries.is_empty()
            && chat.draft.is_empty()
            && !active
            && !has_pending_local
            && chat.local_prompt.is_none()
            && !chat.loading
            && chat.error.is_none()
            && chat.conversation.older.is_none();
        let activity = active.then(|| chat.activity.clone().unwrap_or_else(|| "Working…".into()));
        let (alpha, moving) = chat.motion.frame(
            Instant::now(),
            cx.reduce_motion() || chat.error.is_some(),
            chat.list.is_following_tail(),
            activity,
            !chat.loading,
        );
        if moving {
            window.request_animation_frame();
        }
        let list_state = chat.list.clone();
        self.prepare_face_blink(&target, window, cx);
        let empty_watch = quiet
            .then(|| target.agent())
            .flatten()
            .and_then(|id| self.agent(id))
            .map(|agent| (SharedString::from(format!("empty-chat:{}", agent.id)), agent));
        let transcript = if quiet {
            let name = self.target_name(&target);
            let avatar = if let Some((key, agent)) = &empty_watch {
                let composer = self.composer.read(cx);
                let looking_down = composer.focus_handle(cx).is_focused(window) && !composer.value().trim().is_empty();
                let slot = AvatarSlot {
                    watch: Some(key.clone()),
                    empty_chat: true,
                    looking_down,
                    presence: face_state(Some(agent), self.avatar_asleep(&agent.id), false),
                    blink: Self::face_blink_scope(&target),
                    ..AvatarSlot::default()
                };
                bot_avatar_with(agent.avatar(), px(64.), false, slot, &theme, cx)
            } else {
                self.target_face(&target, px(64.), None, &theme, cx).into_any_element()
            };
            div()
                .size_full()
                .pt(HEADER_HEIGHT)
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_3()
                .child(avatar)
                .child(
                    div()
                        .item()
                        .text_color(theme.ink_secondary)
                        .child(format!("Say what you need and {name} gets to work.")),
                )
                .into_any_element()
        } else {
            let list = list(list_state, cx.processor(|this, index: usize, _, cx| this.render_row(index, cx)));
            div().size_full().opacity(alpha).child(list.size_full()).into_any_element()
        };

        let gaze = empty_watch.map(|(key, _)| key);
        let area = div().id("chat-content");
        let area = match gaze {
            Some(key) => superbot_avatars::gaze_region(area, key),
            None => area,
        };
        area.size_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(transcript)
                    .child(transcript_fade(theme.app, px(48.), 0.92, 0.).top_0())
                    .child(transcript_fade(theme.app, px(24.), 0., 1.).bottom_0())
                    .child(
                        self.render_chat_header(&target, panel_width, &theme, window, cx)
                            .absolute()
                            .top_0()
                            .left_0()
                            .right_0(),
                    ),
            )
            .child(self.render_composer(&target, &theme, window, cx))
            .into_any_element()
    }

    fn prepare_face_blink(&self, target: &Target, window: &mut Window, cx: &mut App) {
        let Some((scope, id)) = Self::face_blink_scope(target).zip(target.agent()) else {
            return;
        };
        if cx.reduce_motion() || self.avatar_asleep(id) {
            return;
        }
        let Some(agent) = self.agent(id) else { return };
        if superbot_avatars::look(agent.avatar(), cx).is_some() {
            return;
        }
        let model =
            self.local_model_for(id).map(|model| format!("local:{}:{}", model.provider, model.id)).or_else(|| {
                let bot = self.agent_info.bot(id)?;
                let own = bot.model_provider.as_deref().zip(bot.model_id.as_deref());
                match own {
                    Some((provider, model)) => Some(format!("hosted:{provider}:{model}")),
                    None => {
                        self.agent_info.main_choice().map(|(provider, model, _)| format!("hosted:{provider}:{model}"))
                    }
                }
            });
        superbot_avatars::conversation_blink(scope, id, model.map(Into::into), agent.waiting_on_you(), window, cx);
    }

    fn render_no_conversation(&mut self, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(drag_region(div().h(px(52.)), "empty-chat-drag", window, cx))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap_4()
                    .child(
                        div()
                            .item()
                            .text_color(theme.ink_secondary)
                            .child("Create your first agent to start a conversation."),
                    )
                    .child(
                        pill_button("first-agent", "New bot", Tone::Primary, true, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.new_agent(window, cx))),
                    ),
            )
            .into_any_element()
    }

    fn render_chat_header(
        &mut self,
        target: &Target,
        panel_width: Pixels,
        theme: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let name = self.target_name(target);
        let elevated = Colors::elevated(theme);
        let watch = SharedString::from("head");
        let docked = self.agent_panel.is_some();
        let choosing = self.model_menu_is_open(crate::ui::model_menu::ModelTrigger::Header);
        let model = match target {
            Target::Agent(id) | Target::Conversation { agent: id, .. } => self.chat_model_label(id),
            Target::Group(_) => None,
        };
        let identity = superbot_avatars::watch_region(div().id("chat-head"), watch.clone())
            .min_w_0()
            .flex()
            .items_center()
            .gap_2()
            .pt(px(9.))
            .pb(px(8.))
            .pl(px(9.))
            .pr(px(11.))
            .rounded_full()
            .cursor_pointer()
            .when(!docked && target.agent().is_some(), |button| tooltip::on(button, "Open details"))
            .on_click(cx.listener(|this, _, window, cx| match this.chat.as_ref().map(|chat| &chat.target) {
                Some(Target::Agent(_) | Target::Conversation { .. }) => this.toggle_agent_panel(window, cx),
                _ => this.show(View::Workspace, window, cx),
            }))
            .child(self.target_face(target, px(22.), Some(watch), theme, cx))
            .child(div().name().truncate().child(name));
        let identity = focus::control(identity, Ring::InnerPill, theme).fill(Pointer::BUTTON.held(docked), elevated);
        let mark = target.agent().and_then(|id| self.chat_model_mark(id));
        let model = model.map(|label| {
            let rotation =
                motion::value("header-model-chevron", f32::from(choosing), motion::SLIDE, motion::EMPHASIS, window, cx);
            let label_key = (target.clone(), label.clone());
            let label_opacity = model_label_opacity(label_key, window, cx);
            let button = self
                .model_menu_button(crate::ui::model_menu::ModelTrigger::Header, cx)
                .group("chat-model")
                .min_w_0()
                .flex()
                .items_center()
                .gap_1()
                .children(mark.map(|mark| {
                    let lift = if choosing { None } else { Some(SharedString::from("chat-model")) };
                    crate::ui::model_menu::mark_icon(mark, px(14.), lift, theme).mr(px(2.))
                }))
                .pt(px(9.))
                .pb(px(8.))
                .pl(px(9.))
                .pr(px(11.))
                .rounded_full()
                .cursor_pointer()
                .when(!choosing, |model| tooltip::on(model, "Change model"))
                .child(div().body().text_color(theme.ink_secondary).truncate().opacity(label_opacity).child(label))
                .child(
                    icon("chevron-down", px(14.), theme.ink_tertiary)
                        .with_transformation(Transformation::rotate(Radians(rotation * std::f32::consts::PI))),
                );
            focus::control(button, Ring::InnerPill, theme).fill(Pointer::BUTTON.held(choosing), elevated)
        });
        let pill = div()
            .max_w_full()
            .flex()
            .items_center()
            .rounded_full()
            .bg(theme.composer)
            .shadow(capsule_shadow(theme))
            .border_1()
            .border_color(theme.ink_at(0.06))
            .occlude()
            .child(identity)
            .when_some(model, |pill, model| {
                pill.child(div().w(px(1.)).h(px(16.)).flex_shrink_0().bg(theme.ink_at(0.12))).child(model)
            });
        let left = px(20.);
        #[cfg(target_os = "macos")]
        let left = if self.sidebar_hidden(window) { left.max(traffic_lights_reserve(window)) } else { left };
        let caption_space = if cfg!(target_os = "macos") { px(0.) } else { (CAPTION_WIDTH - panel_width).max(px(0.)) };
        drag_region(div(), "chat-header-drag", window, cx)
            .flex()
            .items_center()
            .justify_center()
            .pl(left)
            .pr_5()
            .h(HEADER_HEIGHT)
            .child(div().w(caption_space).flex_shrink_0())
            .child(div().flex_1().min_w_0().flex().justify_center().child(pill))
            .child(div().w(caption_space).flex_shrink_0())
    }

    fn chat_tone(&self, theme: &Theme, cx: &App) -> Option<ChatTone> {
        match &self.chat.as_ref()?.target {
            Target::Agent(id) | Target::Conversation { agent: id, .. } => {
                chat_tone(self.agent(id)?.avatar(), theme, cx)
            }
            Target::Group(_) => None,
        }
    }

    /// The working bot's face beside what it is doing.
    fn working_presence(&self, theme: &Theme, cx: &App) -> Option<AnyElement> {
        let Some(id) = self.chat.as_ref()?.target.agent() else { return None };
        let agent = self.agent(id)?;
        if let Some(look) = superbot_avatars::look(agent.avatar(), cx) {
            return Some(Mark::new("presence", look, px(28.), theme.ink).working(true).into_any_element());
        }
        let presence = face_state(Some(agent), self.avatar_asleep(&agent.id), true);
        Some(bot_avatar_with(
            agent.avatar(),
            px(28.),
            true,
            AvatarSlot { presence, ..AvatarSlot::default() },
            theme,
            cx,
        ))
    }

    /// The person's own bubbles: the bot's colour when the avatar pack recolours its chat.
    fn own_bubble(&self, theme: &Theme, cx: &App) -> (Hsla, Hsla) {
        match self.chat_tone(theme, cx) {
            Some(tone) => (tone.bubble, tone.bubble_ink),
            None => (theme.bubble_user, theme.bubble_user_ink),
        }
    }

    /// The avatar of what a conversation is with. An open chat's bot moves while it works.
    pub fn target_face(
        &self,
        target: &Target,
        size: Pixels,
        watch: Option<SharedString>,
        theme: &Theme,
        cx: &App,
    ) -> Div {
        match target {
            Target::Agent(id) | Target::Conversation { agent: id, .. } => {
                let live = self.chat.as_ref().filter(|chat| &chat.target == target);
                let agent = self.agent(id);
                let working = live.is_some_and(|chat| chat.working) || agent.is_some_and(AgentSummary::working);
                let presence = face_state(
                    agent,
                    self.avatar_asleep(id),
                    working || live.is_some_and(|chat| chat.local_turn.is_some()),
                );
                let blink = if watch.is_some() { Self::face_blink_scope(target) } else { None };
                let slot = AvatarSlot { watch, presence, blink, ..AvatarSlot::default() };
                let bot = agent.map(AgentSummary::avatar).unwrap_or(Bot {
                    id,
                    name: "",
                    color: "",
                    picked: Default::default(),
                });
                let avatar = bot_avatar_with(bot, size, working, slot, theme, cx);
                div().flex_shrink_0().child(avatar)
            }
            Target::Group(id) => {
                let members: Vec<GroupMember> = self
                    .groups()
                    .iter()
                    .find(|group| &group.id == id)
                    .map(|group| group.members.iter().take(2).cloned().collect())
                    .unwrap_or_default();
                let face = size * 0.68;
                let surface = if watch.is_some() {
                    theme.composer
                } else if size == px(64.) {
                    theme.app
                } else if self.view == View::Chat && self.chat.as_ref().is_some_and(|chat| &chat.target == target) {
                    theme.raised
                } else {
                    theme.panel
                };
                div().size(size).flex_shrink_0().relative().children(members.iter().enumerate().map(
                    |(index, member)| {
                        let front = index == 1;
                        let offset = if front { size - face } else { px(0.) };
                        let bot = member.avatar();
                        let ring = front && superbot_avatars::look(bot, cx).is_none();
                        let agent = self.agent(&member.bot_id);
                        let group_working =
                            agent.is_some_and(|agent| matches!(agent.status.as_str(), "queued" | "leased" | "running"));
                        let presence = face_state(agent, self.avatar_asleep(&member.bot_id), group_working);
                        let slot = AvatarSlot { back_of_stack: !front, presence, ..AvatarSlot::default() };
                        div()
                            .absolute()
                            .left(offset)
                            .top(offset)
                            .size(face)
                            .when(ring, |face| face.child(div().absolute().inset(px(-2.)).rounded_full().bg(surface)))
                            .child(bot_avatar_with(bot, face, false, slot, theme, cx))
                    },
                ))
            }
        }
    }

    /// The list's rows: the head row, one per message, then what is happening now.
    fn render_row(&mut self, row: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let Some(chat) = self.chat.as_ref() else { return div().into_any_element() };
        let entry = row.checked_sub(1).and_then(|index| chat.entries.get(index));
        let marked = entry.is_some_and(|entry| chat.reveal.marked.as_deref() == Some(entry.id.as_str()));
        let row_id = file::row_id(row, entry);
        let content = match row.checked_sub(1) {
            // This space scrolls away with the first row while the header floats above the list.
            None => div().pt(HEADER_HEIGHT).child(self.render_head(&theme, cx)).into_any_element(),
            Some(index) => match entry {
                Some(entry) => {
                    let place = place(&chat.entries, index, &Local);
                    let phase = chat.motion.arrival(&entry.id, Instant::now());
                    self.render_entry(entry, place, index, &theme, cx)
                        .when_some(phase, |message, progress| {
                            message.relative().top(px(6. * (1. - progress))).opacity(progress)
                        })
                        .into_any_element()
                }
                None => self.render_now(&theme, cx),
            },
        };
        div()
            .id(row_id)
            .w_full()
            .flex()
            .justify_center()
            .pl_5()
            .pr(px(28.))
            .child(
                div()
                    .w_full()
                    .max_w(CHAT_COLUMN)
                    .rounded(radius::CARD)
                    .when(marked, |column| column.bg(theme.accent.opacity(0.12)))
                    .child(content),
            )
            .into_any_element()
    }

    /// The transcript's first row: the way to the history before what is loaded.
    fn render_head(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(chat) = self.chat.as_ref().filter(|chat| !chat.loading) else {
            return div().into_any_element();
        };
        let state = &chat.conversation;
        let line = |text: &'static str| div().body().text_color(theme.ink_tertiary).child(text);
        let again = |label: &'static str, cx: &mut Context<Self>| {
            div()
                .id(label)
                .body()
                .text_color(theme.accent_text)
                .cursor_pointer()
                .on_click(cx.listener(|this, _, window, cx| this.load_older(window, cx)))
                .child(label)
        };
        let head = div().h(px(44.)).w_full().flex().items_center().justify_center().gap_2();
        if state.loading_older {
            head.child(Spinner::new().with_size(px(14.)).color(theme.ink_tertiary))
                .child(line("Loading earlier messages…"))
                .into_any_element()
        } else if state.older_problem.is_some() {
            head.child(line("Couldn't load earlier messages.")).child(again("Try again", cx)).into_any_element()
        } else if state.older.is_some() {
            head.child(
                pill_button("earlier", "Earlier messages", Tone::Quiet, true, theme)
                    .h_7()
                    .on_click(cx.listener(|this, _, window, cx| this.load_older(window, cx))),
            )
            .into_any_element()
        } else if state.capped {
            head.child(line("Older messages are on the web."))
                .child(self.open_on_web("Open on the web", theme, cx))
                .into_any_element()
        } else {
            div().into_any_element()
        }
    }

    fn render_entry(&self, entry: &Entry, place: Place, index: usize, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let chat = self.chat.as_ref();
        let in_group = chat.is_some_and(|chat| matches!(chat.target, Target::Group(_)));
        let markdown = entry.speaker == Speaker::Agent && !entry.local_cli;
        let members: &[GroupMember] = chat.map_or(&[], |chat| &chat.conversation.members);
        let own = self.own_bubble(theme, cx);
        let join = place.join;
        let mine = entry.speaker == Speaker::Person
            && match &entry.author_id {
                Some(author) => self.me.as_ref().is_some_and(|me| &me.user_id == author),
                None => entry.name.as_deref().is_none_or(|name| self.me.as_ref().is_some_and(|me| me.name == name)),
            };
        let agent = entry.agent_id.as_deref().and_then(|id| self.agent(id));
        let voice = if join.above {
            None
        } else {
            match entry.speaker {
                Speaker::Agent if entry.local_cli => Some((
                    entry.name.as_ref().map_or_else(|| "Local CLI".to_owned(), |name| format!("Local CLI · {name}")),
                    theme.ink_secondary,
                )),
                Speaker::Agent if in_group => {
                    agent.map(|agent| (agent.name.clone(), bot_ink(agent.avatar(), theme, cx)))
                }
                Speaker::Person if !mine => entry.name.clone().map(|name| (name, theme.ink_secondary)),
                _ => None,
            }
        };
        let gap = if place.stamped {
            px(0.)
        } else if index == 0 {
            px(20.)
        } else if join.above {
            px(4.)
        } else {
            px(16.)
        };
        let stamp = entry.at.filter(|_| place.stamped).map(|at| {
            div()
                .w_full()
                .pt_5()
                .pb_1()
                .flex()
                .justify_center()
                .body()
                .text_color(theme.ink_secondary)
                .child(clock::stamp(at, clock::now(), &Local))
        });
        let said = entry.at.map(|at| SharedString::from(clock::full(at, &Local)));

        let parts = entry.parts.iter().enumerate().map(|(part_index, part)| match part {
            Part::Text(text) => {
                let named = if in_group && entry.speaker == Speaker::Person {
                    outbox::mention_ranges(text, members)
                } else {
                    Vec::new()
                };
                let key = (index, part_index);
                let bubble = bubble(text, mine, markdown, join, key, &named, own, theme);
                match said.clone() {
                    Some(said) => {
                        tooltip::on(div().id(("said", index * 64 + part_index)).max_w_full().child(bubble), said)
                            .into_any_element()
                    }
                    None => bubble,
                }
            }
            Part::Note(text) | Part::Steps(text) => div()
                .w_full()
                .flex()
                .justify_center()
                .child(div().meta().text_color(theme.ink_tertiary).child(text.clone()))
                .into_any_element(),
            Part::File(file) => {
                let occurrence = entry.parts[..part_index]
                    .iter()
                    .filter(|part| matches!(part, Part::File(other) if other.artifact_id == file.artifact_id))
                    .count();
                self.render_file(file, occurrence, theme, cx)
            }
            Part::Facts(lines) => card(theme)
                .gap_1()
                .children(lines.iter().map(|(key, value)| {
                    div()
                        .flex()
                        .gap_3()
                        .body()
                        .child(div().w(px(120.)).flex_shrink_0().text_color(theme.ink_secondary).child(key.clone()))
                        .child(div().flex_1().min_w_0().child(value.clone()))
                }))
                .into_any_element(),
            Part::Ask { text, detail, answer, actions, needs_typing } => card(theme)
                .gap_2p5()
                .child(div().bubble().child(text.clone()))
                .children(detail.clone().map(|detail| {
                    div()
                        .px_2p5()
                        .py_2()
                        .rounded(radius::FIELD)
                        .bg(theme.ink_at(0.04))
                        .body()
                        .text_color(theme.ink_secondary)
                        .line_clamp(8)
                        .child(detail)
                }))
                .children(answer.clone().map(|answer| div().body().text_color(theme.ink_tertiary).child(answer)))
                .when(*needs_typing, |card| card.child(self.open_on_web("Answer on the web", theme, cx)))
                .when(!actions.is_empty(), |card| {
                    card.child(div().flex().flex_wrap().gap_2().children(actions.iter().enumerate().map(
                        |(choice, action)| {
                            let tone = if choice == 0 { Tone::Primary } else { Tone::Quiet };
                            let (run_id, message_id, answer) =
                                (entry.run_id.clone(), entry.id.clone(), action.id.clone());
                            pill_button(
                                SharedString::from(format!("answer-{}-{}", entry.id, action.id)),
                                action.label.clone(),
                                tone,
                                run_id.is_some(),
                                theme,
                            )
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if let Some(run_id) = run_id.clone() {
                                    this.answer_card(run_id, message_id.clone(), answer.clone(), window, cx);
                                }
                            }))
                        },
                    )))
                })
                .into_any_element(),
            Part::Question(question) => self.render_question(entry, question, theme, cx),
            Part::Choice(choice) => self.render_choice(entry, choice, theme, cx),
            Part::Elsewhere(kind) => card(theme)
                .flex_row()
                .items_center()
                .gap_3()
                .child(div().body().text_color(theme.ink_secondary).child(*kind))
                .child(self.open_on_web("Open on the web", theme, cx))
                .into_any_element(),
        });

        div().flex().flex_col().children(stamp).child(
            div()
                .pt(gap)
                .flex()
                .flex_col()
                .gap_1()
                .when(mine, |row| row.items_end())
                .when(!mine, |row| row.items_start())
                .children(voice.map(|(name, color)| {
                    div().px_3().body().font_weight(FontWeight::SEMIBOLD).text_color(color).child(name)
                }))
                .children(entry.quote.clone().map(|quote| {
                    // The quoted words in a hairline pill above the bubble, as on the web.
                    div()
                        .max_w(px(250.))
                        .h(px(28.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .rounded_full()
                        .border_1()
                        .border_color(theme.hairline)
                        .meta()
                        .text_color(theme.ink_secondary)
                        .child(div().truncate().child(quote))
                }))
                .children(parts),
        )
    }

    /// A card this app does not draw yet opens where it can be used: the server's own web app.
    fn open_on_web(&self, label: &'static str, theme: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        div()
            .id(label)
            .body()
            .text_color(theme.accent_text)
            .cursor_pointer()
            .on_click(cx.listener(|this, _, _, cx| this.open_web_workspace(cx)))
            .child(label)
    }

    /// The transcript's last row: what is happening now, and what went wrong.
    fn render_now(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let own = self.own_bubble(theme, cx);
        let presence = self.working_presence(theme, cx);
        let Some(chat) = self.chat.as_ref() else { return div().into_any_element() };
        let last = chat.entries.len();
        let now = Instant::now();
        // A local exchange shows at once, faded until it is saved to the conversation.
        let unsaved = chat.local_prompt.clone().map(|text| (text, None)).or_else(|| {
            let (text, reply) = self.pending_local_write()?.exchange();
            Some((text.to_owned(), reply.map(str::to_owned)))
        });
        div()
            .pb_4()
            .flex()
            .flex_col()
            .items_start()
            .when_some(unsaved, |row, (text, reply)| {
                let mine = bubble(&text, true, false, Join::default(), (last, 1), &[], own, theme);
                let phase = chat.motion.optimistic_arrival(now).unwrap_or(1.);
                row.child(
                    div()
                        .pt_4()
                        .w_full()
                        .flex()
                        .justify_end()
                        .relative()
                        .top(px(4. * (1. - phase)))
                        .opacity(0.6 * phase)
                        .child(mine),
                )
                .children(reply.map(|reply| {
                    let theirs = bubble(&reply, false, true, Join::default(), (last, 2), &[], own, theme);
                    div().pt_4().w_full().flex().opacity(0.6).child(theirs)
                }))
            })
            .when(!chat.draft.is_empty(), |row| {
                let draft = bubble(&chat.draft, false, true, Join::default(), (last, 0), &[], own, theme);
                row.child(div().pt_4().w_full().flex().child(draft))
            })
            .when_some(chat.motion.working(now), |row, (activity, alpha)| {
                row.child(
                    div()
                        .pt_3()
                        .px_1()
                        .opacity(alpha)
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(
                            presence
                                .unwrap_or_else(|| div().size_2().rounded_full().bg(theme.success).into_any_element()),
                        )
                        .child(div().body().text_color(theme.ink_tertiary).truncate().child(activity.to_owned())),
                )
            })
            .when(chat.reconnecting, |row| {
                row.child(div().pt_3().px_1().body().text_color(theme.ink_tertiary).child("Reconnecting…"))
            })
            .children(chat.error.clone().map(|error| div().pt_4().w_full().child(error_line(error, theme))))
            .when(chat.unread, |row| {
                let target = chat.target.clone();
                row.child(div().pt_3().child(
                    pill_button("reload-chat", "Try again", Tone::Quiet, true, theme).on_click(cx.listener(
                        move |this, _, window, cx| {
                            this.chat = None;
                            this.open(target.clone(), window, cx);
                        },
                    )),
                ))
            })
            .into_any_element()
    }

    /// The group's bots a typed `@` could mean, in a list that sits on the composer.
    fn render_mentions(&self, list: &MentionList, theme: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let hover = theme.ink_at(0.06);
        div()
            .id("mentions")
            .absolute()
            .left(px(8.))
            .bottom(relative(1.))
            .mb_2()
            .w(px(288.))
            .max_h(px(288.))
            .overflow_y_scroll()
            .p_1()
            .flex()
            .flex_col()
            .rounded(radius::CARD)
            .bg(theme.menu)
            .border_1()
            .border_color(theme.ink_at(0.1))
            .shadow(theme.float_shadow())
            .occlude()
            .children(list.choices.iter().enumerate().map(|(index, member)| {
                let presence = face_state(self.agent(&member.bot_id), self.avatar_asleep(&member.bot_id), false);
                let slot = AvatarSlot { presence, ..AvatarSlot::default() };
                div()
                    .id(("mention", index))
                    .h(px(30.))
                    .flex_shrink_0()
                    .px_2()
                    .flex()
                    .items_center()
                    .gap_2()
                    .rounded(radius::MENU_ROW)
                    .item()
                    .cursor_pointer()
                    .when(index == list.chosen, |row| row.bg(theme.ink_at(0.08)))
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.pick_mention(Some(index), window, cx);
                    }))
                    .child(bot_avatar_with(member.avatar(), px(20.), false, slot, theme, cx))
                    .child(div().flex_1().min_w_0().truncate().child(member.name.clone()))
            }))
    }
}

pub(crate) fn card(theme: &Theme) -> Div {
    div()
        .max_w(BUBBLE_MAX)
        .flex()
        .flex_col()
        .p_3()
        .rounded(radius::BUBBLE)
        .bg(theme.composer)
        .border_1()
        .border_color(theme.ink_at(0.1))
}

fn bubble(
    text: &str,
    mine: bool,
    markdown: bool,
    join: Join,
    key: (usize, usize),
    named: &[std::ops::Range<usize>],
    own: (Hsla, Hsla),
    theme: &Theme,
) -> AnyElement {
    let (fill, ink) = if mine { own } else { (theme.card, theme.ink) };
    let tight = radius::BUBBLE_JOINED;
    let shape = div()
        .max_w(BUBBLE_MAX)
        .min_w_9()
        .px_3()
        .py(px(7.))
        .rounded(radius::BUBBLE)
        .bg(fill)
        .text_color(ink)
        .bubble()
        .when(join.above && mine, |bubble| bubble.rounded_tr(tight))
        .when(join.below && mine, |bubble| bubble.rounded_br(tight))
        .when(join.above && !mine, |bubble| bubble.rounded_tl(tight))
        .when(join.below && !mine, |bubble| bubble.rounded_bl(tight));
    match markdown {
        true => shape
            .child(TextView::markdown(("reply", key.0 * 64 + key.1), text.to_owned()).selectable(true))
            .into_any_element(),
        _ if named.is_empty() => shape.child(text.to_owned()).into_any_element(),
        // The bots a group message names stand out in it.
        _ => {
            let weight = HighlightStyle { font_weight: Some(FontWeight::SEMIBOLD), ..Default::default() };
            let highlights = named.iter().map(|range| (range.clone(), weight));
            shape.child(StyledText::new(text.to_owned()).with_highlights(highlights)).into_any_element()
        }
    }
}
