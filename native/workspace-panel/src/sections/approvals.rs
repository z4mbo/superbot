use gpui_kit::component::input::InputState;
use gpui_kit::prelude::*;
use gpui_kit::{div, App, Div, Entity, SharedString, Window};
use serde_json::Value;
use superbot_features::{
    ApprovalEffect, ApprovalMatch, ApprovalMatchKind, ApprovalMode, ApprovalRule, AutoReview,
    RunFilter, SpaceSetting, ThreadTarget,
};

use crate::icons::Glyph;
use crate::panel::{placeholder, section_header, Loaded, WorkspacePanel};
use crate::theme::{tokens, Tokens};
use crate::ui::{self, Action, Toggle, Tone};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Tool,
    Connector,
    Site,
}

impl Kind {
    const ALL: [Kind; 3] = [Kind::Tool, Kind::Connector, Kind::Site];

    fn label(self) -> &'static str {
        match self {
            Kind::Tool => "Tool",
            Kind::Connector => "Connector",
            Kind::Site => "Site",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Effect {
    Allow,
    Ask,
    Deny,
}

impl Effect {
    const ALL: [Effect; 3] = [Effect::Ask, Effect::Allow, Effect::Deny];

    fn label(self) -> &'static str {
        match self {
            Effect::Allow => "Always allow",
            Effect::Ask => "Ask first",
            Effect::Deny => "Never allow",
        }
    }

    fn wire(self) -> ApprovalEffect {
        match self {
            Effect::Allow => ApprovalEffect::AlwaysAllow,
            Effect::Ask => ApprovalEffect::RequireApproval,
            Effect::Deny => ApprovalEffect::Deny,
        }
    }

    fn of(effect: ApprovalEffect) -> Self {
        match effect {
            ApprovalEffect::AlwaysAllow => Effect::Allow,
            ApprovalEffect::RequireApproval => Effect::Ask,
            ApprovalEffect::Deny => Effect::Deny,
        }
    }
}

const MODES: [(&str, ApprovalMode); 3] = [
    ("Ask me first", ApprovalMode::Ask),
    ("Review automatically", ApprovalMode::Auto),
    ("Don't ask", ApprovalMode::Never),
];

fn same_mode(a: ApprovalMode, b: ApprovalMode) -> bool {
    std::mem::discriminant(&a) == std::mem::discriminant(&b)
}

/// A bot's question that a run is waiting on, with the answers it offers.
#[derive(Clone)]
struct Pending {
    run_id: String,
    message_id: String,
    bot_id: String,
    group_id: Option<String>,
    bot_name: String,
    group_name: Option<String>,
    question: String,
    detail: Option<String>,
    answers: Vec<(String, String)>,
}

/// The approval cards in `blocks` that still wait for one of their listed answers.
fn open_questions(
    blocks: &[Value],
) -> impl Iterator<Item = (String, Option<String>, Vec<(String, String)>)> + '_ {
    blocks.iter().filter_map(|block| {
        let text = |key: &str| block.get(key).and_then(Value::as_str);
        let closed = text("status") == Some("answered")
            || block.get("dismissed").is_some()
            || block.get("expired").is_some();
        if text("kind") != Some("ask") || closed || block.get("input").is_some() {
            return None;
        }
        let answers: Vec<(String, String)> = block
            .get("actions")?
            .as_array()?
            .iter()
            .filter_map(|action| {
                Some((
                    action.get("id")?.as_str()?.to_owned(),
                    action.get("label")?.as_str()?.to_owned(),
                ))
            })
            .collect();
        (!answers.is_empty()).then(|| {
            (
                text("text").unwrap_or_default().to_owned(),
                text("detail").map(str::to_owned),
                answers,
            )
        })
    })
}

// Each waiting run costs one thread read, so the list is capped; the rest
// are reachable from Activity.
const PENDING_LIMIT: usize = 12;

pub(crate) struct ApprovalsView {
    review: Loaded<AutoReview>,
    rules: Loaded<Vec<ApprovalRule>>,
    overrides: Loaded<Vec<SpaceSetting>>,
    pending: Loaded<Vec<Pending>>,
    answering: Option<String>,
    kind: Kind,
    effect: Effect,
    value: Entity<InputState>,
    adding: bool,
    removing: Option<String>,
    changing: bool,
    problem: Option<SharedString>,
}

impl ApprovalsView {
    pub(crate) fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            review: Loaded::default(),
            rules: Loaded::default(),
            overrides: Loaded::default(),
            pending: Loaded::default(),
            answering: None,
            kind: Kind::Tool,
            effect: Effect::Ask,
            value: ui::new_input("Name", window, cx),
            adding: false,
            removing: None,
            changing: false,
            problem: None,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.review = Loaded::default();
        self.rules = Loaded::default();
        self.overrides = Loaded::default();
        self.pending = Loaded::default();
        self.answering = None;
        self.adding = false;
        self.removing = None;
        self.changing = false;
        self.problem = None;
    }

    fn own_settings(&self) -> bool {
        self.overrides.value.as_ref().is_some_and(|overrides| {
            overrides
                .iter()
                .any(|setting| matches!(setting, SpaceSetting::Confirmations))
        })
    }
}

impl WorkspacePanel {
    pub(crate) fn load_approvals(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.load_approval_settings(window, cx);
        self.load_pending_approvals(window, cx);
    }

    fn load_approval_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = &mut self.approvals;
        view.review.begin();
        view.rules.begin();
        view.overrides.begin();
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().auto_review(None).await },
            |panel, review, _, _| panel.approvals.review.finish(review),
        );
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().approval_rules(None).await },
            |panel, rules, _, _| panel.approvals.rules.finish(rules),
        );
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().setting_overrides().await },
            |panel, overrides, _, _| panel.approvals.overrides.finish(overrides),
        );
    }

    fn load_pending_approvals(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.approvals.pending.loading {
            return;
        }
        self.approvals.pending.begin();
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let space = remote.space();
                let waiting = space
                    .list_runs(RunFilter::Active)
                    .await?
                    .into_iter()
                    .filter(|run| run.status == "waiting_input")
                    .take(PENDING_LIMIT);
                let mut pending = Vec::new();
                for run in waiting {
                    let target = match &run.group_id {
                        Some(group_id) => ThreadTarget::Group(group_id),
                        None => ThreadTarget::Bot(&run.bot_id),
                    };
                    let thread = space.thread(target).await?;
                    for message in thread
                        .messages
                        .iter()
                        .filter(|message| message.run_id.as_deref() == Some(run.run_id.as_str()))
                    {
                        for (question, detail, answers) in open_questions(&message.blocks) {
                            pending.push(Pending {
                                run_id: run.run_id.clone(),
                                message_id: message.id.clone(),
                                bot_id: run.bot_id.clone(),
                                group_id: run.group_id.clone(),
                                bot_name: run.bot_name.clone(),
                                group_name: run.group_name.clone(),
                                question,
                                detail,
                                answers,
                            });
                        }
                    }
                }
                Ok(pending)
            },
            |panel, pending, _, _| panel.approvals.pending.finish(pending),
        );
    }

    fn answer_approval(
        &mut self,
        pending: Pending,
        answer: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.approvals.answering.is_some() {
            return;
        }
        self.approvals.answering = Some(pending.message_id.clone());
        self.approvals.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let target = match &pending.group_id {
                    Some(group_id) => ThreadTarget::Group(group_id),
                    None => ThreadTarget::Bot(&pending.bot_id),
                };
                remote
                    .space()
                    .answer_thread_card(target, &pending.run_id, &pending.message_id, &answer)
                    .await
                    .map(|()| pending.message_id.clone())
            },
            |panel, answered, window, cx| {
                panel.approvals.answering = None;
                match answered {
                    Ok(message_id) => {
                        if let Some(pending) = &mut panel.approvals.pending.value {
                            pending.retain(|pending| pending.message_id != message_id);
                        }
                        panel.toast("Answer sent.", None, cx);
                        panel.load_pending_approvals(window, cx);
                    }
                    Err(failure) => {
                        panel.approvals.problem = Some(failure.sentence("send that answer").into());
                        panel.load_pending_approvals(window, cx);
                    }
                }
            },
        );
        cx.notify();
    }

    fn set_approval_mode(
        &mut self,
        mode: ApprovalMode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.approvals.changing {
            return;
        }
        self.approvals.changing = true;
        self.approvals.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().set_auto_review(None, mode).await },
            |panel, review, _, _| {
                panel.approvals.changing = false;
                match review {
                    Ok(review) => panel.approvals.review.finish(Ok(review)),
                    Err(failure) => {
                        panel.approvals.problem =
                            Some(failure.sentence("change when bots ask").into());
                    }
                }
            },
        );
        cx.notify();
    }

    fn set_own_approvals(&mut self, own: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.approvals.changing {
            return;
        }
        self.approvals.changing = true;
        self.approvals.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                remote
                    .space()
                    .set_setting_override(SpaceSetting::Confirmations, own)
                    .await
            },
            |panel, overrides, window, cx| {
                panel.approvals.changing = false;
                match overrides {
                    Ok(overrides) => {
                        panel.approvals.overrides.finish(Ok(overrides));
                        panel.load_approval_settings(window, cx);
                    }
                    Err(failure) => {
                        panel.approvals.problem = Some(
                            failure
                                .sentence("change whose approval settings this space uses")
                                .into(),
                        );
                    }
                }
            },
        );
        cx.notify();
    }

    fn add_approval_rule(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = &self.approvals;
        let value = view.value.read(cx).value().trim().to_owned();
        if value.is_empty() || view.adding {
            return;
        }
        let (kind, effect) = (view.kind, view.effect);
        self.approvals.adding = true;
        self.approvals.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let matcher = match kind {
                    Kind::Tool => ApprovalMatch::Tool(&value),
                    Kind::Connector => ApprovalMatch::Connector(&value),
                    Kind::Site => ApprovalMatch::Site(&value),
                };
                remote
                    .space()
                    .set_approval_rule(None, effect.wire(), matcher)
                    .await
            },
            |panel, rule, window, cx| {
                panel.approvals.adding = false;
                match rule {
                    Ok(rule) => {
                        ui::set_input(&panel.approvals.value, "", window, cx);
                        if let Some(rules) = &mut panel.approvals.rules.value {
                            rules.retain(|existing| existing.id != rule.id);
                            rules.push(rule);
                        }
                    }
                    Err(failure) => {
                        panel.approvals.problem = Some(failure.sentence("add that rule").into());
                    }
                }
            },
        );
        cx.notify();
    }

    fn remove_approval_rule(
        &mut self,
        rule_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.approvals.removing = Some(rule_id.clone());
        self.approvals.problem = None;
        let remote = self.remote.clone();
        let removed_id = rule_id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().remove_approval_rule(None, &rule_id).await },
            move |panel, removed, _, _| {
                panel.approvals.removing = None;
                match removed {
                    Ok(()) => {
                        if let Some(rules) = &mut panel.approvals.rules.value {
                            rules.retain(|rule| rule.id != removed_id);
                        }
                    }
                    Err(failure) => {
                        panel.approvals.problem = Some(failure.sentence("remove that rule").into());
                    }
                }
            },
        );
        cx.notify();
    }

    pub(crate) fn render_approvals(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let t = tokens(cx);
        let view = &self.approvals;
        div()
            .flex()
            .flex_col()
            .child(section_header("Approvals", [], &t))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_5()
                    .when_some(view.problem.clone(), |this, problem| {
                        this.child(ui::problem_line(problem, &t))
                    })
                    .child(self.render_pending(&t, cx))
                    .child(ui::divider(&t))
                    .child(self.render_mode(&t, cx))
                    .child(ui::divider(&t))
                    .child(self.render_rules(&t, window, cx)),
            )
    }

    fn render_pending(&self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let view = &self.approvals;
        let retry = Action::new("retry-pending", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_pending_approvals(window, cx)));
        let list = match placeholder(&view.pending, "see what is waiting for you", retry, t) {
            Some(placeholder) => placeholder,
            None => {
                let pending = view.pending.value.as_deref().unwrap_or_default();
                if pending.is_empty() {
                    ui::notice("Nothing is waiting for your answer.", None, t)
                } else {
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .children(pending.iter().map(|pending| {
                            let who = match &pending.group_name {
                                Some(group) => format!("{} in {group}", pending.bot_name),
                                None => pending.bot_name.clone(),
                            };
                            let busy =
                                view.answering.as_deref() == Some(pending.message_id.as_str());
                            ui::card(t)
                                .child(ui::group_label(who, t))
                                .child(ui::body(pending.question.clone(), t.ink))
                                .when_some(pending.detail.clone(), |this, detail| {
                                    this.child(ui::mono(detail, t.ink_secondary, cx))
                                })
                                .child(div().flex().flex_wrap().gap_2().children(
                                    pending.answers.iter().map(|(id, label)| {
                                        let (asked, answer) = (pending.clone(), id.clone());
                                        Action::new(
                                            SharedString::from(format!(
                                                "answer-{}-{id}",
                                                pending.message_id
                                            )),
                                            label.clone(),
                                        )
                                        .small()
                                        .disabled(view.answering.is_some() && !busy)
                                        .busy(busy)
                                        .on_click(
                                            cx.listener(move |panel, _, window, cx| {
                                                panel.answer_approval(
                                                    asked.clone(),
                                                    answer.clone(),
                                                    window,
                                                    cx,
                                                )
                                            }),
                                        )
                                    }),
                                ))
                        }))
                }
            }
        };
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(ui::group_label("Waiting for you", t))
            .child(list)
    }

    fn render_mode(&self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let view = &self.approvals;
        let retry = Action::new("retry-review", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_approval_settings(window, cx)));
        let mode = match placeholder(
            &view.review,
            "read this space's approval settings",
            retry,
            t,
        ) {
            Some(placeholder) => placeholder,
            None => {
                let Some(review) = view.review.value.as_ref() else {
                    return div();
                };
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(div().flex().flex_wrap().gap_1().children(MODES.iter().map(
                        |(label, mode)| {
                            let mode = *mode;
                            let unavailable =
                                matches!(mode, ApprovalMode::Auto) && !review.checker_available;
                            Action::new(
                                SharedString::from(format!("approval-mode-{label}")),
                                *label,
                            )
                            .small()
                            .selected(same_mode(review.mode, mode))
                            .disabled(unavailable || view.changing)
                            .on_click(cx.listener(
                                move |panel, _, window, cx| {
                                    panel.set_approval_mode(mode, window, cx)
                                },
                            ))
                        },
                    )))
                    .when(!review.checker_available, |this| {
                        this.child(ui::meta("Automatic review isn't set up on this server.", t))
                    })
                    .when(review.skip_approvals, |this| {
                        this.child(ui::body(
                            "Approvals are switched off here: bots act without asking.",
                            t.warning,
                        ))
                    })
            }
        };
        let own = view.own_settings();
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(ui::group_label(
                "Before a bot does something that needs approval",
                t,
            ))
            .child(mode)
            .when(view.overrides.value.is_some(), |this| {
                this.child(ui::setting_row(
                    "This space has its own approval settings",
                    (!own).then(|| "It follows your account's settings.".into()),
                    Toggle::new(
                        "own-approvals",
                        "This space has its own approval settings",
                        own,
                    )
                    .disabled(view.changing)
                    .on_change(cx.listener(|panel, on: &bool, window, cx| {
                        panel.set_own_approvals(*on, window, cx)
                    })),
                    t,
                ))
            })
    }

    fn render_rules(&self, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let view = &self.approvals;
        let retry = Action::new("retry-rules", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_approval_settings(window, cx)));
        let list = match placeholder(&view.rules, "read the approval rules", retry, t) {
            Some(placeholder) => placeholder,
            None => {
                let rules = view.rules.value.as_deref().unwrap_or_default();
                if rules.is_empty() {
                    ui::notice("No rules yet.", None, t)
                } else {
                    div().flex().flex_col().children(rules.iter().map(|rule| {
                        let id = rule.id.clone();
                        let effect = Effect::of(rule.effect);
                        let kind = match rule.match_kind {
                            ApprovalMatchKind::Tool => "Tool",
                            ApprovalMatchKind::Connector => "Connector",
                            ApprovalMatchKind::Category => "Category",
                            ApprovalMatchKind::Site => "Site",
                        };
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .min_h(gpui_kit::px(44.))
                            .child(ui::chip(
                                effect.label(),
                                if effect == Effect::Deny {
                                    t.danger
                                } else {
                                    t.ink
                                },
                                t,
                            ))
                            .child(ui::meta(kind, t))
                            .child(div().flex_1().min_w_0().truncate().child(ui::mono(
                                rule.match_value.clone(),
                                t.ink,
                                cx,
                            )))
                            .child(
                                Action::icon(
                                    SharedString::from(format!("remove-rule-{}", rule.id)),
                                    Glyph::Trash,
                                    format!("Remove the rule for {}", rule.match_value),
                                )
                                .small()
                                .busy(view.removing.as_deref() == Some(rule.id.as_str()))
                                .on_click(cx.listener(
                                    move |panel, _, window, cx| {
                                        panel.remove_approval_rule(id.clone(), window, cx)
                                    },
                                )),
                            )
                    }))
                }
            }
        };
        let typed = view.value.read(cx).value().trim().is_empty();
        let form = ui::card(t)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(Kind::ALL.map(|kind| {
                        Action::new(
                            SharedString::from(format!("rule-kind-{}", kind.label())),
                            kind.label(),
                        )
                        .small()
                        .selected(view.kind == kind)
                        .on_click(cx.listener(move |panel, _, _, cx| {
                            panel.approvals.kind = kind;
                            cx.notify();
                        }))
                    })),
            )
            .child(ui::text_field(
                &view.value,
                match view.kind {
                    Kind::Tool => "Tool name",
                    Kind::Connector => "Connector name",
                    Kind::Site => "Site address",
                },
                false,
                window,
                cx,
            ))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(Effect::ALL.map(|effect| {
                        Action::new(
                            SharedString::from(format!("rule-effect-{}", effect.label())),
                            effect.label(),
                        )
                        .small()
                        .selected(view.effect == effect)
                        .on_click(cx.listener(move |panel, _, _, cx| {
                            panel.approvals.effect = effect;
                            cx.notify();
                        }))
                    })),
            )
            .child(
                div().flex().child(
                    Action::new("add-rule", "Add rule")
                        .tone(Tone::Primary)
                        .disabled(typed)
                        .busy(view.adding)
                        .on_click(
                            cx.listener(|panel, _, window, cx| panel.add_approval_rule(window, cx)),
                        ),
                ),
            );
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(ui::group_label("Rules for one tool, connector or site", t))
            .child(list)
            .child(form)
    }
}

#[cfg(test)]
mod tests {
    use super::open_questions;
    use serde_json::json;

    #[test]
    fn only_unanswered_cards_with_listed_answers_are_offered() {
        let blocks = [
            json!({"kind": "text", "text": "Working on it"}),
            json!({"kind": "ask", "text": "Send the email?", "detail": "to: a@example.test",
                "actions": [{"id": "allow", "label": "Allow once"}, {"id": "deny", "label": "Deny"}]}),
            json!({"kind": "ask", "text": "Done already", "status": "answered",
                "actions": [{"id": "allow", "label": "Allow once"}]}),
            json!({"kind": "ask", "text": "Type the code", "input": "secret",
                "actions": [{"id": "ok", "label": "OK"}]}),
            json!({"kind": "ask", "text": "Too late", "expired": true,
                "actions": [{"id": "allow", "label": "Allow once"}]}),
            json!({"kind": "ask", "text": "No answers listed"}),
        ];
        let open: Vec<_> = open_questions(&blocks).collect();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].0, "Send the email?");
        assert_eq!(open[0].1.as_deref(), Some("to: a@example.test"));
        assert_eq!(
            open[0].2,
            [
                ("allow".to_owned(), "Allow once".to_owned()),
                ("deny".to_owned(), "Deny".to_owned())
            ]
        );
    }
}
