use gpui_kit::component::input::{InputState, TextareaState};
use gpui_kit::prelude::*;
use gpui_kit::{div, App, Div, Entity, SharedString, Window};
use superbot_features::{CreateRoutine, Routine, RoutineCursor, RoutineRun, RoutineUpdate};

use crate::format::{date_time, relative, schedule, sentence_case};
use crate::icons::{icon, Glyph};
use crate::panel::{detail_header, placeholder, section_header, Loaded, Section, WorkspacePanel};
use crate::theme::{tokens, Tokens};
use crate::ui::{self, Action, Row, Toggle, Tone};

#[derive(Clone, PartialEq, Eq)]
enum Mode {
    List,
    Create,
    Edit(String),
}

const PRESETS: [(&str, &str); 4] = [
    ("Every hour", "0 * * * *"),
    ("Every day at 09:00", "0 9 * * *"),
    ("Weekdays at 09:00", "0 9 * * 1-5"),
    ("Mondays at 09:00", "0 9 * * 1"),
];
const HISTORY_PAGE: u32 = 20;

pub(crate) struct RoutinesView {
    bot_id: Option<String>,
    list: Loaded<Vec<Routine>>,
    mode: Mode,
    name: Entity<InputState>,
    prompt: Entity<TextareaState>,
    crons: Entity<InputState>,
    timezone: Entity<InputState>,
    notify: bool,
    in_chat: bool,
    snapshot: Option<Routine>,
    saving: bool,
    running: bool,
    toggling: Option<String>,
    problem: Option<SharedString>,
    history: Loaded<Vec<RoutineRun>>,
    history_cursor: Option<RoutineCursor>,
    history_more: bool,
    confirm_remove: bool,
    removing: bool,
}

impl RoutinesView {
    pub(crate) fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            bot_id: None,
            list: Loaded::default(),
            mode: Mode::List,
            name: ui::new_input("Name", window, cx),
            prompt: ui::new_textarea("What the bot should do each time", (4, 14), window, cx),
            crons: ui::new_input("Cron schedule, e.g. 0 9 * * 1-5", window, cx),
            timezone: ui::new_input("Time zone, e.g. Europe/Rome", window, cx),
            notify: true,
            in_chat: false,
            snapshot: None,
            saving: false,
            running: false,
            toggling: None,
            problem: None,
            history: Loaded::default(),
            history_cursor: None,
            history_more: false,
            confirm_remove: false,
            removing: false,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.close();
        self.bot_id = None;
        self.list = Loaded::default();
    }

    pub(crate) fn close(&mut self) {
        self.mode = Mode::List;
        self.snapshot = None;
        self.saving = false;
        self.running = false;
        self.problem = None;
        self.history = Loaded::default();
        self.history_cursor = None;
        self.history_more = false;
        self.confirm_remove = false;
        self.removing = false;
    }

    /// The cron expressions typed in the schedule field, one per comma.
    fn typed_crons(&self, cx: &App) -> Vec<String> {
        self.crons
            .read(cx)
            .value()
            .split(',')
            .map(str::trim)
            .filter(|cron| !cron.is_empty())
            .map(str::to_owned)
            .collect()
    }

    fn dirty(&self, cx: &App) -> bool {
        self.snapshot.as_ref().is_some_and(|routine| {
            self.name.read(cx).value().trim() != routine.name
                || self.prompt.read(cx).value().as_ref() != routine.prompt
                || self.typed_crons(cx) != routine.crons
                || self.timezone.read(cx).value().trim() != routine.timezone
                || self.notify != routine.notify
                || self.in_chat != routine.in_chat
        })
    }
}

fn read_only(routine: &Routine) -> bool {
    routine.editable == Some(false)
}

fn summary(routine: &Routine) -> String {
    let mut parts = Vec::new();
    match routine.crons.as_slice() {
        [] => {}
        [only] => parts.push(schedule(only)),
        [first, rest @ ..] => parts.push(format!("{} and {} more", schedule(first), rest.len())),
    }
    if routine.webhook_enabled {
        parts.push("On a webhook".into());
    }
    if routine.github_enabled {
        parts.push("On GitHub events".into());
    }
    if routine.message_provider.is_some() {
        parts.push("On a message".into());
    }
    if routine.email_senders.is_some() {
        parts.push("On an email".into());
    }
    if parts.is_empty() {
        parts.push("Runs only when started by hand".into());
    }
    if !routine.active {
        parts.push("Paused".into());
    } else if let Some(next) = &routine.next_run_at {
        parts.push(format!("next {}", relative(next)));
    }
    parts.join(" · ")
}

impl WorkspacePanel {
    /// Chooses the first bot once the bot list arrives while this section is open.
    pub(crate) fn bots_arrived(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.section() == Section::Routines && self.routines.bot_id.is_none() {
            self.load_routines(window, cx);
        }
    }

    pub(crate) fn load_routines(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let known = |id: &String| {
            self.bots
                .value
                .as_ref()
                .is_some_and(|bots| bots.iter().any(|bot| bot.id == *id))
        };
        if !self.routines.bot_id.as_ref().is_some_and(known) {
            self.routines.bot_id = self
                .bots
                .value
                .as_ref()
                .and_then(|bots| bots.first())
                .map(|bot| bot.id.clone());
        }
        let Some(bot_id) = self.routines.bot_id.clone() else {
            return;
        };
        self.routines.list.begin();
        let remote = self.remote.clone();
        let asked = bot_id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().list_routines(&asked).await },
            move |panel, routines, _, _| {
                if panel.routines.bot_id.as_deref() == Some(bot_id.as_str()) {
                    panel.routines.list.finish(routines);
                }
            },
        );
    }

    fn choose_routine_bot(&mut self, bot_id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.routines.bot_id.as_deref() == Some(bot_id.as_str()) {
            return;
        }
        self.routines.close();
        self.routines.bot_id = Some(bot_id);
        self.routines.list = Loaded::default();
        self.load_routines(window, cx);
        cx.notify();
    }

    fn replace_routine(&mut self, routine: Routine) {
        if let Some(routines) = &mut self.routines.list.value {
            match routines
                .iter_mut()
                .find(|existing| existing.id == routine.id)
            {
                Some(existing) => *existing = routine,
                None => routines.push(routine),
            }
        }
    }

    fn start_new_routine(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = &mut self.routines;
        view.close();
        view.mode = Mode::Create;
        view.notify = true;
        view.in_chat = false;
        ui::set_input(&view.name, "", window, cx);
        ui::set_textarea(&view.prompt, "", window, cx);
        ui::set_input(&view.crons, "", window, cx);
        ui::set_input(&view.timezone, "", window, cx);
        view.name.update(cx, |name, cx| name.focus(window, cx));
        cx.notify();
    }

    fn edit_routine(&mut self, routine_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(routine) = self
            .routines
            .list
            .value
            .as_ref()
            .and_then(|routines| routines.iter().find(|routine| routine.id == routine_id))
            .cloned()
        else {
            return;
        };
        let view = &mut self.routines;
        view.close();
        ui::set_input(&view.name, &routine.name, window, cx);
        ui::set_textarea(&view.prompt, &routine.prompt, window, cx);
        ui::set_input(&view.crons, &routine.crons.join(", "), window, cx);
        ui::set_input(&view.timezone, &routine.timezone, window, cx);
        view.notify = routine.notify;
        view.in_chat = routine.in_chat;
        view.snapshot = Some(routine);
        view.mode = Mode::Edit(routine_id);
        self.load_routine_history(false, window, cx);
        cx.notify();
    }

    fn load_routine_history(&mut self, more: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Mode::Edit(routine_id) = self.routines.mode.clone() else {
            return;
        };
        let before = if more {
            self.routines.history_cursor.clone()
        } else {
            None
        };
        if more {
            if before.is_none() || self.routines.history_more {
                return;
            }
            self.routines.history_more = true;
        } else {
            self.routines.history.begin();
        }
        let remote = self.remote.clone();
        let asked = routine_id.clone();
        self.request(
            window,
            cx,
            async move {
                remote
                    .space()
                    .routine_history(&asked, before.as_ref(), Some(HISTORY_PAGE))
                    .await
            },
            move |panel, history, _, _| {
                let view = &mut panel.routines;
                if view.mode != Mode::Edit(routine_id) {
                    return;
                }
                if more {
                    view.history_more = false;
                    match history {
                        Ok(history) => {
                            view.history_cursor = history.next_cursor;
                            if let Some(runs) = &mut view.history.value {
                                runs.extend(history.runs);
                            }
                        }
                        Err(failure) => {
                            view.problem = Some(failure.sentence("load earlier runs").into());
                        }
                    }
                } else {
                    view.history.finish(history.map(|history| {
                        view.history_cursor = history.next_cursor;
                        history.runs
                    }));
                }
            },
        );
    }

    fn create_routine(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = &self.routines;
        let Some(bot_id) = view.bot_id.clone() else {
            return;
        };
        let name = view.name.read(cx).value().trim().to_owned();
        let prompt = view.prompt.read(cx).value().trim().to_owned();
        let crons = view.typed_crons(cx);
        let timezone = view.timezone.read(cx).value().trim().to_owned();
        let (notify, in_chat) = (view.notify, view.in_chat);
        if name.is_empty() || prompt.is_empty() || view.saving {
            return;
        }
        self.routines.saving = true;
        self.routines.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let crons: Vec<&str> = crons.iter().map(String::as_str).collect();
                let input = CreateRoutine {
                    bot_id: &bot_id,
                    name: &name,
                    prompt: &prompt,
                    crons: (!crons.is_empty()).then_some(crons.as_slice()),
                    timezone: (!timezone.is_empty()).then_some(timezone.as_str()),
                    // The server creates routines paused unless told otherwise.
                    active: Some(!crons.is_empty()),
                    notify: Some(notify),
                    in_chat: Some(in_chat),
                    ..Default::default()
                };
                remote.space().create_routine(&input).await
            },
            |panel, created, window, cx| {
                panel.routines.saving = false;
                match created {
                    Ok(routine) => {
                        let (id, name) = (routine.id.clone(), routine.name.clone());
                        panel.replace_routine(routine);
                        panel.toast(format!("Created {name}."), None, cx);
                        panel.edit_routine(id, window, cx);
                    }
                    Err(failure) => {
                        panel.routines.problem =
                            Some(failure.sentence("create this routine").into());
                    }
                }
            },
        );
    }

    fn save_routine(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = &self.routines;
        let Some(routine) = view.snapshot.clone() else {
            return;
        };
        let name = view.name.read(cx).value().trim().to_owned();
        let prompt = view.prompt.read(cx).value().to_string();
        let crons = view.typed_crons(cx);
        let timezone = view.timezone.read(cx).value().trim().to_owned();
        if name.is_empty() || prompt.trim().is_empty() || view.saving {
            return;
        }
        let name = (name != routine.name).then_some(name);
        let prompt = (prompt != routine.prompt).then_some(prompt);
        let crons = (crons != routine.crons).then_some(crons);
        let timezone = (timezone != routine.timezone && !timezone.is_empty()).then_some(timezone);
        let notify = (view.notify != routine.notify).then_some(view.notify);
        let in_chat = (view.in_chat != routine.in_chat).then_some(view.in_chat);
        self.routines.saving = true;
        self.routines.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let crons: Option<Vec<&str>> = crons
                    .as_ref()
                    .map(|crons| crons.iter().map(String::as_str).collect());
                let update = RoutineUpdate {
                    name: name.as_deref(),
                    prompt: prompt.as_deref(),
                    crons: crons.as_deref(),
                    timezone: timezone.as_deref(),
                    notify,
                    in_chat,
                    ..Default::default()
                };
                remote.space().update_routine(&routine.id, &update).await
            },
            |panel, saved, window, cx| {
                panel.routines.saving = false;
                match saved {
                    Ok(routine) => {
                        let id = routine.id.clone();
                        panel.replace_routine(routine);
                        panel.toast("Saved.", None, cx);
                        panel.edit_routine(id, window, cx);
                    }
                    Err(failure) => {
                        panel.routines.problem = Some(failure.sentence("save this routine").into());
                    }
                }
            },
        );
    }

    fn set_routine_active(
        &mut self,
        routine_id: String,
        active: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.routines.toggling = Some(routine_id.clone());
        self.routines.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let update = RoutineUpdate {
                    active: Some(active),
                    ..Default::default()
                };
                remote.space().update_routine(&routine_id, &update).await
            },
            |panel, saved, _, _| {
                panel.routines.toggling = None;
                match saved {
                    Ok(routine) => {
                        if let Some(open) = &mut panel.routines.snapshot {
                            if open.id == routine.id {
                                open.active = routine.active;
                                open.next_run_at = routine.next_run_at.clone();
                            }
                        }
                        panel.replace_routine(routine);
                    }
                    Err(failure) => {
                        panel.routines.problem =
                            Some(failure.sentence("pause or resume this routine").into());
                    }
                }
            },
        );
        cx.notify();
    }

    fn run_routine_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Mode::Edit(routine_id) = self.routines.mode.clone() else {
            return;
        };
        if self.routines.running {
            return;
        }
        self.routines.running = true;
        self.routines.problem = None;
        let nonce = uuid::Uuid::new_v4().to_string();
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().test_routine(&routine_id, Some(&nonce)).await },
            |panel, started, window, cx| {
                panel.routines.running = false;
                match started {
                    Ok(_) => {
                        panel.toast("Started. Follow it under Activity.", None, cx);
                        panel.load_routine_history(false, window, cx);
                    }
                    Err(failure) => {
                        panel.routines.problem = Some(failure.sentence("run this routine").into());
                    }
                }
            },
        );
        cx.notify();
    }

    fn remove_routine(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(routine) = self.routines.snapshot.clone() else {
            return;
        };
        self.routines.removing = true;
        self.routines.confirm_remove = false;
        let remote = self.remote.clone();
        let routine_id = routine.id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().remove_routine(&routine_id).await },
            move |panel, removed, _, cx| {
                panel.routines.removing = false;
                match removed {
                    Ok(()) => {
                        if let Some(routines) = &mut panel.routines.list.value {
                            routines.retain(|existing| existing.id != routine.id);
                        }
                        panel.routines.close();
                        panel.toast(format!("Removed {}.", routine.name), None, cx);
                    }
                    Err(failure) => {
                        panel.routines.problem =
                            Some(failure.sentence("remove this routine").into());
                    }
                }
            },
        );
        cx.notify();
    }

    pub(crate) fn render_routines(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let t = tokens(cx);
        match self.routines.mode.clone() {
            Mode::List => self.render_routine_list(&t, cx),
            Mode::Create => self.render_routine_form(None, &t, window, cx),
            Mode::Edit(_) => {
                let routine = self.routines.snapshot.clone();
                self.render_routine_form(routine, &t, window, cx)
            }
        }
    }

    fn render_routine_list(&mut self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let view = &self.routines;
        let header = section_header(
            "Routines",
            view.bot_id.is_some().then(|| {
                Action::new("new-routine", "New routine")
                    .tone(Tone::Primary)
                    .glyph(Glyph::Plus)
                    .on_click(
                        cx.listener(|panel, _, window, cx| panel.start_new_routine(window, cx)),
                    )
            }),
            t,
        );
        let retry_bots = Action::new("retry-routine-bots", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_bots(window, cx)));
        if let Some(placeholder) = placeholder(&self.bots, "load the bots", retry_bots, t) {
            return div().flex().flex_col().child(header).child(placeholder);
        }
        let bots = self.bots.value.as_deref().unwrap_or_default();
        if bots.is_empty() {
            return div().flex().flex_col().child(header).child(ui::notice(
                "Routines belong to a bot. Create a bot first.",
                None,
                t,
            ));
        }
        let picker = div()
            .flex()
            .flex_wrap()
            .gap_1()
            .pb_3()
            .children(bots.iter().map(|bot| {
                let id = bot.id.clone();
                Action::new(
                    SharedString::from(format!("routine-bot-{}", bot.id)),
                    bot.name.clone(),
                )
                .small()
                .selected(view.bot_id.as_deref() == Some(bot.id.as_str()))
                .on_click(cx.listener(move |panel, _, window, cx| {
                    panel.choose_routine_bot(id.clone(), window, cx)
                }))
            }));
        let retry = Action::new("retry-routines", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_routines(window, cx)));
        let list = match placeholder(&view.list, "load this bot's routines", retry, t) {
            Some(placeholder) => placeholder,
            None => {
                let routines = view.list.value.as_deref().unwrap_or_default();
                if routines.is_empty() {
                    ui::notice("This bot has no routines yet.", None, t)
                } else {
                    div()
                        .flex()
                        .flex_col()
                        .children(routines.iter().map(|routine| {
                            let (edit_id, toggle_id) = (routine.id.clone(), routine.id.clone());
                            Row::new(
                                SharedString::from(format!("routine-{}", routine.id)),
                                routine.name.clone(),
                            )
                            .leading(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(gpui_kit::px(40.))
                                    .child(icon(Glyph::CalendarClock, 16., t.ink_secondary)),
                            )
                            .detail(summary(routine))
                            .trailing(
                                Toggle::new(
                                    SharedString::from(format!("routine-active-{}", routine.id)),
                                    format!("{} is on", routine.name),
                                    routine.active,
                                )
                                .disabled(
                                    read_only(routine)
                                        || view.toggling.as_deref() == Some(routine.id.as_str()),
                                )
                                .on_change(cx.listener(
                                    move |panel, on: &bool, window, cx| {
                                        panel.set_routine_active(toggle_id.clone(), *on, window, cx)
                                    },
                                )),
                            )
                            .trailing(icon(Glyph::ChevronRight, 16., t.ink_tertiary))
                            .on_click(cx.listener(
                                move |panel, _, window, cx| {
                                    panel.edit_routine(edit_id.clone(), window, cx)
                                },
                            ))
                        }))
                }
            }
        };
        div()
            .flex()
            .flex_col()
            .child(header)
            .child(picker)
            .when_some(view.problem.clone(), |this, problem| {
                this.child(div().pb_3().child(ui::problem_line(problem, t)))
            })
            .child(list)
    }

    fn render_routine_form(
        &mut self,
        routine: Option<Routine>,
        t: &Tokens,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let view = &self.routines;
        let locked = routine.as_ref().is_some_and(read_only);
        let incomplete = view.name.read(cx).value().trim().is_empty()
            || view.prompt.read(cx).value().trim().is_empty();
        let back = Action::icon("routines-back", Glyph::ChevronLeft, "Back to routines").on_click(
            cx.listener(|panel, _, _, cx| {
                panel.routines.close();
                cx.notify();
            }),
        );
        let title: SharedString = match &routine {
            Some(routine) => routine.name.clone().into(),
            None => "New routine".into(),
        };
        let run_now = routine.as_ref().map(|_| {
            Action::new("run-routine", "Run now")
                .glyph(Glyph::Play)
                .busy(view.running)
                .on_click(cx.listener(|panel, _, window, cx| panel.run_routine_now(window, cx)))
        });

        let typed = view.typed_crons(cx);
        let reading = match typed.as_slice() {
            [] => "No schedule: it runs only when started by hand.".to_owned(),
            crons => crons
                .iter()
                .map(|cron| schedule(cron))
                .collect::<Vec<_>>()
                .join(", "),
        };
        let presets = div()
            .flex()
            .flex_wrap()
            .gap_1()
            .children(PRESETS.iter().map(|(label, cron)| {
                Action::new(SharedString::from(format!("preset-{cron}")), *label)
                    .small()
                    .selected(typed.len() == 1 && typed[0] == *cron)
                    .on_click(cx.listener(move |panel, _, window, cx| {
                        ui::set_input(&panel.routines.crons, cron, window, cx);
                        cx.notify();
                    }))
            }));
        let schedule_field = div()
            .flex()
            .flex_col()
            .gap_2()
            .child(presets)
            .child(ui::text_field(
                &view.crons,
                "Cron schedule",
                false,
                window,
                cx,
            ))
            .child(ui::meta(reading, t));

        let submit = match &routine {
            Some(_) => Action::new("save-routine", "Save")
                .tone(Tone::Primary)
                .disabled(incomplete || !view.dirty(cx))
                .busy(view.saving)
                .on_click(cx.listener(|panel, _, window, cx| panel.save_routine(window, cx))),
            None => Action::new("create-routine", "Create routine")
                .tone(Tone::Primary)
                .disabled(incomplete)
                .busy(view.saving)
                .on_click(cx.listener(|panel, _, window, cx| panel.create_routine(window, cx))),
        };

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(detail_header(title, back, run_now, t).pb_0())
            .when(locked, |this| {
                this.child(ui::body(
                    "This routine is managed elsewhere and can't be changed here.",
                    t.ink_secondary,
                ))
            })
            .child(ui::labelled(
                "Name",
                ui::text_field(&view.name, "Name", false, window, cx),
                None,
                cx,
            ))
            .child(ui::labelled(
                "What to do",
                ui::text_area(&view.prompt, "What to do", false, window, cx),
                None,
                cx,
            ))
            .child(ui::labelled("Schedule", schedule_field, None, cx))
            .child(ui::labelled(
                "Time zone",
                ui::text_field(&view.timezone, "Time zone", false, window, cx),
                None,
                cx,
            ))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(ui::setting_row(
                        "Notify me when it runs",
                        None,
                        Toggle::new("routine-notify", "Notify me when it runs", view.notify)
                            .disabled(locked)
                            .on_change(cx.listener(|panel, on: &bool, _, cx| {
                                panel.routines.notify = *on;
                                cx.notify();
                            })),
                        t,
                    ))
                    .child(ui::setting_row(
                        "Post the result in the chat",
                        None,
                        Toggle::new(
                            "routine-in-chat",
                            "Post the result in the chat",
                            view.in_chat,
                        )
                        .disabled(locked)
                        .on_change(cx.listener(
                            |panel, on: &bool, _, cx| {
                                panel.routines.in_chat = *on;
                                cx.notify();
                            },
                        )),
                        t,
                    )),
            )
            .when_some(view.problem.clone(), |this, problem| {
                this.child(ui::problem_line(problem, t))
            })
            .when(!locked, |this| this.child(div().flex().child(submit)))
            .when_some(routine, |this, routine| {
                this.child(ui::divider(t))
                    .child(self.render_routine_history(&routine, t, cx))
                    .when(!locked, |this| {
                        this.child(ui::divider(t))
                            .child(self.render_routine_removal(t, cx))
                    })
            })
    }

    fn render_routine_history(&self, routine: &Routine, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let view = &self.routines;
        let times = [
            routine
                .next_run_at
                .as_ref()
                .filter(|_| routine.active)
                .map(|next| format!("Next run {}", date_time(next))),
            routine
                .last_run_at
                .as_ref()
                .map(|last| format!("Last run {}", date_time(last))),
            routine
                .schedule_delayed
                .filter(|delayed| *delayed)
                .map(|_| "Its schedule is running late.".to_owned()),
        ];
        let retry = Action::new("retry-history", "Try again").on_click(
            cx.listener(|panel, _, window, cx| panel.load_routine_history(false, window, cx)),
        );
        let runs = match placeholder(&view.history, "load this routine's runs", retry, t) {
            Some(placeholder) => placeholder,
            None => {
                let runs = view.history.value.as_deref().unwrap_or_default();
                if runs.is_empty() {
                    ui::notice("It hasn't run yet.", None, t)
                } else {
                    div().flex().flex_col().children(runs.iter().map(|run| {
                        let failed = run.status == "failed";
                        div()
                            .flex()
                            .flex_col()
                            .py_1p5()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .child(ui::chip(
                                        sentence_case(&run.status),
                                        if failed { t.danger } else { t.ink_secondary },
                                        t,
                                    ))
                                    .child(ui::meta(
                                        date_time(
                                            run.started_at.as_ref().unwrap_or(&run.created_at),
                                        ),
                                        t,
                                    )),
                            )
                            .when_some(run.error.clone(), |this, error| {
                                this.child(div().pt_1().child(ui::body(error, t.ink_secondary)))
                            })
                    }))
                }
            }
        };
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(ui::group_label("Runs", t))
            .children(times.into_iter().flatten().map(|line| ui::meta(line, t)))
            .child(runs)
            .when(view.history_cursor.is_some(), |this| {
                this.child(
                    div().flex().pt_1().child(
                        Action::new("more-history", "Show earlier runs")
                            .small()
                            .busy(view.history_more)
                            .on_click(cx.listener(|panel, _, window, cx| {
                                panel.load_routine_history(true, window, cx)
                            })),
                    ),
                )
            })
    }

    fn render_routine_removal(&self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let view = &self.routines;
        if view.confirm_remove {
            return div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_2()
                .child(ui::body("This can't be undone.", t.ink_secondary))
                .child(
                    Action::new("confirm-remove-routine", "Remove routine")
                        .tone(Tone::Danger)
                        .small()
                        .on_click(
                            cx.listener(|panel, _, window, cx| panel.remove_routine(window, cx)),
                        ),
                )
                .child(
                    Action::new("keep-routine", "Keep")
                        .small()
                        .on_click(cx.listener(|panel, _, _, cx| {
                            panel.routines.confirm_remove = false;
                            cx.notify();
                        })),
                );
        }
        div().flex().child(
            Action::new("remove-routine", "Remove routine")
                .tone(Tone::DangerLink)
                .glyph(Glyph::Trash)
                .busy(view.removing)
                .on_click(cx.listener(|panel, _, _, cx| {
                    panel.routines.confirm_remove = true;
                    cx.notify();
                })),
        )
    }
}
