use gpui_kit::prelude::*;
use gpui_kit::{div, Div, SharedString, Window};
use superbot_features::{RunActivity, RunFilter, ThreadTarget};

use crate::format::{relative, sentence_case};
use crate::icons::Glyph;
use crate::panel::{placeholder, section_header, Loaded, PanelEvent, WorkspacePanel};
use crate::theme::{tokens, Tokens};
use crate::ui::{self, Action, Row};

pub(crate) struct ActivityView {
    recent: bool,
    runs: Loaded<Vec<RunActivity>>,
    stopping: Option<String>,
    problem: Option<SharedString>,
}

impl ActivityView {
    pub(crate) fn new() -> Self {
        Self {
            recent: false,
            runs: Loaded::default(),
            stopping: None,
            problem: None,
        }
    }

    pub(crate) fn reset(&mut self) {
        *self = Self::new();
    }
}

fn in_progress(status: &str) -> bool {
    matches!(
        status,
        "queued" | "leased" | "running" | "waiting_input" | "waiting_takeover"
    )
}

fn status_label(status: &str) -> String {
    match status {
        "queued" | "leased" => "Starting".into(),
        "running" => "Working".into(),
        "waiting_input" => "Needs you".into(),
        "waiting_takeover" => "Waiting for control".into(),
        "completed" => "Done".into(),
        "cancelled" => "Stopped".into(),
        other => sentence_case(other),
    }
}

fn trigger_label(trigger: &str) -> Option<&'static str> {
    Some(match trigger {
        "user" => return None,
        "routine" => "Routine",
        "webhook" => "Webhook",
        "messaging" => "Message",
        "bot_message" => "Another bot",
        "follow_up" => "Follow-up",
        "skill" => "Skill",
        _ => return None,
    })
}

impl WorkspacePanel {
    pub(crate) fn load_activity(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.activity.runs.loading {
            return;
        }
        self.activity.runs.begin();
        let recent = self.activity.recent;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let filter = if recent {
                    RunFilter::Recent
                } else {
                    RunFilter::Active
                };
                remote.space().list_runs(filter).await
            },
            move |panel, runs, _, _| {
                if panel.activity.recent == recent {
                    panel.activity.runs.finish(runs);
                } else {
                    panel.activity.runs.loading = false;
                }
            },
        );
    }

    fn set_activity_filter(&mut self, recent: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.activity.recent == recent {
            return;
        }
        self.activity.recent = recent;
        self.activity.runs = Loaded::default();
        self.activity.problem = None;
        self.load_activity(window, cx);
        cx.notify();
    }

    fn stop_run(&mut self, run: &RunActivity, window: &mut Window, cx: &mut Context<Self>) {
        if self.activity.stopping.is_some() {
            return;
        }
        self.activity.stopping = Some(run.run_id.clone());
        self.activity.problem = None;
        let (bot_id, group_id) = (run.bot_id.clone(), run.group_id.clone());
        let name = run.bot_name.clone();
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let target = match &group_id {
                    Some(group_id) => ThreadTarget::Group(group_id),
                    None => ThreadTarget::Bot(&bot_id),
                };
                remote.space().stop_thread(target).await
            },
            move |panel, stopped, window, cx| {
                panel.activity.stopping = None;
                match stopped {
                    Ok(()) => {
                        panel.toast(format!("Stopped {name}."), None, cx);
                        panel.load_activity(window, cx);
                    }
                    Err(failure) => {
                        panel.activity.problem = Some(failure.sentence("stop that run").into());
                    }
                }
            },
        );
        cx.notify();
    }

    pub(crate) fn render_activity(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Div {
        let t = tokens(cx);
        let view = &self.activity;
        let header = section_header(
            "Activity",
            [
                Action::icon("refresh-activity", Glyph::RefreshCw, "Refresh")
                    .busy(view.runs.loading && view.runs.value.is_some())
                    .on_click(cx.listener(|panel, _, window, cx| panel.load_activity(window, cx))),
            ],
            &t,
        );
        let filters = div()
            .flex()
            .gap_1()
            .pb_3()
            .child(
                Action::new("activity-active", "In progress")
                    .small()
                    .selected(!view.recent)
                    .on_click(cx.listener(|panel, _, window, cx| {
                        panel.set_activity_filter(false, window, cx)
                    })),
            )
            .child(
                Action::new("activity-recent", "Recent")
                    .small()
                    .selected(view.recent)
                    .on_click(cx.listener(|panel, _, window, cx| {
                        panel.set_activity_filter(true, window, cx)
                    })),
            );
        let retry = Action::new("retry-activity", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_activity(window, cx)));
        let list = match placeholder(&view.runs, "load the activity", retry, &t) {
            Some(placeholder) => placeholder,
            None => {
                let runs = view.runs.value.as_deref().unwrap_or_default();
                if runs.is_empty() {
                    ui::notice(
                        if view.recent {
                            "Nothing has run here recently."
                        } else {
                            "No bot is working right now."
                        },
                        None,
                        &t,
                    )
                } else {
                    div()
                        .flex()
                        .flex_col()
                        .children(runs.iter().map(|run| self.render_run(run, &t, cx)))
                }
            }
        };
        div()
            .flex()
            .flex_col()
            .child(header)
            .child(filters)
            .when_some(view.problem.clone(), |this, problem| {
                this.child(div().pb_3().child(ui::problem_line(problem, &t)))
            })
            .child(list)
    }

    fn render_run(&self, run: &RunActivity, t: &Tokens, cx: &mut Context<Self>) -> Row {
        let view = &self.activity;
        let color = self
            .bots
            .value
            .as_ref()
            .and_then(|bots| bots.iter().find(|bot| bot.id == run.bot_id))
            .map(|bot| bot.color.clone())
            .unwrap_or_default();
        let working = matches!(run.status.as_str(), "running" | "queued" | "leased");
        let bot = superbot_avatars::Bot {
            id: &run.bot_id,
            name: &run.bot_name,
            color: &color,
        };
        let face = ui::bot_avatar(bot, 40., working, t, cx);
        let title = match &run.group_name {
            Some(group) => format!("{} in {group}", run.bot_name),
            None => run.bot_name.clone(),
        };
        let event = match &run.group_id {
            Some(group_id) => PanelEvent::OpenGroup {
                group_id: group_id.clone(),
            },
            None => PanelEvent::OpenBot {
                bot_id: run.bot_id.clone(),
            },
        };
        let status_ink = match run.status.as_str() {
            "failed" => t.danger,
            "waiting_input" | "waiting_takeover" => t.accent_text,
            "running" | "queued" | "leased" => t.success,
            _ => t.ink_secondary,
        };
        let stopping = run.clone();
        Row::new(SharedString::from(format!("run-{}", run.run_id)), title)
            .leading(face)
            .detail(run.prompt_snippet.clone())
            .when_some(trigger_label(&run.trigger), |row, trigger| {
                row.trailing(ui::meta(trigger, t))
            })
            .trailing(ui::chip(status_label(&run.status), status_ink, t))
            .trailing(ui::meta(relative(&run.updated_at), t))
            .when(in_progress(&run.status), |row| {
                row.trailing(
                    Action::icon(
                        SharedString::from(format!("stop-run-{}", run.run_id)),
                        Glyph::Square,
                        format!("Stop {}", run.bot_name),
                    )
                    .small()
                    .busy(view.stopping.as_deref() == Some(run.run_id.as_str()))
                    .disabled(view.stopping.is_some())
                    .on_click(cx.listener(move |panel, _, window, cx| {
                        panel.stop_run(&stopping, window, cx)
                    })),
                )
            })
            .on_click(cx.listener(move |_, _, _, cx| cx.emit(event.clone())))
    }
}
