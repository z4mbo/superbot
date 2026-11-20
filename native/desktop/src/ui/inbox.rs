use std::collections::HashSet;

use chrono::{Datelike, Local, TimeZone};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use superbot_features::{ConversationTarget, Features, InboxItem, InboxKind, InboxState};

use crate::api::{self, Target};
use crate::app::Desktop;
use crate::clock;
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::{bot_avatar, error_line, icon, Type};

/// The reference's 320, and room for the caption buttons that share its header off macOS.
const PANEL_WIDTH: Pixels = if cfg!(target_os = "macos") { px(320.) } else { px(360.) };

/// This member's inbox in the open Space: questions waiting on them, work in progress and
/// finished results, each with its own unread, read or done state on the server.
#[derive(Default)]
pub struct Inbox {
    pub open: bool,
    items: Option<Vec<InboxItem>>,
    generation: u64,
    read_at: Option<u64>,
    reading: bool,
    problem: Option<String>,
    changing: HashSet<String>,
    show_done: bool,
    search: Option<(Entity<InputState>, Subscription)>,
}

impl Inbox {
    /// Reads the inbox again on the next frame, after a change signal or the window coming back.
    pub fn stale(&mut self) {
        self.generation += 1;
    }

    fn listed(&self) -> impl Iterator<Item = &InboxItem> {
        self.items.iter().flatten().filter(|item| item.state != InboxState::Done)
    }

    fn done(&self) -> impl Iterator<Item = &InboxItem> {
        self.items.iter().flatten().filter(|item| item.state == InboxState::Done)
    }

    /// What the Inbox entry counts: questions waiting on this member and anything unread.
    pub fn count(&self) -> usize {
        self.listed().filter(|item| item.kind == InboxKind::Question || item.state == InboxState::Unread).count()
    }

    /// The listed lines one agent asked, worked on or finished, for its side panel.
    pub(crate) fn of_agent(&self, bot_id: &str) -> Vec<InboxItem> {
        self.listed().filter(|item| item.bot_id == bot_id).cloned().collect()
    }

    /// The account menu's entry, with what is waiting.
    pub fn menu_label(&self) -> String {
        match self.count() {
            0 => "Inbox".into(),
            count => format!("Inbox · {count}"),
        }
    }

    pub(crate) fn has_read(&self) -> bool {
        self.items.is_some()
    }
}

pub fn conversation(target: &ConversationTarget) -> Target {
    match target {
        ConversationTarget::Bot { bot_id } => Target::Agent(bot_id.clone()),
        ConversationTarget::Group { group_id } => Target::Group(group_id.clone()),
        ConversationTarget::BotConversation { bot_id, thread_id } => {
            Target::Conversation { agent: bot_id.clone(), thread: thread_id.clone() }
        }
    }
}

/// A row's time: "now", minutes, hours, a weekday within the week, else the date.
fn when(at: clock::Instant, now: clock::Instant) -> String {
    let minutes = (now - at).max(0) / 60_000;
    if minutes < 1 {
        return "now".into();
    }
    if minutes < 60 {
        return format!("{minutes}m");
    }
    if minutes < 24 * 60 {
        return format!("{}h", minutes / 60);
    }
    let Some(time) = Local.timestamp_millis_opt(at).single() else { return String::new() };
    if minutes < 7 * 24 * 60 {
        return time.format("%a").to_string();
    }
    let this_year = Local.timestamp_millis_opt(now).single().is_some_and(|today| today.year() == time.year());
    time.format(if this_year { "%b %-d" } else { "%b %-d, %Y" }).to_string()
}

impl Desktop {
    fn inbox_features(&self) -> Option<(Features, String)> {
        Some((Features::new(self.api.as_ref()?.client.clone()), self.space_id()?))
    }

    /// Reads the inbox when it has not been read since it went stale. Called while drawing.
    pub fn sync_inbox(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.inbox.reading || self.inbox.read_at == Some(self.inbox.generation) {
            return;
        }
        let Some((features, space)) = self.inbox_features() else { return };
        let generation = self.inbox.generation;
        self.inbox.reading = true;
        let work = async move { features.space(space).inbox(true).await };
        self.call(window, cx, work, move |this, result, _, _| {
            this.inbox.reading = false;
            this.inbox.read_at = Some(generation);
            match result {
                Ok(items) => {
                    this.inbox.items = Some(items);
                    this.inbox.problem = None;
                }
                Err(error) => this.inbox.problem = Some(api::explain(&error)),
            }
        });
    }

    pub fn toggle_inbox(&mut self, cx: &mut Context<Self>) {
        self.inbox.open = !self.inbox.open;
        if self.inbox.open {
            self.agent_panel = None;
            self.inbox.stale();
        }
        cx.notify();
    }

    /// Opens the conversation an inbox line comes from, marking the line read.
    fn open_inbox_item(&mut self, item: InboxItem, window: &mut Window, cx: &mut Context<Self>) {
        if item.state == InboxState::Unread {
            self.set_inbox_state(vec![item.id.clone()], InboxState::Read, window, cx);
        }
        match conversation(&item.target) {
            Target::Agent(agent) => self.open_conversation(&agent, None, window, cx),
            target => self.open(target, window, cx),
        }
    }

    /// Changes lines on the server; the list shows the change at once and takes it back if the
    /// server refuses.
    fn set_inbox_state(&mut self, ids: Vec<String>, state: InboxState, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.inbox_features() else { return };
        let Some(items) = self.inbox.items.as_mut() else { return };
        let mut before = Vec::new();
        for item in items.iter_mut().filter(|item| ids.contains(&item.id) && !self.inbox.changing.contains(&item.id)) {
            before.push((item.id.clone(), item.state));
            item.state = state;
        }
        if before.is_empty() {
            return;
        }
        self.inbox.changing.extend(before.iter().map(|(id, _)| id.clone()));
        let changing: Vec<String> = before.iter().map(|(id, _)| id.clone()).collect();
        let work = async move {
            let space = features.space(space);
            for id in &changing {
                space.set_inbox_state(id, state).await?;
            }
            Ok(())
        };
        self.call(window, cx, work, move |this, result, _, cx| {
            for (id, _) in &before {
                this.inbox.changing.remove(id);
            }
            if let Err(error) = result {
                if let Some(items) = this.inbox.items.as_mut() {
                    for (id, previous) in &before {
                        if let Some(item) = items.iter_mut().find(|item| &item.id == id) {
                            item.state = *previous;
                        }
                    }
                }
                this.inbox.problem = Some(api::explain(&error));
            }
            this.inbox.stale();
            cx.notify();
        });
        cx.notify();
    }

    fn mark_inbox_read(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let ids =
            self.inbox.listed().filter(|item| item.state == InboxState::Unread).map(|item| item.id.clone()).collect();
        self.set_inbox_state(ids, InboxState::Read, window, cx);
    }

    pub fn render_inbox_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.inbox.open {
            return None;
        }
        self.sync_inbox(window, cx);
        let theme = cx.skin().clone();
        let count = self.inbox.count();
        let unread = self.inbox.listed().any(|item| item.state == InboxState::Unread);
        let search = match &self.inbox.search {
            Some((search, _)) => search.clone(),
            None => {
                let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search inbox"));
                let events = cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                });
                self.inbox.search = Some((search.clone(), events));
                search
            }
        };
        let query = search.read(cx).value().trim().to_lowercase();
        let matches = |item: &InboxItem| {
            query.is_empty()
                || item.title.to_lowercase().contains(&query)
                || self.agent(&item.bot_id).is_some_and(|agent| agent.name.to_lowercase().contains(&query))
        };
        let listed_any = self.inbox.listed().next().is_some();
        let rows: Vec<InboxItem> = self.inbox.listed().filter(|item| matches(item)).cloned().collect();
        let done: Vec<InboxItem> = self.inbox.done().filter(|item| matches(item)).cloned().collect();
        let show_done = self.inbox.show_done;
        let header = div()
            .h(px(50.))
            .flex_shrink_0()
            .flex()
            .items_start()
            .gap(px(10.))
            .pl(px(13.))
            .pr(px(13.))
            .pt(px(13.))
            .window_control_area(WindowControlArea::Drag)
            .child(
                div()
                    .h(px(34.))
                    .flex_1()
                    .min_w_0()
                    .pl_1()
                    .flex()
                    .items_center()
                    .gap_2()
                    .item()
                    .child(icon("inbox", px(16.), theme.ink_secondary))
                    .child(
                        div().min_w_0().truncate().font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("Inbox"),
                    )
                    .when(count > 0, |title| {
                        title.child(div().text_color(theme.ink_tertiary).child(count.to_string()))
                    }),
            )
            .when(unread, |header| {
                header.child(
                    crate::ui::agent_panel::round_button("inbox-mark-all", "check-check", false, &theme)
                        .tooltip(|window, cx| {
                            gpui_kit::component::tooltip::Tooltip::new("Mark all as read").build(window, cx)
                        })
                        .on_click(cx.listener(|this, _, window, cx| this.mark_inbox_read(window, cx))),
                )
            })
            .child(
                crate::ui::agent_panel::round_button("inbox-close", "x", false, &theme)
                    .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Close inbox").build(window, cx))
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_inbox(cx))),
            )
            .when(cfg!(not(target_os = "macos")), |header| header.mr(crate::theme::CAPTION_WIDTH));

        let now = clock::now();
        let search_field = listed_any.then(|| {
            div()
                .mx(px(13.))
                .my(px(10.))
                .h_8()
                .px(px(10.))
                .flex()
                .items_center()
                .gap_2()
                .rounded(radius::FIELD)
                .bg(theme.ink_at(0.045))
                .border_1()
                .border_color(theme.ink_at(0.12))
                .child(icon("search", px(14.), theme.ink_tertiary))
                .child(div().flex_1().min_w_0().child(Input::new(&search).appearance(false).bordered(false).small()))
        });
        let list = if rows.is_empty() && listed_any {
            div()
                .px_4()
                .py_8()
                .flex()
                .justify_center()
                .body()
                .text_color(theme.ink_secondary)
                .child("Nothing matches that search.")
                .into_any_element()
        } else if rows.is_empty() && self.inbox.has_read() {
            div()
                .mx_auto()
                .max_w(px(256.))
                .px_4()
                .py_10()
                .flex()
                .flex_col()
                .items_center()
                .text_center()
                .child(icon("inbox", px(22.), theme.ink_tertiary))
                .child(div().mt_3().name().text_color(theme.ink).child("Nothing for you yet."))
                .child(
                    div()
                        .mt_1()
                        .body()
                        .text_color(theme.ink_tertiary)
                        .child("When an agent has a question or finishes something, it shows up here."),
                )
                .into_any_element()
        } else {
            div()
                .px_1p5()
                .pb_1p5()
                .flex()
                .flex_col()
                .gap_0p5()
                .children(rows.into_iter().map(|item| self.render_inbox_row(item, now, &theme, cx)))
                .into_any_element()
        };
        let done_section = (!done.is_empty()).then(|| {
            let hover = theme.raised;
            div()
                .px_1p5()
                .pb_1p5()
                .child(
                    div()
                        .id("inbox-done")
                        .w_full()
                        .px_2()
                        .py_1p5()
                        .flex()
                        .items_center()
                        .gap_1p5()
                        .rounded(radius::FIELD)
                        .meta()
                        .text_color(theme.ink_tertiary)
                        .cursor_pointer()
                        .hover(move |style| style.bg(hover))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.inbox.show_done = !this.inbox.show_done;
                            cx.notify();
                        }))
                        .child(icon("check", px(13.), theme.ink_tertiary))
                        .child(div().font_weight(FontWeight::MEDIUM).child("Done"))
                        .child(done.len().to_string()),
                )
                .when(show_done, |section| {
                    section.children(done.into_iter().map(|item| self.render_inbox_row(item, now, &theme, cx)))
                })
        });
        let problem = self.inbox.problem.clone();
        Some(
            div()
                .id("inbox-panel")
                .w(PANEL_WIDTH)
                .h_full()
                .flex_shrink_0()
                .flex()
                .flex_col()
                .bg(theme.app)
                .border_l_1()
                .border_color(theme.ink_at(0.06))
                .occlude()
                .child(header)
                .child(
                    div()
                        .id("inbox-list")
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scroll()
                        .children(problem.map(|problem| div().px_3().pb_2().child(error_line(problem, &theme))))
                        .children(search_field)
                        .child(list)
                        .children(done_section),
                )
                .into_any_element(),
        )
    }

    /// One inbox line: who it is from and where, its title, its time, and on hover Done.
    pub(crate) fn render_inbox_row(
        &self,
        item: InboxItem,
        now: clock::Instant,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let agent = self.agent(&item.bot_id).cloned();
        let sender = agent.as_ref().map_or_else(|| "An agent".to_owned(), |agent| agent.name.clone());
        let place = match &item.target {
            ConversationTarget::Group { group_id } => {
                self.groups().iter().find(|group| &group.id == group_id).map(|group| group.name.clone())
            }
            _ => None,
        };
        let unread = item.state == InboxState::Unread;
        let headline = if item.title.trim().is_empty() || item.title == sender {
            match item.kind {
                InboxKind::Question => "Has a question for you",
                InboxKind::Active => "Working on it",
                InboxKind::Result => "Finished",
            }
            .to_owned()
        } else {
            item.title.clone()
        };
        let waits = item.kind == InboxKind::Question && item.state != InboxState::Done;
        let time = clock::instant(&item.updated_at).map(|at| when(at, now)).unwrap_or_default();
        let id = SharedString::from(format!("inbox-{}", item.id));
        let group = SharedString::from(format!("inbox-row-{}", item.id));
        let hover = theme.raised;
        let (done_id, open_item) = (item.id.clone(), item.clone());
        let is_done = item.state == InboxState::Done;
        let face = match &agent {
            Some(agent) => bot_avatar(agent.avatar(), px(18.), false, None, theme, cx),
            None => div().size(px(18.)).into_any_element(),
        };
        let dot = div()
            .mt(px(7.))
            .size(px(6.))
            .flex_shrink_0()
            .rounded_full()
            .when(waits || unread, |dot| dot.bg(theme.accent));
        div()
            .id(id)
            .group(group.clone())
            .relative()
            .flex()
            .items_start()
            .gap_2()
            .pl(px(10.))
            .pr_1p5()
            .py_2()
            .rounded(radius::FIELD)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(move |this, _, window, cx| this.open_inbox_item(open_item.clone(), window, cx)))
            .child(dot)
            .child(div().mt(px(1.)).child(face))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(1.))
                    .child(
                        div()
                            .flex()
                            .items_baseline()
                            .gap_1p5()
                            .child(
                                div()
                                    .min_w_0()
                                    .body()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(if unread || waits { theme.ink } else { theme.ink_secondary })
                                    .truncate()
                                    .child(sender),
                            )
                            .children(place.map(|place| {
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .meta()
                                    .text_color(theme.ink_tertiary)
                                    .truncate()
                                    .child(format!("in {place}"))
                            }))
                            .child(div().flex_1())
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .text_size(px(11.))
                                    .text_color(theme.ink_tertiary)
                                    .group_hover(group.clone(), |style| style.opacity(0.))
                                    .child(time),
                            ),
                    )
                    .child(
                        div()
                            .body()
                            .font_weight(if unread || waits { FontWeight::SEMIBOLD } else { FontWeight::NORMAL })
                            .text_color(if unread || waits { theme.ink } else { theme.ink_secondary })
                            .truncate()
                            .child(headline),
                    ),
            )
            .when(!is_done, |row| {
                let hover = theme.ink_at(0.07);
                row.child(
                    div()
                        .absolute()
                        .top(px(6.))
                        .right(px(6.))
                        .invisible()
                        .group_hover(group, |style| style.visible())
                        .child(
                            div()
                                .id(SharedString::from(format!("inbox-done-{done_id}")))
                                .size_7()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_full()
                                .bg(theme.raised)
                                .hover(move |style| style.bg(hover))
                                .tooltip(|window, cx| {
                                    gpui_kit::component::tooltip::Tooltip::new("Done").build(window, cx)
                                })
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.set_inbox_state(vec![done_id.clone()], InboxState::Done, window, cx);
                                }))
                                .child(icon("check", px(14.), theme.ink_secondary)),
                        ),
                )
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use superbot_features::ConversationTarget;

    use super::{conversation, when};
    use crate::api::Target;
    use crate::clock;

    #[test]
    fn row_times_shorten_with_age() {
        let now = clock::instant("2026-11-20T12:00:00Z").unwrap();
        let at = |rfc: &str| clock::instant(rfc).unwrap();
        assert_eq!(when(at("2026-11-20T11:59:40Z"), now), "now");
        assert_eq!(when(at("2026-11-20T11:35:00Z"), now), "25m");
        assert_eq!(when(at("2026-11-20T07:00:00Z"), now), "5h");
    }

    #[test]
    fn a_line_opens_the_conversation_it_came_from() {
        let thread = ConversationTarget::BotConversation { bot_id: "b".into(), thread_id: "t".into() };
        assert_eq!(conversation(&thread), Target::Conversation { agent: "b".into(), thread: "t".into() });
        assert_eq!(conversation(&ConversationTarget::Group { group_id: "g".into() }), Target::Group("g".into()));
    }
}
