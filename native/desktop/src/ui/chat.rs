use chrono::Local;
use gpui_kit::component::input::{Enter, Escape, IndentInline, MoveDown, MoveUp, Textarea};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::text::TextView;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::{GroupMember, Target};
use crate::app::conversation::{FileState, MentionList};
use crate::app::{Desktop, DialogKind, View};
use crate::clock;
use crate::files;
use crate::outbox::{self, Attachment};
use crate::theme::{mix, radius, ActiveTheme, Theme, BUBBLE_MAX, CAPTION_WIDTH, CHAT_COLUMN};
use crate::transcript::{place, Entry, FileRef, Join, Part, Place, Speaker};
use crate::ui::{agent_face, error_line, icon, pill_button, Tone, Type};

impl Desktop {
    pub fn render_chat(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let Some(chat) = self.chat.as_ref() else {
            return self.render_no_conversation(&theme, cx);
        };
        let target = chat.target.clone();
        let quiet = chat.entries.is_empty()
            && chat.draft.is_empty()
            && !chat.working
            && !chat.loading
            && chat.error.is_none()
            && chat.conversation.older.is_none();
        let transcript = if quiet {
            let name = self.target_name(&target);
            div()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_3()
                .child(self.target_face(&target, px(56.), &theme))
                .child(
                    div()
                        .item()
                        .text_color(theme.ink_secondary)
                        .child(format!("Say what you need and {name} gets to work.")),
                )
                .into_any_element()
        } else {
            list(chat.list.clone(), cx.processor(|this, index: usize, _, cx| this.render_row(index, cx)))
                .size_full()
                .into_any_element()
        };

        div()
            .size_full()
            .flex()
            .flex_col()
            .child(self.render_chat_header(&target, &theme, cx))
            .child(div().flex_1().min_h_0().child(transcript))
            .child(self.render_composer(&target, &theme, cx))
            .into_any_element()
    }

    fn render_no_conversation(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(div().h(px(52.)).window_control_area(WindowControlArea::Drag))
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
                    .child(pill_button("first-agent", "New agent", Tone::Primary, true, theme).on_click(
                        cx.listener(|this, _, window, cx| this.open_dialog(DialogKind::NewAgent, window, cx)),
                    )),
            )
            .into_any_element()
    }

    fn render_chat_header(&mut self, target: &Target, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let name = self.target_name(target);
        let hover = theme.elevated_hover();
        div()
            .flex()
            .items_center()
            .justify_center()
            .px_5()
            .py_2p5()
            .window_control_area(WindowControlArea::Drag)
            .child(div().w(CAPTION_WIDTH).flex_shrink_0())
            .child(
                div().flex_1().min_w_0().flex().justify_center().child(
                    div()
                        .id("chat-head")
                        .max_w_full()
                        .flex()
                        .items_center()
                        .gap_2()
                        .py(px(8.5))
                        .pl_2p5()
                        .pr_3p5()
                        .rounded_full()
                        .bg(theme.composer)
                        .border_1()
                        .border_color(theme.ink_at(0.06))
                        .cursor_pointer()
                        .occlude()
                        .hover(move |style| style.bg(hover))
                        .on_click(cx.listener(|this, _, window, cx| this.show(View::Workspace, window, cx)))
                        .child(self.target_face(target, px(22.), theme))
                        .child(div().name().truncate().child(name)),
                ),
            )
            .child(div().w(CAPTION_WIDTH).flex_shrink_0())
    }

    pub fn target_face(&self, target: &Target, size: Pixels, theme: &Theme) -> Div {
        match target {
            Target::Agent(id) => {
                let color = self.agent(id).map(|agent| agent.color.clone()).unwrap_or_default();
                agent_face(theme.identity_for(&color), size)
            }
            Target::Group(id) => {
                let colors: Vec<_> = self
                    .groups()
                    .iter()
                    .find(|group| &group.id == id)
                    .map(|group| group.members.iter().take(2).map(|member| theme.identity_for(&member.color)).collect())
                    .unwrap_or_default();
                let face = size * 0.68;
                div().size(size).flex_shrink_0().relative().children(colors.into_iter().enumerate().map(
                    |(index, color)| {
                        let offset = if index == 0 { px(0.) } else { size - face };
                        agent_face(color, face).absolute().left(offset).top(offset)
                    },
                ))
            }
        }
    }

    /// The list's rows: the head row, one per message, then what is happening now.
    fn render_row(&mut self, row: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let Some(chat) = self.chat.as_ref() else { return div().into_any_element() };
        let content = match row.checked_sub(1) {
            None => self.render_head(&theme, cx),
            Some(index) => match chat.entries.get(index) {
                Some(entry) => {
                    let place = place(&chat.entries, index, &Local);
                    self.render_entry(entry, place, index, &theme, cx)
                }
                None => self.render_now(&theme, cx),
            },
        };
        div()
            .id(("row", row))
            .w_full()
            .flex()
            .justify_center()
            .px_5()
            .child(div().w_full().max_w(CHAT_COLUMN).child(content))
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

    fn render_entry(
        &self,
        entry: &Entry,
        place: Place,
        index: usize,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let chat = self.chat.as_ref();
        let in_group = chat.is_some_and(|chat| matches!(chat.target, Target::Group(_)));
        let members: &[GroupMember] = chat.map_or(&[], |chat| &chat.conversation.members);
        let join = place.join;
        let mine = entry.speaker == Speaker::Person
            && entry.name.as_deref().is_none_or(|name| self.me.as_ref().is_some_and(|me| me.name == name));
        let agent = entry.agent_id.as_deref().and_then(|id| self.agent(id));
        let voice = if join.above {
            None
        } else {
            match entry.speaker {
                Speaker::Agent if in_group => agent.map(|agent| (agent.name.clone(), theme.identity_for(&agent.color))),
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
                let bubble = bubble(text, mine, entry.speaker, join, key, &named, theme);
                match said.clone() {
                    Some(said) => div()
                        .id(("said", index * 64 + part_index))
                        .max_w_full()
                        .tooltip(move |window, cx| Tooltip::new(said.clone()).build(window, cx))
                        .child(bubble)
                        .into_any_element(),
                    None => bubble,
                }
            }
            Part::Note(text) | Part::Steps(text) => div()
                .w_full()
                .flex()
                .justify_center()
                .child(div().meta().text_color(theme.ink_tertiary).child(text.clone()))
                .into_any_element(),
            Part::File(file) => self.render_file(file, (index, part_index), theme, cx),
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
            Part::Elsewhere(kind) => card(theme)
                .flex_row()
                .items_center()
                .gap_3()
                .child(div().body().text_color(theme.ink_secondary).child(*kind))
                .child(self.open_on_web("Open on the web", theme, cx))
                .into_any_element(),
        });

        div()
            .flex()
            .flex_col()
            .children(stamp)
            .child(
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
                    .children(parts),
            )
            .into_any_element()
    }

    /// A file a message carries: what it is, and the two things to do with it. Opening is
    /// offered only for kinds the system's viewer shows without running anything.
    fn render_file(&self, file: &FileRef, key: (usize, usize), theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let state = self.chat.as_ref().and_then(|chat| chat.conversation.files.get(&file.artifact_id));
        let fetching = state == Some(&FileState::Fetching);
        let problem = match state {
            Some(FileState::Problem(problem)) => Some(problem.clone()),
            _ => None,
        };
        let glyph = if files::is_image(&file.mime_type) { "image" } else { "file-text" };
        let kind = file.name.rsplit_once('.').map(|(_, extension)| extension.to_ascii_uppercase());
        let detail: Vec<String> = kind.into_iter().chain(file.size.map(files::size_label)).collect();
        let hover = theme.ink_at(0.06);
        let action = |label: &'static str, open: bool, cx: &mut Context<Self>| {
            let file = file.clone();
            div()
                .id((label, key.0 * 64 + key.1))
                .h_7()
                .px_2p5()
                .flex()
                .items_center()
                .rounded_full()
                .body()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.accent_text)
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .on_click(cx.listener(move |this, _, window, cx| this.fetch_file(file.clone(), open, window, cx)))
                .child(label)
        };
        let actions = if fetching {
            div().px_2().child(Spinner::new().with_size(px(14.)).color(theme.ink_tertiary))
        } else {
            div()
                .flex()
                .items_center()
                .when(files::opens_as(&file.mime_type).is_some(), |actions| actions.child(action("Open", true, cx)))
                .child(action("Save", false, cx))
        };
        card(theme)
            .w_full()
            .max_w(px(380.))
            .gap_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2p5()
                    .child(
                        div()
                            .size_9()
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(radius::FIELD)
                            .bg(theme.ink_at(0.06))
                            .child(icon(glyph, px(16.), theme.ink_secondary)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(div().body().font_weight(FontWeight::MEDIUM).truncate().child(file.name.clone()))
                            .when(!detail.is_empty(), |text| {
                                text.child(div().meta().text_color(theme.ink_tertiary).child(detail.join(" · ")))
                            }),
                    )
                    .child(actions.flex_shrink_0()),
            )
            .children(problem.map(|problem| div().meta().text_color(theme.danger).child(problem)))
            .into_any_element()
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
        let Some(chat) = self.chat.as_ref() else { return div().into_any_element() };
        let last = chat.entries.len();
        div()
            .pb_4()
            .flex()
            .flex_col()
            .items_start()
            .when(!chat.draft.is_empty(), |row| {
                let draft = bubble(&chat.draft, false, Speaker::Agent, Join::default(), (last, 0), &[], theme);
                row.child(div().pt_4().w_full().flex().child(draft))
            })
            .when(chat.working, |row| {
                let activity = chat.activity.clone().unwrap_or_else(|| "Working…".into());
                row.child(
                    div()
                        .pt_3()
                        .px_1()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(div().size_2().rounded_full().bg(theme.success))
                        .child(div().body().text_color(theme.ink_tertiary).truncate().child(activity)),
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

    fn render_composer(&mut self, target: &Target, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let chat = self.chat.as_ref();
        let working = chat.is_some_and(|chat| chat.working);
        let loading = chat.is_some_and(|chat| chat.loading);
        let outbox = chat.map(|chat| &chat.conversation.outbox);
        let sending = outbox.is_some_and(|outbox| outbox.sending);
        let attachments: Vec<Attachment> = outbox.map(|outbox| outbox.attachments.clone()).unwrap_or_default();
        let problem = outbox.and_then(|outbox| outbox.problem.clone());
        let has_text = !self.composer.read(cx).value().trim().is_empty();
        let multiline = self.composer.read(cx).value().contains('\n');
        let needs_model = self.me.as_ref().is_some_and(|me| me.needs_model);
        let identity = match target {
            Target::Agent(id) => {
                theme.identity_for(&self.agent(id).map(|agent| agent.color.clone()).unwrap_or_default())
            }
            Target::Group(_) => theme.ink,
        };
        let has_content = has_text || !attachments.is_empty();
        let stopping = working && !has_content && !sending;
        let ready = has_content && !sending && !loading;
        let (fill, ink) = if stopping {
            (theme.ink, theme.app)
        } else if has_content {
            match target {
                Target::Agent(_) => (identity, gpui_kit::white()),
                Target::Group(_) => (theme.ink, theme.app),
            }
        } else {
            (theme.raised_hover, theme.ink_secondary)
        };
        let pressed = mix(fill, theme.app, 0.14);
        let ring = theme.ink_at(0.1);
        let quiet_hover = theme.ink_at(0.08);
        let mentions = self.mention_list(cx);

        let tray = (!attachments.is_empty()).then(|| {
            div().flex().flex_wrap().gap_2().children(attachments.iter().map(|attached| {
                let id = attached.id;
                let glyph = if files::is_image(attached.mime_type) { "image" } else { "file-text" };
                let detail = if sending { "Sending…".to_owned() } else { files::size_label(attached.size) };
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .h(px(44.))
                    .pl_2p5()
                    .pr_1p5()
                    .rounded(radius::CARD)
                    .bg(theme.control)
                    .child(icon(glyph, px(16.), theme.ink_secondary))
                    .child(
                        div()
                            .max_w(px(200.))
                            .flex()
                            .flex_col()
                            .child(div().meta().font_weight(FontWeight::MEDIUM).truncate().child(attached.name.clone()))
                            .child(div().meta().text_color(theme.ink_tertiary).child(detail)),
                    )
                    .when(!sending, |chip| {
                        chip.child(
                            div()
                                .id(("detach", id as usize))
                                .size_6()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_full()
                                .cursor_pointer()
                                .hover(move |style| style.bg(quiet_hover))
                                .tooltip(|window, cx| Tooltip::new("Remove").build(window, cx))
                                .on_click(cx.listener(move |this, _, _, cx| this.detach_file(id, cx)))
                                .child(icon("x", px(12.), theme.ink_secondary)),
                        )
                    })
                    .when(sending, |chip| chip.pr_2p5())
            }))
        });

        let attach = div()
            .id("attach")
            .size_7()
            .mb(px(2.))
            .flex_shrink_0()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(theme.ink_at(0.04))
            .tooltip(|window, cx| Tooltip::new("Attach files").build(window, cx))
            .when(sending, |attach| attach.opacity(0.5))
            .when(!sending, |attach| {
                attach
                    .cursor_pointer()
                    .hover(move |style| style.bg(quiet_hover))
                    .on_click(cx.listener(|this, _, window, cx| this.attach_files(window, cx)))
            })
            .child(icon("plus", px(16.), theme.ink_tertiary));

        let send = div()
            .id("send")
            .size_8()
            .flex_shrink_0()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(fill)
            .when(stopping || ready, |send| {
                send.cursor_pointer().hover(move |style| style.bg(pressed)).on_click(cx.listener(
                    move |this, _, window, cx| {
                        if stopping {
                            this.stop(window, cx)
                        } else {
                            this.send(window, cx)
                        }
                    },
                ))
            })
            .child(if sending {
                Spinner::new().with_size(px(16.)).color(ink).into_any_element()
            } else if stopping {
                div().size(px(10.)).rounded(px(2.)).bg(ink).into_any_element()
            } else {
                icon("arrow-up", px(16.), ink).into_any_element()
            });

        let field = Textarea::new(&self.composer).small().appearance(false).bordered(false).disabled(sending);
        let pill = div()
            .flex()
            .flex_col()
            .gap_2()
            .px(px(9.))
            .pt(px(7.))
            .pb(px(9.))
            .rounded(if multiline || tray.is_some() { radius::BUBBLE } else { radius::COMPOSER })
            .bg(theme.composer)
            .border_1()
            .border_color(ring)
            .children(tray)
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap_1p5()
                    .child(attach)
                    .child(div().flex_1().min_w_0().py(px(2.)).child(field))
                    .child(send),
            );

        // While the `@` list is open the keys that move through it and choose from it are taken
        // before the text field sees them.
        let composer = div()
            .relative()
            .capture_action(cx.listener(|this, _: &MoveUp, _, cx| {
                if this.move_mention(false, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &MoveDown, _, cx| {
                if this.move_mention(true, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Enter, window, cx| {
                if this.pick_mention(None, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &IndentInline, window, cx| {
                if this.pick_mention(None, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Escape, _, cx| {
                if this.close_mention(cx) {
                    cx.stop_propagation();
                }
            }))
            .children(mentions.map(|list| deferred(self.render_mentions(&list, theme, cx)).with_priority(1)))
            .child(pill);

        div().w_full().flex().justify_center().px_5().pb_4().child(
            div()
                .w_full()
                .max_w(CHAT_COLUMN)
                .flex()
                .flex_col()
                .gap_2()
                .when(needs_model, |dock| {
                    dock.child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .px_3()
                            .py_2()
                            .rounded(radius::CARD)
                            .bg(theme.warning.opacity(0.1))
                            .body()
                            .text_color(theme.warning)
                            .child(div().flex_1().child("Connect an AI model so your agents can reply."))
                            .child(self.open_on_web("Connect on the web", theme, cx)),
                    )
                })
                .children(problem.map(|problem| error_line(problem, theme)))
                .child(composer),
        )
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
                    .child(agent_face(theme.identity_for(&member.color), px(20.)))
                    .child(div().flex_1().min_w_0().truncate().child(member.name.clone()))
            }))
    }
}

fn card(theme: &Theme) -> Div {
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
    speaker: Speaker,
    join: Join,
    key: (usize, usize),
    named: &[std::ops::Range<usize>],
    theme: &Theme,
) -> AnyElement {
    let (fill, ink) = if mine { (theme.bubble_user, theme.bubble_user_ink) } else { (theme.card, theme.ink) };
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
    match speaker {
        // What a bot writes is Markdown; what a person types is shown as typed.
        Speaker::Agent => shape
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
