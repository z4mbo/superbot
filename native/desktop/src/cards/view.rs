use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::state::{Field, Turn};
use super::{chosen_option, Choice, Question, QuestionKind, Reply, Settled};
use crate::app::Desktop;
use crate::theme::{radius, Theme};
use crate::transcript::{Entry, Part};
use crate::ui::{field_box, icon, pill_button, Tone, Type};

const NOT_YOURS: &str = "Only the person who started this run can answer it.";
const CLOSED: &str = "No longer waiting for an answer.";

impl Desktop {
    /// Gives each open card that takes typing its field, before the transcript is drawn.
    pub fn prepare_cards(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let me = self.me.as_ref().map(|me| me.user_id.clone());
        let Some(chat) = self.chat.as_mut() else { return };
        let cards = &mut chat.cards;
        let wanted: Vec<(String, bool, &'static str)> = chat
            .entries
            .iter()
            .flat_map(|entry| entry.parts.iter().map(move |part| (entry, part)))
            .filter_map(|(entry, part)| {
                let Part::Question(question) = part else { return None };
                let open = question.settled.is_none() && !cards.sent.contains_key(&entry.id);
                let yours = cards.turn(&entry.id, entry.run_id.as_deref(), me.as_deref()) == Turn::Yours;
                let (secret, placeholder) = match &question.kind {
                    QuestionKind::Typed => (false, "Your answer"),
                    QuestionKind::Secret(ask) => (true, ask.label),
                    QuestionKind::Options(_) => return None,
                };
                (open && yours).then(|| (entry.id.clone(), secret, placeholder))
            })
            .collect();
        cards.fields.retain(|id, _| wanted.iter().any(|(wanted_id, _, _)| id == wanted_id));
        for (message_id, secret, placeholder) in wanted {
            if cards.fields.contains_key(&message_id) || cards.busy.contains(&message_id) {
                continue;
            }
            let input = cx.new(|cx| InputState::new(window, cx).masked(secret).placeholder(placeholder));
            let sent = message_id.clone();
            let enter = cx.subscribe_in(&input, window, move |this, _, event: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    this.send_field(&sent, window, cx);
                }
            });
            cards.fields.insert(message_id, Field { input, _enter: enter });
        }
    }

    /// Sends what a card's field holds.
    fn send_field(&mut self, message_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(chat) = self.chat.as_ref() else { return };
        let Some(entry) = chat.entries.iter().find(|entry| entry.id == message_id) else { return };
        let Some(run_id) = entry.run_id.clone() else { return };
        let Some(question) = entry.parts.iter().find_map(|part| match part {
            Part::Question(question) => Some(question),
            _ => None,
        }) else {
            return;
        };
        let Some(field) = chat.cards.fields.get(message_id) else { return };
        let value = field.input.read(cx).value();
        let reply = match question.kind {
            QuestionKind::Typed => {
                let typed = value.trim();
                if typed.is_empty() {
                    return;
                }
                Reply::Text(typed.to_owned())
            }
            QuestionKind::Secret(_) => {
                if value.is_empty() {
                    return;
                }
                Reply::Secret(value.to_string())
            }
            QuestionKind::Options(_) => return,
        };
        self.answer_question(run_id, message_id.to_owned(), reply, window, cx);
    }

    pub fn render_question(
        &self,
        entry: &Entry,
        question: &Question,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(chat) = self.chat.as_ref() else { return div().into_any_element() };
        let cards = &chat.cards;
        let me = self.me.as_ref().map(|me| me.user_id.as_str());
        let settled = question.settled.as_ref().or_else(|| cards.sent.get(&entry.id)).cloned();
        let turn = cards.turn(&entry.id, entry.run_id.as_deref(), me);
        let busy = cards.busy.contains(&entry.id);
        let problem = cards.problems.get(&entry.id).cloned();
        let field = cards.fields.get(&entry.id).map(|field| field.input.clone());
        let id = entry.id.clone();
        let run_id = entry.run_id.clone();

        let detail = question.detail.clone().map(|detail| {
            let shown = div().px_2p5().py_2().rounded(radius::FIELD).line_clamp(8).child(detail);
            if question.detail_code {
                shown.bg(theme.inset).font_family(theme.mono.clone()).meta().text_color(theme.ink)
            } else {
                shown.px_0().py_0().body().text_color(theme.ink_secondary)
            }
        });
        let waiting_note = (settled.is_none()).then(|| match turn {
            Turn::Yours => None,
            Turn::Theirs => Some(NOT_YOURS),
            Turn::Closed => Some(CLOSED),
        });

        let body = match &question.kind {
            QuestionKind::Typed => match &settled {
                Some(Settled::Answered(answer)) if !answer.is_empty() => Some(quote(answer, theme).into_any_element()),
                Some(other) => Some(outcome(other, theme).into_any_element()),
                None => field.filter(|_| turn == Turn::Yours).map(|field| {
                    let message_id = id.clone();
                    send_row(&id, &field, "Send", busy, theme, send_click(message_id, cx)).into_any_element()
                }),
            },
            QuestionKind::Options(options) => {
                let chosen = match &settled {
                    Some(Settled::Answered(answer)) => chosen_option(answer, options).map(|option| option.id.clone()),
                    _ => None,
                };
                let open = settled.is_none() && turn == Turn::Yours && !busy;
                Some(
                    div()
                        .flex()
                        .flex_col()
                        .gap_0p5()
                        .children(options.iter().enumerate().map(|(index, option)| {
                            let (run_id, message_id, answer) = (run_id.clone(), id.clone(), option.id.clone());
                            option_row(
                                SharedString::from(format!("option-{id}-{index}")),
                                &letter(index),
                                &option.label,
                                chosen.as_deref() == Some(option.id.as_str()),
                                open,
                                theme,
                            )
                            .when(open, |row| {
                                row.on_click(cx.listener(move |this, _, window, cx| {
                                    if let Some(run_id) = run_id.clone() {
                                        this.answer_question(
                                            run_id,
                                            message_id.clone(),
                                            Reply::Option(answer.clone()),
                                            window,
                                            cx,
                                        );
                                    }
                                }))
                            })
                        }))
                        .into_any_element(),
                )
            }
            QuestionKind::Secret(ask) => match &settled {
                Some(other) => Some(outcome(other, theme).into_any_element()),
                None => field.filter(|_| turn == Turn::Yours).map(|field| {
                    let dismiss_id = id.clone();
                    let dismiss_run = run_id.clone();
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(send_row(&id, &field, "Send", busy, theme, send_click(id.clone(), cx)))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(icon("lock", px(12.), theme.ink_tertiary))
                                .child(div().flex_1().meta().text_color(theme.ink_tertiary).child(if ask.one_time {
                                    "Used once and not saved. It never appears in the chat."
                                } else {
                                    "Saved for this agent. It never appears in the chat."
                                }))
                                .child(
                                    pill_button(
                                        SharedString::from(format!("dismiss-{id}")),
                                        "Dismiss",
                                        Tone::Quiet,
                                        !busy,
                                        theme,
                                    )
                                    .h_7()
                                    .on_click(cx.listener(
                                        move |this, _, window, cx| {
                                            if let Some(run_id) = dismiss_run.clone() {
                                                this.answer_question(
                                                    run_id,
                                                    dismiss_id.clone(),
                                                    Reply::DismissSecret,
                                                    window,
                                                    cx,
                                                );
                                            }
                                        },
                                    )),
                                ),
                        )
                        .into_any_element()
                }),
            },
        };
        let destination = match &question.kind {
            QuestionKind::Secret(ask) => ask.destination.clone(),
            _ => None,
        };

        crate::ui::chat::card(theme)
            .id(SharedString::from(format!("question-{id}")))
            .w(px(440.))
            .gap_2p5()
            .when(settled.is_some() && matches!(question.kind, QuestionKind::Options(_)), |card| card.opacity(0.7))
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap_2()
                    .when(matches!(question.kind, QuestionKind::Secret(_)), |row| {
                        row.child(icon("key-round", px(16.), theme.ink_secondary).mt(px(3.)))
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap_0p5()
                            .child(div().bubble().child(question.text.clone()))
                            .children(destination.map(|line| div().meta().text_color(theme.ink_tertiary).child(line))),
                    ),
            )
            .children(detail)
            .children(body)
            .children(waiting_note.flatten().map(|note| div().body().text_color(theme.ink_tertiary).child(note)))
            .children(problem.map(|problem| div().meta().text_color(theme.danger).child(problem)))
            .into_any_element()
    }

    pub fn render_choice(&self, entry: &Entry, choice: &Choice, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(chat) = self.chat.as_ref() else { return div().into_any_element() };
        let cards = &chat.cards;
        let local = cards.sent.get(&entry.id);
        if matches!(local, Some(Settled::Dismissed)) {
            return div().into_any_element();
        }
        let chosen = match local {
            Some(Settled::Answered(id)) => Some(id.clone()),
            _ => choice.chosen.clone(),
        };
        let busy = cards.busy.contains(&entry.id);
        let bot_id = entry.agent_id.clone().or_else(|| match &chat.target {
            crate::api::Target::Agent(id) | crate::api::Target::Conversation { agent: id, .. } => Some(id.clone()),
            crate::api::Target::Group(_) => None,
        });
        let open = chosen.is_none() && !busy && bot_id.is_some();
        let id = entry.id.clone();
        let dismiss = {
            let (bot_id, message_id) = (bot_id.clone(), id.clone());
            div()
                .id(SharedString::from(format!("choice-dismiss-{id}")))
                .size_6()
                .flex_shrink_0()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover(|style| style.bg(theme.raised))
                .child(icon("x", px(14.), theme.ink_tertiary))
                .on_click(cx.listener(move |this, _, window, cx| {
                    if let Some(bot_id) = bot_id.clone() {
                        this.choose_focus(bot_id, message_id.clone(), None, window, cx);
                    }
                }))
        };
        crate::ui::chat::card(theme)
            .w(px(440.))
            .gap_2()
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap_0p5()
                            .child(div().bubble().child(choice.question.clone()))
                            .children(
                                choice
                                    .subtitle
                                    .clone()
                                    .map(|line| div().body().text_color(theme.ink_secondary).child(line)),
                            ),
                    )
                    .when(open, |row| row.child(dismiss)),
            )
            .child(div().flex().flex_col().gap_0p5().children(choice.options.iter().map(|option| {
                let (bot_id, message_id, option_id) = (bot_id.clone(), id.clone(), option.id.clone());
                option_row(
                    SharedString::from(format!("choice-{id}-{}", option.id)),
                    &option.letter,
                    &option.label,
                    chosen.as_deref() == Some(option.id.as_str()),
                    open,
                    theme,
                )
                .when(open, |row| {
                    row.on_click(cx.listener(move |this, _, window, cx| {
                        if let Some(bot_id) = bot_id.clone() {
                            this.choose_focus(bot_id, message_id.clone(), Some(option_id.clone()), window, cx);
                        }
                    }))
                })
            })))
            .children(
                cards
                    .problems
                    .get(&entry.id)
                    .cloned()
                    .map(|problem| div().meta().text_color(theme.danger).child(problem)),
            )
            .into_any_element()
    }
}

/// The Send button's handler for a card's field.
fn send_click(message_id: String, cx: &mut Context<Desktop>) -> Box<dyn Fn(&ClickEvent, &mut Window, &mut App)> {
    Box::new(cx.listener(move |this, _, window, cx| this.send_field(&message_id, window, cx)))
}

fn send_row(
    id: &str,
    field: &Entity<InputState>,
    label: &'static str,
    busy: bool,
    theme: &Theme,
    send: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Div {
    div()
        .flex()
        .items_center()
        .gap_2()
        .child(field_box(theme).flex_1().min_w_0().child(Input::new(field).appearance(false).bordered(false)))
        .child(
            pill_button(
                SharedString::from(format!("send-{id}")),
                if busy { "Sending…" } else { label },
                Tone::Primary,
                !busy,
                theme,
            )
            .on_click(send),
        )
}

fn option_row(id: SharedString, letter: &str, label: &str, chosen: bool, open: bool, theme: &Theme) -> Stateful<Div> {
    let hover = theme.raised;
    div()
        .id(id)
        .min_h_9()
        .px_2()
        .py_1()
        .flex()
        .items_center()
        .gap_2p5()
        .rounded(radius::FIELD)
        .when(chosen, |row| row.bg(theme.raised))
        .when(open, |row| row.cursor_pointer().hover(move |style| style.bg(hover)))
        .child(
            div()
                .size_6()
                .flex_shrink_0()
                .rounded(px(6.))
                .flex()
                .items_center()
                .justify_center()
                .border_1()
                .border_color(theme.hairline)
                .meta()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink_secondary)
                .child(letter.to_owned()),
        )
        .child(div().flex_1().min_w_0().body().text_color(theme.ink).child(label.to_owned()))
        .when(chosen, |row| row.child(icon("check", px(14.), theme.ink)))
}

fn letter(index: usize) -> String {
    char::from_u32('A' as u32 + index as u32 % 26).map_or_else(String::new, String::from)
}

fn quote(answer: &str, theme: &Theme) -> Div {
    div()
        .pl_3()
        .border_l_2()
        .border_color(theme.hairline)
        .body()
        .text_color(theme.ink_secondary)
        .child(answer.to_owned())
}

fn outcome(settled: &Settled, theme: &Theme) -> Div {
    let (glyph, words) = match settled {
        Settled::Saved => (true, "Saved"),
        Settled::Sent => (true, "Sent"),
        Settled::Answered(_) => (true, "Answered"),
        Settled::Dismissed => (false, "Dismissed"),
        Settled::Expired => (false, "Expired"),
    };
    div()
        .flex()
        .items_center()
        .gap_1p5()
        .body()
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.ink_tertiary)
        .when(glyph, |row| row.child(icon("check", px(14.), theme.ink_tertiary)))
        .child(words)
}
