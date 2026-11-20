use gpui_kit::component::input::Input;
use superbot_features::BotConversationPatch;

use super::*;
use crate::app::conversations::{Row, SHOWN};
use crate::app::MenuKind;
use crate::ui::new_menu::menu_shadow;

impl Desktop {
    fn conversation_row(
        &self,
        agent: &str,
        index: usize,
        row: Row,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let hover = theme.ink_at(0.04);
        let Row { thread, title, when, open, pinned, archived, saving, .. } = row;
        if let Some(rename) = thread.as_deref().and_then(|thread| self.conversations.renaming(thread)) {
            return div()
                .px(px(8.))
                .py_1()
                .flex()
                .flex_col()
                .gap_1()
                .child(
                    div()
                        .h(px(36.))
                        .px_2()
                        .flex()
                        .items_center()
                        .rounded(radius::FIELD)
                        .bg(theme.inset)
                        .border_1()
                        .border_color(theme.ink_at(0.22))
                        .body()
                        .child(Input::new(&rename.input).appearance(false).bordered(false)),
                )
                .children(
                    rename
                        .problem
                        .clone()
                        .map(|problem| div().px_1().text_size(px(12.)).text_color(theme.danger).child(problem)),
                )
                .into_any_element();
        }
        let group = SharedString::from(format!("agent-conversation-{index}"));
        let actions = thread.clone().map(|thread| {
            let agent = agent.to_owned();
            let label = format!("Actions for {title}");
            let menu_open = matches!(
                self.menu.as_ref().map(|menu| &menu.kind),
                Some(MenuKind::Conversation { thread: open, .. }) if *open == thread
            );
            div()
                .id(("agent-conversation-actions", index))
                .size_6()
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .cursor_pointer()
                .when(!menu_open, |button| button.opacity(0.).group_hover(group.clone(), |style| style.opacity(1.)))
                .when(menu_open, |button| button.bg(theme.ink_at(0.06)))
                .hover(move |style| style.bg(hover))
                .when(!menu_open, |button| tooltip::on(button, label))
                .on_click(cx.listener(move |this, event: &ClickEvent, _, cx| {
                    cx.stop_propagation();
                    this.open_conversation_menu(&agent, &thread, event.position(), cx);
                }))
                .child(icon("ellipsis", px(14.), theme.ink_secondary))
        });
        let open_agent = agent.to_owned();
        let open_thread = thread.clone();
        let menu_agent = agent.to_owned();
        let menu_thread = thread.clone();
        div()
            .id(("agent-conversation", index))
            .group(group.clone())
            .flex()
            .items_center()
            .gap_2()
            .min_h(px(40.))
            .pl(px(14.))
            .pr(px(8.))
            .rounded(radius::FIELD)
            .cursor_pointer()
            .when(open, |row| row.bg(theme.ink_at(0.06)))
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                if event.click_count() >= 2 {
                    if let Some(thread) = &open_thread {
                        this.rename_conversation(&open_agent, thread, window, cx);
                    }
                } else if !open {
                    this.open_conversation(&open_agent, open_thread.clone(), window, cx);
                }
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                    if let Some(thread) = &menu_thread {
                        this.open_conversation_menu(&menu_agent, thread, event.position, cx);
                    }
                }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .body()
                    .text_color(if archived { theme.ink_secondary } else { theme.ink })
                    .when(open, |title| title.font_weight(FontWeight::MEDIUM))
                    .truncate()
                    .child(title),
            )
            .when(pinned, |row| row.child(icon("pin", px(11.), theme.ink_secondary)))
            .when(archived, |row| {
                row.child(div().flex_shrink_0().text_size(px(12.)).text_color(theme.ink_tertiary).child("Archived"))
            })
            .when(saving, |row| {
                row.child(gpui_kit::component::spinner::Spinner::new().with_size(px(12.)).color(theme.ink_tertiary))
            })
            .when(!archived, |row| {
                row.children(
                    when.map(|when| {
                        div().flex_shrink_0().text_size(px(12.)).text_color(theme.ink_tertiary).child(when)
                    }),
                )
            })
            .children(actions)
            .into_any_element()
    }

    /// The Conversations card of the reference panel: New conversation, then the agent's
    /// conversations once it has more than one, three at a time, and its archived ones apart.
    pub(super) fn render_conversations(&self, agent: &str, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let hover = theme.ink_at(0.04);
        let creating = self.conversations.creating(agent);
        let new = div()
            .id("agent-new-conversation")
            .flex()
            .items_center()
            .gap(px(10.))
            .min_h(px(46.))
            .px(px(14.))
            .rounded(radius::FIELD)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(|this, _, window, cx| this.new_conversation(window, cx)))
            .child(icon("square-pen", px(16.), theme.ink_secondary))
            .child(div().flex_1().name().text_color(theme.ink).child("New conversation"))
            .when(creating, |row| {
                row.child(gpui_kit::component::spinner::Spinner::new().with_size(px(14.)).color(theme.ink_tertiary))
            });

        let rows = self.conversation_rows(agent);
        let listed = rows.active.len() >= 2;
        let expanded = self.conversations.expanded;
        let hidden = rows.active.len().saturating_sub(SHOWN);
        let shown: Vec<_> = rows
            .active
            .into_iter()
            .enumerate()
            .filter(|(index, row)| expanded || *index < SHOWN || row.open)
            .map(|(index, row)| self.conversation_row(agent, index, row, theme, cx))
            .collect();
        let toggle = |id: &'static str, open: bool, label: String, cx: &mut Context<Self>, archive: bool| {
            div()
                .id(id)
                .flex()
                .items_center()
                .gap_1p5()
                .px(px(14.))
                .py_1p5()
                .rounded(radius::FIELD)
                .body()
                .text_color(theme.ink_secondary)
                .cursor_pointer()
                .hover(move |style| style.bg(hover).text_color(theme.ink))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if archive {
                        this.conversations.show_archived = !this.conversations.show_archived;
                    } else {
                        this.conversations.expanded = !this.conversations.expanded;
                    }
                    cx.notify();
                }))
                .child(icon(if open { "chevron-up" } else { "chevron-down" }, px(14.), theme.ink_tertiary))
                .child(label)
        };
        let more = (listed && hidden > 0).then(|| {
            let label = if expanded { "Show fewer".to_owned() } else { format!("Show {hidden} more") };
            toggle("agent-conversations-more", expanded, label, cx, false)
        });
        let archived_count = rows.archived.len();
        let show_archived = self.conversations.show_archived;
        let archived_toggle = (archived_count > 0).then(|| {
            toggle("agent-conversations-archived", show_archived, format!("Archived ({archived_count})"), cx, true)
        });
        let offset = 1000;
        let archived: Vec<_> = if show_archived {
            rows.archived
                .into_iter()
                .enumerate()
                .map(|(index, row)| self.conversation_row(agent, offset + index, row, theme, cx))
                .collect()
        } else {
            Vec::new()
        };
        div()
            .flex()
            .flex_col()
            .child(card_label("Conversations", theme))
            .child(new)
            .when(listed, |card| card.children(shown))
            .children(more)
            .children(archived_toggle)
            .children(archived)
            .children(
                self.conversations
                    .problem
                    .clone()
                    .map(|problem| div().px(px(14.)).py_1().text_size(px(12.)).text_color(theme.danger).child(problem)),
            )
    }

    /// The actions of one conversation, as the reference row's menu offers them.
    pub fn render_conversation_menu(&mut self, agent: &str, thread: &str, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let hover = theme.ink_at(0.06);
        let at = self.menu.as_ref().map(|menu| menu.at).unwrap_or_default();
        let rows = self.conversation_rows(agent);
        let row = rows.active.iter().chain(rows.archived.iter()).find(|row| row.thread.as_deref() == Some(thread));
        let (pinned, archived) = row.map_or((false, false), |row| (row.pinned, row.archived));
        let working = row.is_some_and(|row| row.open) && self.chat.as_ref().is_some_and(|chat| chat.working);
        let item =
            |id: &'static str, glyph: &'static str, label: &'static str, disabled: bool, cx: &mut Context<Self>| {
                let (agent, thread) = (agent.to_owned(), thread.to_owned());
                div()
                    .id(id)
                    .h(px(30.))
                    .px_2()
                    .flex()
                    .items_center()
                    .gap_2()
                    .rounded(radius::MENU_ROW)
                    .item()
                    .text_color(if disabled { theme.ink_tertiary } else { theme.ink })
                    .when(!disabled, |row| {
                        row.cursor_pointer().hover(move |style| style.bg(hover)).on_click(cx.listener(
                            move |this, _, window, cx| {
                                let patch = match id {
                                    "conversation-pin" => {
                                        BotConversationPatch { pinned: Some(!pinned), ..Default::default() }
                                    }
                                    "conversation-archive" => {
                                        BotConversationPatch { archived: Some(!archived), ..Default::default() }
                                    }
                                    _ => return this.rename_conversation(&agent, &thread, window, cx),
                                };
                                this.change_conversation(&agent, &thread, patch, None, window, cx);
                            },
                        ))
                    })
                    .child(icon(glyph, px(16.), if disabled { theme.ink_tertiary } else { theme.ink_secondary }))
                    .child(div().flex_1().min_w_0().truncate().child(label))
            };
        let sheet = div()
            .id("conversation-menu")
            .min_w(px(180.))
            .p(px(6.))
            .flex()
            .flex_col()
            .gap_0p5()
            .rounded(radius::CARD)
            .bg(theme.menu)
            .border_1()
            .border_color(theme.hairline.opacity(0.5))
            .shadow(menu_shadow(&theme))
            .occlude()
            .child(item("conversation-rename", "pencil", "Rename", false, cx))
            .child(item(
                "conversation-pin",
                if pinned { "pin-off" } else { "pin" },
                if pinned { "Unpin" } else { "Pin" },
                false,
                cx,
            ))
            .child(item(
                "conversation-archive",
                if archived { "archive-restore" } else { "archive" },
                if archived { "Unarchive" } else { "Archive" },
                working && !archived,
                cx,
            ));
        div()
            .id("menu-backdrop")
            .absolute()
            .inset_0()
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.menu = None;
                    cx.notify();
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, _, _, cx| {
                    this.menu = None;
                    cx.notify();
                }),
            )
            .child(
                deferred(
                    anchored().position(at).anchor(Anchor::TopRight).snap_to_window_with_margin(px(8.)).child(sheet),
                )
                .with_priority(1),
            )
            .into_any_element()
    }
}

impl Desktop {
    /// Stands in for the composer while the open conversation is archived: it takes no new
    /// message until restored, and its draft waits underneath.
    pub(crate) fn render_archived_composer(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        if !self.open_conversation_archived() {
            return None;
        }
        let saving = match self.chat.as_ref().map(|chat| &chat.target) {
            Some(Target::Conversation { thread, .. }) => self.conversations.saving(thread),
            _ => false,
        };
        Some(
            div().w_full().flex().justify_center().px_5().pb_4().child(
                div()
                    .w_full()
                    .max_w(crate::theme::CHAT_COLUMN)
                    .min_h(px(52.))
                    .pl_4()
                    .pr_2()
                    .flex()
                    .items_center()
                    .gap_3()
                    .rounded(px(26.))
                    .bg(theme.composer)
                    .border_1()
                    .border_color(theme.ink_at(0.06))
                    .child(icon("archive", px(16.), theme.ink_secondary))
                    .child(
                        div().flex_1().body().text_color(theme.ink_secondary).child("This conversation is archived."),
                    )
                    .child(
                        crate::ui::pill_button(
                            "restore-conversation",
                            "Restore",
                            crate::ui::Tone::Quiet,
                            !saving,
                            theme,
                        )
                        .on_click(cx.listener(|this, _, window, cx| this.restore_open_conversation(window, cx))),
                    ),
            ),
        )
    }
}
