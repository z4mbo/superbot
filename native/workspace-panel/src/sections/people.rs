use gpui_kit::component::input::InputState;
use gpui_kit::prelude::*;
use gpui_kit::{div, App, ClipboardItem, Div, Entity, SharedString, Window};
use superbot_features::{InviteLink, InvitePreview, Person, SpaceMember, SpaceMembers, SpaceRole};

use crate::format::{date, invite_token};
use crate::icons::Glyph;
use crate::panel::{placeholder, section_header, Loaded, PanelEvent, WorkspacePanel};
use crate::theme::{tokens, Tokens};
use crate::ui::{self, Action, Row, Tone};

/// A change the person must confirm in place because it cannot be undone.
#[derive(Clone, PartialEq, Eq)]
enum Confirm {
    RemoveMember(String),
    CancelInvites,
    Leave,
}

/// What the last invite did, shown under the invite controls.
enum InviteOutcome {
    Emailed {
        email: String,
        expires_at: String,
    },
    Copied {
        expires_at: String,
    },
    /// The server made the link but could not send the email.
    NotEmailed {
        email: String,
        expires_at: String,
    },
}

pub(crate) struct PeopleView {
    members: Loaded<SpaceMembers>,
    email: Entity<InputState>,
    inviting: Option<&'static str>,
    outcome: Option<InviteOutcome>,
    problem: Option<SharedString>,
    confirm: Option<Confirm>,
    busy: bool,
    join_link: Entity<InputState>,
    join_open: bool,
    join_preview: Option<(String, InvitePreview)>,
    join_busy: bool,
    join_problem: Option<SharedString>,
}

impl PeopleView {
    pub(crate) fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            members: Loaded::default(),
            email: ui::new_input("name@example.com", window, cx),
            inviting: None,
            outcome: None,
            problem: None,
            confirm: None,
            busy: false,
            join_link: ui::new_input("Paste an invite link", window, cx),
            join_open: false,
            join_preview: None,
            join_busy: false,
            join_problem: None,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.members = Loaded::default();
        self.inviting = None;
        self.outcome = None;
        self.problem = None;
        self.confirm = None;
        self.busy = false;
        self.join_open = false;
        self.join_preview = None;
        self.join_busy = false;
        self.join_problem = None;
    }
}

fn plausible_email(text: &str) -> bool {
    match text.split_once('@') {
        Some((name, host)) => {
            !name.is_empty()
                && host.contains('.')
                && !host.starts_with('.')
                && !host.ends_with('.')
                && !text.contains(char::is_whitespace)
        }
        None => false,
    }
}

impl WorkspacePanel {
    pub(crate) fn load_members(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.people.members.loading {
            return;
        }
        self.people.members.begin();
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().members().await },
            |panel, members, _, _| {
                if let Ok(members) = &members {
                    panel.space_name = Some(members.space_name.clone().into());
                }
                panel.people.members.finish(members);
            },
        );
    }

    /// Asks the server for a single-use link, emailed when `email` is given
    /// and otherwise copied to the clipboard.
    fn invite(&mut self, by_email: bool, window: &mut Window, cx: &mut Context<Self>) {
        let email = by_email.then(|| self.people.email.read(cx).value().trim().to_owned());
        if self.people.inviting.is_some() || email.as_deref().is_some_and(|e| !plausible_email(e)) {
            return;
        }
        self.people.inviting = Some(if by_email { "email" } else { "link" });
        self.people.problem = None;
        self.people.outcome = None;
        let remote = self.remote.clone();
        let asked = email.clone();
        self.request(
            window,
            cx,
            async move { remote.space().create_invite(asked.as_deref()).await },
            move |panel, link, window, cx| {
                panel.people.inviting = None;
                let link: InviteLink = match link {
                    Ok(link) => link,
                    Err(failure) => {
                        panel.people.problem = Some(failure.sentence("invite people").into());
                        return;
                    }
                };
                let expires_at = link.expires_at.clone();
                panel.people.outcome = Some(match email {
                    Some(email) if link.emailed == Some(true) => {
                        ui::set_input(&panel.people.email, "", window, cx);
                        InviteOutcome::Emailed { email, expires_at }
                    }
                    Some(email) => {
                        cx.write_to_clipboard(ClipboardItem::new_string(link.url));
                        InviteOutcome::NotEmailed { email, expires_at }
                    }
                    None => {
                        cx.write_to_clipboard(ClipboardItem::new_string(link.url));
                        InviteOutcome::Copied { expires_at }
                    }
                });
                panel.load_members(window, cx);
            },
        );
    }

    fn cancel_invites(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.people.confirm = None;
        self.people.busy = true;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().cancel_invites().await },
            |panel, cancelled, window, cx| {
                panel.people.busy = false;
                match cancelled {
                    Ok(()) => {
                        panel.people.outcome = None;
                        panel.toast("Unused invite links no longer work.", None, cx);
                        panel.load_members(window, cx);
                    }
                    Err(failure) => {
                        panel.people.problem = Some(failure.sentence("cancel the invites").into());
                    }
                }
            },
        );
    }

    fn add_member(&mut self, person: Person, window: &mut Window, cx: &mut Context<Self>) {
        self.people.busy = true;
        self.people.problem = None;
        let remote = self.remote.clone();
        let user_id = person.user_id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().add_member(&user_id).await },
            move |panel, added, window, cx| {
                panel.people.busy = false;
                match added {
                    Ok(()) => {
                        panel.toast(format!("Added {}.", person.name), None, cx);
                        panel.load_members(window, cx);
                    }
                    Err(failure) => {
                        panel.people.problem = Some(failure.sentence("add this person").into());
                    }
                }
            },
        );
    }

    fn remove_member(&mut self, user_id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.people.confirm = None;
        self.people.busy = true;
        self.people.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().remove_member(&user_id).await },
            |panel, removed, window, cx| {
                panel.people.busy = false;
                match removed {
                    Ok(()) => {
                        panel.toast("Removed from this space.", None, cx);
                        panel.load_members(window, cx);
                    }
                    Err(failure) => {
                        panel.people.problem = Some(failure.sentence("remove this person").into());
                    }
                }
            },
        );
    }

    fn leave_space(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.people.confirm = None;
        self.people.busy = true;
        self.people.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().leave().await },
            |panel, left, _, cx| {
                panel.people.busy = false;
                match left {
                    Ok(active_space_id) => {
                        panel.access = crate::panel::Access::Left;
                        cx.emit(PanelEvent::SpaceLeft { active_space_id });
                    }
                    Err(failure) => {
                        panel.people.problem = Some(failure.sentence("leave this space").into());
                    }
                }
            },
        );
    }

    fn preview_invite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pasted = self.people.join_link.read(cx).value();
        let token = invite_token(&pasted).to_owned();
        if token.is_empty() || self.people.join_busy {
            return;
        }
        self.people.join_busy = true;
        self.people.join_problem = None;
        self.people.join_preview = None;
        let remote = self.remote.clone();
        let asked = token.clone();
        self.request(
            window,
            cx,
            async move { remote.features().preview_space_invite(&asked).await },
            move |panel, preview, _, _| {
                panel.people.join_busy = false;
                match preview {
                    Ok(preview) => panel.people.join_preview = Some((token, preview)),
                    Err(crate::remote::Failure::Stale(_)) => {
                        panel.people.join_problem = Some(
                            "That invite link has been used, cancelled or has expired.".into(),
                        );
                    }
                    Err(failure) => {
                        panel.people.join_problem =
                            Some(failure.sentence("check that invite link").into());
                    }
                }
            },
        );
    }

    fn accept_invite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((token, preview)) = self.people.join_preview.clone() else {
            return;
        };
        self.people.join_busy = true;
        self.people.join_problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.features().accept_space_invite(&token).await },
            move |panel, joined, window, cx| {
                panel.people.join_busy = false;
                match joined {
                    Ok(space_id) => {
                        panel.people.join_preview = None;
                        panel.people.join_open = false;
                        ui::set_input(&panel.people.join_link, "", window, cx);
                        panel.toast(format!("You joined {}.", preview.space_name), None, cx);
                        cx.emit(PanelEvent::SpaceJoined { space_id });
                    }
                    Err(failure) => {
                        panel.people.join_problem =
                            Some(failure.sentence("join that space").into());
                    }
                }
            },
        );
    }

    pub(crate) fn render_people(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let t = tokens(cx);
        let header = section_header("People", [], &t);
        let retry = Action::new("retry-members", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_members(window, cx)));
        let body = match placeholder(&self.people.members, "see who is in this space", retry, &t) {
            Some(placeholder) => placeholder,
            None => self.render_members(&t, window, cx),
        };
        div()
            .flex()
            .flex_col()
            .child(header)
            .child(body)
            .child(self.render_join(&t, window, cx))
    }

    fn render_members(&self, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let view = &self.people;
        let Some(roster) = view.members.value.as_ref() else {
            return div();
        };
        let invites = roster
            .can_manage
            .then(|| self.render_invites(roster, t, window, cx));
        let members = div()
            .flex()
            .flex_col()
            .child(ui::group_label(
                match roster.members.len() {
                    1 => "1 person".to_owned(),
                    count => format!("{count} people"),
                },
                t,
            ))
            .children(
                roster
                    .members
                    .iter()
                    .map(|member| self.render_member(member, roster.can_manage, t, cx)),
            );
        let addable = roster
            .addable
            .as_deref()
            .filter(|people| roster.can_manage && !people.is_empty())
            .map(|people| {
                div()
                    .flex()
                    .flex_col()
                    .child(ui::group_label(
                        match &roster.organization_name {
                            Some(name) => format!("In {name}, not in this space"),
                            None => "In your organization, not in this space".to_owned(),
                        },
                        t,
                    ))
                    .children(people.iter().map(|person| {
                        let adding = person.clone();
                        Row::new(
                            SharedString::from(format!("addable-{}", person.user_id)),
                            person.name.clone(),
                        )
                        .leading(ui::person_face(&person.name, 32., t))
                        .detail(person.email.clone())
                        .trailing(
                            Action::new(
                                SharedString::from(format!("add-{}", person.user_id)),
                                "Add",
                            )
                            .small()
                            .glyph(Glyph::UserPlus)
                            .disabled(view.busy)
                            .on_click(cx.listener(
                                move |panel, _, window, cx| {
                                    panel.add_member(adding.clone(), window, cx)
                                },
                            )),
                        )
                    }))
            });
        let leave = (!roster.can_manage).then(|| {
            if view.confirm == Some(Confirm::Leave) {
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(ui::body(
                        "You'll lose access to this space's bots and conversations.",
                        t.ink_secondary,
                    ))
                    .child(
                        Action::new("confirm-leave", "Leave space")
                            .tone(Tone::Danger)
                            .small()
                            .busy(view.busy)
                            .on_click(
                                cx.listener(|panel, _, window, cx| panel.leave_space(window, cx)),
                            ),
                    )
                    .child(Action::new("stay", "Stay").small().on_click(cx.listener(
                        |panel, _, _, cx| {
                            panel.people.confirm = None;
                            cx.notify();
                        },
                    )))
            } else {
                div().flex().child(
                    Action::new("leave-space", "Leave this space")
                        .tone(Tone::DangerLink)
                        .glyph(Glyph::LogOut)
                        .on_click(cx.listener(|panel, _, _, cx| {
                            panel.people.confirm = Some(Confirm::Leave);
                            cx.notify();
                        })),
                )
            }
        });

        div()
            .flex()
            .flex_col()
            .gap_5()
            .children(invites)
            .when_some(view.problem.clone(), |this, problem| {
                this.child(ui::problem_line(problem, t))
            })
            .child(members)
            .children(addable)
            .children(leave)
    }

    fn render_member(
        &self,
        member: &SpaceMember,
        can_manage: bool,
        t: &Tokens,
        cx: &mut Context<Self>,
    ) -> Row {
        let view = &self.people;
        let person = &member.person;
        let owner = matches!(member.role, SpaceRole::Owner);
        let role = if owner {
            "Owner"
        } else if member.guest == Some(true) {
            "Guest"
        } else {
            "Member"
        };
        let row = Row::new(
            SharedString::from(format!("member-{}", person.user_id)),
            person.name.clone(),
        )
        .leading(ui::person_face(&person.name, 40., t))
        .detail(person.email.clone());
        if view.confirm == Some(Confirm::RemoveMember(person.user_id.clone())) {
            let user_id = person.user_id.clone();
            return row
                .trailing(
                    Action::new("confirm-remove-member", "Remove")
                        .tone(Tone::Danger)
                        .small()
                        .on_click(cx.listener(move |panel, _, window, cx| {
                            panel.remove_member(user_id.clone(), window, cx)
                        })),
                )
                .trailing(
                    Action::new("keep-member", "Keep")
                        .small()
                        .on_click(cx.listener(|panel, _, _, cx| {
                            panel.people.confirm = None;
                            cx.notify();
                        })),
                );
        }
        let row = row.trailing(ui::meta(role, t));
        if !can_manage || owner {
            return row;
        }
        let user_id = person.user_id.clone();
        row.trailing(
            Action::icon(
                SharedString::from(format!("remove-member-{}", person.user_id)),
                Glyph::UserMinus,
                format!("Remove {}", person.name),
            )
            .small()
            .disabled(view.busy)
            .on_click(cx.listener(move |panel, _, _, cx| {
                panel.people.confirm = Some(Confirm::RemoveMember(user_id.clone()));
                cx.notify();
            })),
        )
    }

    fn render_invites(
        &self,
        roster: &SpaceMembers,
        t: &Tokens,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let view = &self.people;
        let typed = view.email.read(cx).value();
        let typed = typed.trim();
        let email_ok = plausible_email(typed);
        let outcome = view.outcome.as_ref().map(|outcome| match outcome {
            InviteOutcome::Emailed { email, expires_at } => format!(
                "Invite sent to {email}. Its link works once, until {}.",
                date(expires_at)
            ),
            InviteOutcome::Copied { expires_at } => format!(
                "Link copied. It lets one person in, until {}.",
                date(expires_at)
            ),
            InviteOutcome::NotEmailed { email, expires_at } => format!(
                "This server couldn't email {email}, so the link was copied instead. Send it yourself; it works once, until {}.",
                date(expires_at)
            ),
        });
        let open = roster.open_invites.unwrap_or(0);
        let unused = (open > 0).then(|| {
            let label = match open {
                1 => "1 invite link hasn't been used.".to_owned(),
                count => format!("{count} invite links haven't been used."),
            };
            let line = div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_2()
                .child(ui::meta(label, t));
            if view.confirm == Some(Confirm::CancelInvites) {
                line.child(
                    Action::new("confirm-cancel-invites", "Cancel them all")
                        .tone(Tone::Danger)
                        .small()
                        .on_click(
                            cx.listener(|panel, _, window, cx| panel.cancel_invites(window, cx)),
                        ),
                )
                .child(
                    Action::new("keep-invites", "Keep")
                        .small()
                        .on_click(cx.listener(|panel, _, _, cx| {
                            panel.people.confirm = None;
                            cx.notify();
                        })),
                )
            } else {
                line.child(
                    Action::new("cancel-invites", "Cancel unused links")
                        .tone(Tone::Link)
                        .small()
                        .disabled(view.busy)
                        .on_click(cx.listener(|panel, _, _, cx| {
                            panel.people.confirm = Some(Confirm::CancelInvites);
                            cx.notify();
                        })),
                )
            }
        });

        ui::card(t)
            .child(ui::labelled(
                "Invite by email",
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w(gpui_kit::px(200.))
                            .child(ui::text_field(
                                &view.email,
                                "Email address",
                                !typed.is_empty() && !email_ok && view.inviting.is_none(),
                                window,
                                cx,
                            )),
                    )
                    .child(
                        Action::new("invite-by-email", "Send invite")
                            .tone(Tone::Primary)
                            .glyph(Glyph::Mail)
                            .disabled(!email_ok || view.inviting.is_some())
                            .busy(view.inviting == Some("email"))
                            .on_click(
                                cx.listener(|panel, _, window, cx| panel.invite(true, window, cx)),
                            ),
                    ),
                None,
                cx,
            ))
            .child(
                div().flex().child(
                    Action::new("copy-invite-link", "Copy an invite link")
                        .glyph(Glyph::Link)
                        .disabled(view.inviting.is_some())
                        .busy(view.inviting == Some("link"))
                        .on_click(
                            cx.listener(|panel, _, window, cx| panel.invite(false, window, cx)),
                        ),
                ),
            )
            .when_some(outcome, |this, outcome| {
                this.child(ui::body(outcome, t.ink_secondary))
            })
            .children(unused)
    }

    fn render_join(&self, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let view = &self.people;
        if !view.join_open {
            return div().flex().pt_5().child(
                Action::new("open-join", "Join another space with a link")
                    .tone(Tone::Quiet)
                    .small()
                    .glyph(Glyph::Link)
                    .on_click(cx.listener(|panel, _, _, cx| {
                        panel.people.join_open = true;
                        cx.notify();
                    })),
            );
        }
        let pasted = view.join_link.read(cx).value().trim().is_empty();
        let preview = view.join_preview.as_ref().map(|(_, preview)| {
            let line = if preview.already_member {
                format!("You're already in {}.", preview.space_name)
            } else {
                format!(
                    "{} invited you to {}.",
                    preview.inviter_name, preview.space_name
                )
            };
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_2()
                .child(ui::body(line, t.ink))
                .when(!preview.already_member, |this| {
                    this.child(
                        Action::new("accept-invite", "Join")
                            .tone(Tone::Primary)
                            .small()
                            .busy(view.join_busy)
                            .on_click(
                                cx.listener(|panel, _, window, cx| panel.accept_invite(window, cx)),
                            ),
                    )
                })
        });
        div().pt_5().child(
            ui::card(t)
                .child(ui::labelled(
                    "Join another space",
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .child(
                            div()
                                .flex_1()
                                .min_w(gpui_kit::px(200.))
                                .child(ui::text_field(
                                    &view.join_link,
                                    "Invite link",
                                    false,
                                    window,
                                    cx,
                                )),
                        )
                        .child(
                            Action::new("check-invite", "Check link")
                                .disabled(pasted)
                                .busy(view.join_busy && view.join_preview.is_none())
                                .on_click(cx.listener(|panel, _, window, cx| {
                                    panel.preview_invite(window, cx)
                                })),
                        ),
                    view.join_problem.clone(),
                    cx,
                ))
                .children(preview),
        )
    }
}
