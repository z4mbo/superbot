use gpui_kit::prelude::*;
use gpui_kit::{div, px, Div, SharedString, Window};
use superbot_features::{Ticket, TicketPriority, TicketStatus};

use super::edit::{Changes, Fields};
use super::{Gate, Mode};
use crate::format::relative;
use crate::icons::{icon, Glyph};
use crate::panel::{detail_header, placeholder, section_header, WorkspacePanel};
use crate::theme::{tokens, Tokens};
use crate::ui::{self, Action, Row, Tone};

impl WorkspacePanel {
    pub(crate) fn render_board(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let t = tokens(cx);
        if let Gate::Off { labs } = self.board.gate.clone() {
            return self.render_board_off(
                labs.as_ref().map(|labs| labs.board_switchable()),
                &t,
                cx,
            );
        }
        match self.board.mode.clone() {
            Mode::List => self.render_ticket_list(&t, cx),
            Mode::Create => self.render_ticket_form(None, &t, window, cx),
            Mode::Edit(_) => {
                let ticket = self.board.base.clone();
                self.render_ticket_form(ticket, &t, window, cx)
            }
        }
    }

    fn web_action(&self, cx: &mut Context<Self>) -> Action {
        Action::icon(
            "board-web",
            Glyph::ExternalLink,
            "Open the board on the web",
        )
        .on_click(cx.listener(|panel, _, _, cx| panel.open_board_on_web(cx)))
    }

    fn render_board_off(
        &self,
        switchable: Option<bool>,
        t: &Tokens,
        cx: &mut Context<Self>,
    ) -> Div {
        let header = section_header("Board", None, t);
        let body = match switchable {
            None => ui::loading_line(t),
            Some(true) => ui::notice(
                "Board is a Labs feature and it is off for your account.",
                Some(
                    Action::new("board-turn-on", "Turn on Board")
                        .tone(Tone::Link)
                        .small()
                        .busy(self.board.switching_lab)
                        .on_click(
                            cx.listener(|panel, _, window, cx| panel.turn_board_on(window, cx)),
                        ),
                ),
                t,
            ),
            Some(false) => ui::notice("Board isn't available on this server.", None, t),
        };
        div()
            .flex()
            .flex_col()
            .child(header)
            .child(body)
            .when_some(self.board.problem.clone(), |this, problem| {
                this.child(ui::problem_line(problem, t))
            })
    }

    fn owner_name(&self, ticket: &Ticket) -> Option<SharedString> {
        self.bot_name(ticket.assignee_bot_id.as_deref()?)
    }

    fn render_ticket_list(&mut self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let no_bots = self.bots.value.as_ref().is_some_and(Vec::is_empty);
        let new_ticket = Action::new("new-ticket", "New ticket")
            .tone(Tone::Primary)
            .glyph(Glyph::Plus)
            .disabled(self.bots.value.is_none() || no_bots)
            .on_click(cx.listener(|panel, _, window, cx| panel.start_new_ticket(window, cx)));
        let header = section_header("Board", [self.web_action(cx), new_ticket], t);
        let retry = Action::new("retry-tickets", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_tickets(window, cx)));
        let list = match placeholder(&self.board.tickets, "load the board", retry, t) {
            Some(placeholder) => placeholder,
            None => {
                let tickets = self.board.tickets.value.as_deref().unwrap_or_default();
                if tickets.is_empty() {
                    ui::notice(
                        if no_bots {
                            "Tickets are owned by a bot. Create a bot first."
                        } else {
                            "No tickets yet."
                        },
                        None,
                        t,
                    )
                } else {
                    div().flex().flex_col().gap_4().children(
                        TicketStatus::ALL.into_iter().filter_map(|status| {
                            let column: Vec<&Ticket> = tickets
                                .iter()
                                .filter(|ticket| ticket.status == status)
                                .collect();
                            (!column.is_empty())
                                .then(|| self.render_status_group(status, &column, t, cx))
                        }),
                    )
                }
            }
        };
        div()
            .flex()
            .flex_col()
            .child(header)
            .when_some(self.board.problem.clone(), |this, problem| {
                this.child(div().pb_3().child(ui::problem_line(problem, t)))
            })
            .child(list)
    }

    fn render_status_group(
        &self,
        status: TicketStatus,
        tickets: &[&Ticket],
        t: &Tokens,
        cx: &mut Context<Self>,
    ) -> Div {
        div()
            .flex()
            .flex_col()
            .child(ui::group_label(
                format!("{} · {}", status.label(), tickets.len()),
                t,
            ))
            .children(tickets.iter().map(|ticket| {
                let id = ticket.id.clone();
                let mut detail = vec![ticket.reference.clone()];
                if let Some(owner) = self.owner_name(ticket) {
                    detail.push(owner.to_string());
                }
                if ticket.priority != TicketPriority::Normal {
                    detail.push(format!("{} priority", ticket.priority.label()));
                }
                detail.push(format!("updated {}", relative(&ticket.updated_at)));
                Row::new(
                    SharedString::from(format!("ticket-{}", ticket.id)),
                    ticket.title.clone(),
                )
                .leading(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(40.))
                        .child(icon(
                            status_glyph(ticket.status),
                            16.,
                            status_color(ticket.status, t),
                        )),
                )
                .detail(detail.join(" · "))
                .trailing(icon(Glyph::ChevronRight, 16., t.ink_tertiary))
                .on_click(cx.listener(move |panel, _, window, cx| {
                    panel.open_ticket(id.clone(), window, cx)
                }))
            }))
    }

    fn render_ticket_form(
        &mut self,
        ticket: Option<Ticket>,
        t: &Tokens,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let view = &self.board;
        let fields = view.fields(cx);
        let incomplete = fields.title.trim().is_empty() || fields.owner.is_none();
        let back = Action::icon("board-back", Glyph::ChevronLeft, "Back to the board").on_click(
            cx.listener(|panel, _, _, cx| {
                panel.board.close();
                cx.notify();
            }),
        );
        let title: SharedString = match &ticket {
            Some(ticket) => ticket.title.clone().into(),
            None => "New ticket".into(),
        };
        let submit = match &ticket {
            Some(ticket) => Action::new("save-ticket", "Save")
                .tone(Tone::Primary)
                .disabled(incomplete || Changes::between(&fields, &Fields::of(ticket)).is_empty())
                .busy(view.saving)
                .on_click(cx.listener(|panel, _, window, cx| panel.save_ticket(window, cx))),
            None => Action::new("create-ticket", "Create ticket")
                .tone(Tone::Primary)
                .disabled(incomplete)
                .busy(view.saving)
                .on_click(cx.listener(|panel, _, window, cx| panel.create_ticket(window, cx))),
        };
        let bots = self.bots.value.as_deref().unwrap_or_default();
        let owners = div()
            .flex()
            .flex_wrap()
            .gap_1()
            .children(bots.iter().map(|bot| {
                let id = bot.id.clone();
                Action::new(
                    SharedString::from(format!("ticket-owner-{}", bot.id)),
                    bot.name.clone(),
                )
                .small()
                .selected(fields.owner.as_deref() == Some(bot.id.as_str()))
                .on_click(cx.listener(move |panel, _, _, cx| {
                    panel.board.owner = Some(id.clone());
                    cx.notify();
                }))
            }));
        let priorities =
            div()
                .flex()
                .flex_wrap()
                .gap_1()
                .children(TicketPriority::ALL.into_iter().map(|priority| {
                    Action::new(
                        SharedString::from(format!("ticket-priority-{priority:?}")),
                        priority.label(),
                    )
                    .small()
                    .selected(fields.priority == priority)
                    .on_click(cx.listener(move |panel, _, _, cx| {
                        panel.board.priority = priority;
                        cx.notify();
                    }))
                }));
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(detail_header(title, back, [self.web_action(cx)], t).pb_0())
            .when_some(ticket.as_ref(), |this, ticket| {
                this.child(ui::meta(
                    format!("{} · opened {} · updated {}", ticket.reference, relative(&ticket.created_at), relative(&ticket.updated_at)),
                    t,
                ))
                .child(ui::labelled("Status", self.render_status_picker(ticket, cx), None, cx))
            })
            .when_some(view.changed_elsewhere, |this, conflict| {
                this.child(ui::body(
                    if conflict {
                        "Someone else changed a field you're editing. Saving keeps your version."
                    } else {
                        "Someone else changed this ticket. Fields you haven't edited show their version."
                    },
                    if conflict { t.warning } else { t.ink_secondary },
                ))
            })
            .child(ui::labelled("Title", ui::text_field(&view.title, "Title", false, window, cx), None, cx))
            .child(ui::labelled(
                "Description",
                ui::text_area(&view.description, "Description", false, window, cx),
                None,
                cx,
            ))
            .child(ui::labelled("Owner", owners, None, cx))
            .child(ui::labelled("Priority", priorities, None, cx))
            .when_some(view.problem.clone(), |this, problem| this.child(ui::problem_line(problem, t)))
            .child(div().flex().child(submit))
            .when(ticket.is_some(), |this| this.child(ui::divider(t)).child(self.render_comments(t, window, cx)))
    }

    fn render_status_picker(&self, ticket: &Ticket, cx: &mut Context<Self>) -> Div {
        div()
            .flex()
            .flex_wrap()
            .gap_1()
            .children(TicketStatus::ALL.into_iter().map(|status| {
                Action::new(
                    SharedString::from(format!("ticket-status-{status:?}")),
                    status.label(),
                )
                .small()
                .selected(ticket.status == status)
                .busy(self.board.moving == Some(status))
                .disabled(self.board.moving.is_some() && self.board.moving != Some(status))
                .on_click(
                    cx.listener(move |panel, _, window, cx| panel.move_ticket(status, window, cx)),
                )
            }))
    }

    fn render_comments(&self, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let view = &self.board;
        let retry = Action::new("retry-comments", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_comments(window, cx)));
        let list = match placeholder(&view.comments, "load the comments", retry, t) {
            Some(placeholder) => placeholder,
            None => {
                let comments = view.comments.value.as_deref().unwrap_or_default();
                if comments.is_empty() {
                    ui::meta("No comments yet.", t)
                } else {
                    div()
                        .flex()
                        .flex_col()
                        .gap_3()
                        .children(comments.iter().map(|comment| {
                            div()
                                .flex()
                                .flex_col()
                                .gap_1()
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap_2()
                                        .child(ui::body(
                                            comment
                                                .author_name
                                                .clone()
                                                .unwrap_or_else(|| "Someone".into()),
                                            t.ink,
                                        ))
                                        .child(ui::meta(relative(&comment.created_at), t)),
                                )
                                .child(ui::body(comment.body.clone(), t.ink_secondary))
                        }))
                }
            }
        };
        let empty = view.comment.read(cx).value().trim().is_empty();
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(ui::group_label("Comments", t))
            .child(list)
            .child(ui::text_area(&view.comment, "Comment", false, window, cx))
            .child(
                div().flex().child(
                    Action::new("post-comment", "Comment")
                        .disabled(empty)
                        .busy(view.commenting)
                        .on_click(
                            cx.listener(|panel, _, window, cx| panel.post_comment(window, cx)),
                        ),
                ),
            )
    }
}

fn status_glyph(status: TicketStatus) -> Glyph {
    match status {
        TicketStatus::Todo => Glyph::Square,
        TicketStatus::Doing => Glyph::Play,
        TicketStatus::Review => Glyph::ShieldCheck,
        TicketStatus::Blocked => Glyph::CircleAlert,
        TicketStatus::Done => Glyph::Check,
        TicketStatus::Closed => Glyph::X,
    }
}

fn status_color(status: TicketStatus, t: &Tokens) -> gpui_kit::Hsla {
    match status {
        TicketStatus::Blocked => t.warning,
        TicketStatus::Done => t.success,
        _ => t.ink_secondary,
    }
}
