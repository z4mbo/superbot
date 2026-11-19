use gpui_kit::component::input::{InputState, TextareaState};
use gpui_kit::prelude::*;
use gpui_kit::{div, App, Div, Entity, SharedString, Window};
use superbot_features::{Bot, BotSettings, CreateBot, ModelSelection, Patch, ThinkingLevel};

use crate::icons::{icon, Glyph};
use crate::panel::{
    detail_header, placeholder, section_header, Loaded, PanelEvent, Undo, WorkspacePanel,
};
use crate::remote::Failure;
use crate::theme::{tokens, Tokens};
use crate::ui::{self, Action, Row, Toggle, Tone};

#[derive(Clone, PartialEq, Eq)]
enum Mode {
    List,
    Create,
    Edit(String),
}

#[derive(Clone, Copy)]
enum Flag {
    NotifyOnFinish,
    Pinned,
}

const THINKING: [(&str, Option<ThinkingLevel>); 5] = [
    ("Default", None),
    ("Off", Some(ThinkingLevel::Off)),
    ("Low", Some(ThinkingLevel::Low)),
    ("Medium", Some(ThinkingLevel::Medium)),
    ("High", Some(ThinkingLevel::High)),
];

fn same_thinking(a: Option<ThinkingLevel>, b: Option<ThinkingLevel>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => std::mem::discriminant(&a) == std::mem::discriminant(&b),
        _ => false,
    }
}

pub(crate) struct BotsView {
    mode: Mode,
    name: Entity<InputState>,
    description: Entity<InputState>,
    instructions: Entity<TextareaState>,
    /// The bot as the server last returned it; the editor's baseline.
    snapshot: Option<Bot>,
    saving: bool,
    busy: Option<&'static str>,
    problem: Option<SharedString>,
    archived: Loaded<Vec<Bot>>,
    show_archived: bool,
}

impl BotsView {
    pub(crate) fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            mode: Mode::List,
            name: ui::new_input("Name", window, cx),
            description: ui::new_input("What this bot is for", window, cx),
            instructions: ui::new_textarea("How this bot should behave", (6, 18), window, cx),
            snapshot: None,
            saving: false,
            busy: None,
            problem: None,
            archived: Loaded::default(),
            show_archived: false,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.close();
        self.archived = Loaded::default();
        self.show_archived = false;
    }

    pub(crate) fn close(&mut self) {
        self.mode = Mode::List;
        self.snapshot = None;
        self.saving = false;
        self.busy = None;
        self.problem = None;
    }

    fn fill(&self, bot: &Bot, window: &mut Window, cx: &mut App) {
        ui::set_input(&self.name, &bot.name, window, cx);
        ui::set_input(&self.description, &bot.description, window, cx);
        ui::set_textarea(&self.instructions, &bot.instructions, window, cx);
    }

    fn typed(&self, cx: &App) -> (String, String, String) {
        (
            self.name.read(cx).value().trim().to_owned(),
            self.description.read(cx).value().trim().to_owned(),
            self.instructions.read(cx).value().to_string(),
        )
    }

    fn dirty(&self, cx: &App) -> bool {
        let (name, description, instructions) = self.typed(cx);
        self.snapshot.as_ref().is_some_and(|bot| {
            name != bot.name || description != bot.description || instructions != bot.instructions
        })
    }
}

impl WorkspacePanel {
    pub(crate) fn refresh_bots(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.bots_view.show_archived {
            self.load_archived_bots(window, cx);
        }
    }

    pub(crate) fn replace_bot(&mut self, bot: Bot) {
        if let Some(bots) = &mut self.bots.value {
            match bots.iter_mut().find(|existing| existing.id == bot.id) {
                Some(existing) => *existing = bot,
                None => bots.push(bot),
            }
        }
    }

    fn start_new_bot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = &mut self.bots_view;
        view.close();
        view.mode = Mode::Create;
        ui::set_input(&view.name, "", window, cx);
        ui::set_input(&view.description, "", window, cx);
        ui::set_textarea(&view.instructions, "", window, cx);
        view.name.update(cx, |name, cx| name.focus(window, cx));
        cx.notify();
    }

    fn edit_bot(&mut self, bot_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bot) = self
            .bots
            .value
            .as_ref()
            .and_then(|bots| bots.iter().find(|bot| bot.id == bot_id))
            .cloned()
        else {
            return;
        };
        self.bots_view.close();
        self.bots_view.fill(&bot, window, cx);
        self.bots_view.snapshot = Some(bot);
        self.bots_view.mode = Mode::Edit(bot_id.clone());
        cx.notify();

        let remote = self.remote.clone();
        let requested = bot_id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().bot(&requested).await },
            move |panel, fresh, window, cx| {
                let view = &panel.bots_view;
                if view.mode != Mode::Edit(bot_id) {
                    return;
                }
                match fresh {
                    Ok(fresh) => {
                        if !view.dirty(cx) {
                            view.fill(&fresh, window, cx);
                        }
                        panel.replace_bot(fresh.clone());
                        panel.bots_view.snapshot = Some(fresh);
                    }
                    Err(failure) => {
                        panel.bots_view.problem =
                            Some(failure.sentence("read this bot's latest settings").into());
                    }
                }
            },
        );
    }

    fn create_bot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (name, description, instructions) = self.bots_view.typed(cx);
        if name.is_empty() || self.bots_view.saving {
            return;
        }
        self.bots_view.saving = true;
        self.bots_view.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let input = CreateBot {
                    name: &name,
                    description: (!description.is_empty()).then_some(description.as_str()),
                    instructions: (!instructions.trim().is_empty())
                        .then_some(instructions.as_str()),
                    ..Default::default()
                };
                remote.space().create_bot(&input).await
            },
            |panel, created, window, cx| {
                panel.bots_view.saving = false;
                match created {
                    Ok(bot) => {
                        let (id, name) = (bot.id.clone(), bot.name.clone());
                        panel.replace_bot(bot);
                        cx.emit(PanelEvent::BotsChanged);
                        panel.toast(format!("Created {name}."), None, cx);
                        panel.edit_bot(id, window, cx);
                    }
                    Err(failure) => {
                        panel.bots_view.problem = Some(failure.sentence("create this bot").into());
                    }
                }
            },
        );
    }

    fn save_bot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bot) = self.bots_view.snapshot.clone() else {
            return;
        };
        let (name, description, instructions) = self.bots_view.typed(cx);
        if name.is_empty() || self.bots_view.saving {
            return;
        }
        let name = (name != bot.name).then_some(name);
        let description = (description != bot.description).then_some(description);
        let instructions = (instructions != bot.instructions).then_some(instructions);
        let expected = instructions.as_ref().map(|_| bot.instructions.clone());
        let renamed = name.is_some();
        self.bots_view.saving = true;
        self.bots_view.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let settings = BotSettings {
                    name: name.as_deref(),
                    description: description.as_deref(),
                    instructions: instructions.as_deref(),
                    expected_instructions: expected.as_deref(),
                    ..Default::default()
                };
                remote.space().update_bot(&bot.id, &settings).await
            },
            move |panel, saved, window, cx| {
                panel.bots_view.saving = false;
                match saved {
                    Ok(bot) => {
                        panel.bots_view.fill(&bot, window, cx);
                        panel.replace_bot(bot.clone());
                        panel.bots_view.snapshot = Some(bot);
                        if renamed {
                            cx.emit(PanelEvent::BotsChanged);
                        }
                        panel.toast("Saved.", None, cx);
                    }
                    Err(Failure::Stale(_)) => {
                        panel.bots_view.problem = Some(
                            "These instructions were changed somewhere else. Reload to see the latest, then make your change again."
                                .into(),
                        );
                    }
                    Err(failure) => {
                        panel.bots_view.problem = Some(failure.sentence("save this bot").into());
                    }
                }
            },
        );
    }

    /// Applies one setting change at once and shows the server's answer.
    fn change_bot(
        &mut self,
        what: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
        change: impl for<'a> FnOnce(&mut BotSettings<'a>) + Send + 'static,
    ) {
        let Some(bot_id) = self.bots_view.snapshot.as_ref().map(|bot| bot.id.clone()) else {
            return;
        };
        self.bots_view.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let mut settings = BotSettings::default();
                change(&mut settings);
                remote.space().update_bot(&bot_id, &settings).await
            },
            move |panel, saved, _, _| match saved {
                Ok(bot) => {
                    panel.replace_bot(bot.clone());
                    if panel
                        .bots_view
                        .snapshot
                        .as_ref()
                        .is_some_and(|open| open.id == bot.id)
                    {
                        // Typed text stays; only the flags move to the server's answer.
                        let typed = panel.bots_view.snapshot.take();
                        panel.bots_view.snapshot = typed.map(|typed| Bot {
                            name: typed.name,
                            description: typed.description,
                            instructions: typed.instructions,
                            ..bot
                        });
                    }
                }
                Err(failure) => {
                    panel.bots_view.problem = Some(failure.sentence(what).into());
                }
            },
        );
    }

    fn set_bot_flag(&mut self, flag: Flag, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(bot) = &mut self.bots_view.snapshot {
            match flag {
                Flag::NotifyOnFinish => bot.notify_on_finish = on,
                Flag::Pinned => bot.pinned = on,
            }
        }
        self.change_bot(
            "change this setting",
            window,
            cx,
            move |settings| match flag {
                Flag::NotifyOnFinish => settings.notify_on_finish = Some(on),
                Flag::Pinned => settings.pinned = Some(on),
            },
        );
        cx.notify();
    }

    fn set_bot_thinking(
        &mut self,
        level: Option<ThinkingLevel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(bot) = &mut self.bots_view.snapshot {
            bot.thinking_level = level;
        }
        self.change_bot(
            "change how much this bot thinks",
            window,
            cx,
            move |settings| {
                settings.thinking_level = match level {
                    Some(level) => Patch::Set(level),
                    None => Patch::Clear,
                };
            },
        );
        cx.notify();
    }

    fn clear_bot_model(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.change_bot("change this bot's model", window, cx, |settings| {
            settings.model = Some(ModelSelection::clear());
        });
    }

    fn duplicate_bot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bot_id) = self.bots_view.snapshot.as_ref().map(|bot| bot.id.clone()) else {
            return;
        };
        self.bots_view.busy = Some("duplicate");
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().duplicate_bot(&bot_id).await },
            |panel, copy, window, cx| {
                panel.bots_view.busy = None;
                match copy {
                    Ok(copy) => {
                        let (id, name) = (copy.id.clone(), copy.name.clone());
                        panel.replace_bot(copy);
                        cx.emit(PanelEvent::BotsChanged);
                        panel.toast(format!("Created {name}."), None, cx);
                        panel.edit_bot(id, window, cx);
                    }
                    Err(failure) => {
                        panel.bots_view.problem =
                            Some(failure.sentence("duplicate this bot").into());
                    }
                }
            },
        );
    }

    fn archive_bot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bot) = self.bots_view.snapshot.clone() else {
            return;
        };
        self.bots_view.busy = Some("archive");
        let remote = self.remote.clone();
        let bot_id = bot.id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().archive_bot(&bot_id).await },
            move |panel, archived, window, cx| {
                panel.bots_view.busy = None;
                match archived {
                    Ok(()) => {
                        if let Some(bots) = &mut panel.bots.value {
                            bots.retain(|existing| existing.id != bot.id);
                        }
                        panel.bots_view.close();
                        cx.emit(PanelEvent::BotsChanged);
                        panel.toast(
                            format!("Archived {}.", bot.name),
                            Some(Undo::RestoreBot(bot.id)),
                            cx,
                        );
                        panel.refresh_bots(window, cx);
                    }
                    Err(failure) => {
                        panel.bots_view.problem = Some(failure.sentence("archive this bot").into());
                    }
                }
            },
        );
    }

    pub(crate) fn restore_bot(
        &mut self,
        bot_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.bots_view.busy = Some("restore");
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().restore_bot(&bot_id).await },
            |panel, restored, window, cx| {
                panel.bots_view.busy = None;
                match restored {
                    Ok(()) => {
                        cx.emit(PanelEvent::BotsChanged);
                        panel.load_bots(window, cx);
                        panel.refresh_bots(window, cx);
                    }
                    Err(failure) => {
                        panel.toast(failure.sentence("restore this bot"), None, cx);
                    }
                }
            },
        );
    }

    fn load_archived_bots(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.bots_view.archived.loading {
            return;
        }
        self.bots_view.archived.begin();
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().list_archived_bots().await },
            |panel, archived, _, _| panel.bots_view.archived.finish(archived),
        );
    }

    fn toggle_archived_bots(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.bots_view.show_archived = !self.bots_view.show_archived;
        if self.bots_view.show_archived {
            self.load_archived_bots(window, cx);
        }
        cx.notify();
    }

    pub(crate) fn render_bots(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let t = tokens(cx);
        match self.bots_view.mode.clone() {
            Mode::List => self.render_bot_list(&t, cx),
            Mode::Create => self.render_bot_form(None, &t, window, cx),
            Mode::Edit(_) => {
                let bot = self.bots_view.snapshot.clone();
                self.render_bot_form(bot, &t, window, cx)
            }
        }
    }

    fn render_bot_list(&mut self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let header = section_header(
            "Bots",
            [Action::new("new-bot", "New bot")
                .tone(Tone::Primary)
                .glyph(Glyph::Plus)
                .on_click(cx.listener(|panel, _, window, cx| panel.start_new_bot(window, cx)))],
            t,
        );
        let retry = Action::new("retry-bots", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_bots(window, cx)));
        let list = match placeholder(&self.bots, "load the bots", retry, t) {
            Some(placeholder) => placeholder,
            None => {
                let bots = self.bots.value.as_deref().unwrap_or_default();
                if bots.is_empty() {
                    ui::notice("No bots in this space yet.", None, t)
                } else {
                    div().flex().flex_col().children(bots.iter().map(|bot| {
                        let id = bot.id.clone();
                        let detail = if bot.description.is_empty() {
                            bot.preview.clone()
                        } else {
                            bot.description.clone()
                        };
                        Row::new(
                            SharedString::from(format!("bot-{}", bot.id)),
                            bot.name.clone(),
                        )
                        .leading(ui::bot_face(t.identity_for(&bot.color), 40.))
                        .detail(detail)
                        .when(bot.pinned, |row| {
                            row.trailing(icon(Glyph::Pin, 14., t.ink_tertiary))
                        })
                        .trailing(icon(Glyph::ChevronRight, 16., t.ink_tertiary))
                        .on_click(cx.listener(
                            move |panel, _, window, cx| panel.edit_bot(id.clone(), window, cx),
                        ))
                    }))
                }
            }
        };

        let view = &self.bots_view;
        let archived = div()
            .flex()
            .flex_col()
            .pt_4()
            .child(
                div().flex().child(
                    Action::new(
                        "toggle-archived-bots",
                        if view.show_archived {
                            "Hide archived"
                        } else {
                            "Show archived"
                        },
                    )
                    .tone(Tone::Quiet)
                    .small()
                    .glyph(Glyph::Archive)
                    .on_click(
                        cx.listener(|panel, _, window, cx| panel.toggle_archived_bots(window, cx)),
                    ),
                ),
            )
            .when(view.show_archived, |this| {
                let retry = Action::new("retry-archived-bots", "Try again").on_click(
                    cx.listener(|panel, _, window, cx| panel.load_archived_bots(window, cx)),
                );
                this.child(
                    match placeholder(&view.archived, "load archived bots", retry, t) {
                        Some(placeholder) => placeholder,
                        None => {
                            let bots = view.archived.value.as_deref().unwrap_or_default();
                            if bots.is_empty() {
                                ui::notice("No archived bots.", None, t)
                            } else {
                                div().flex().flex_col().children(bots.iter().map(|bot| {
                                    let id = bot.id.clone();
                                    Row::new(
                                        SharedString::from(format!("archived-bot-{}", bot.id)),
                                        bot.name.clone(),
                                    )
                                    .leading(
                                        ui::bot_face(t.identity_for(&bot.color), 40.).opacity(0.6),
                                    )
                                    .detail(bot.description.clone())
                                    .trailing(
                                        Action::new(
                                            SharedString::from(format!("restore-bot-{}", bot.id)),
                                            "Restore",
                                        )
                                        .small()
                                        .glyph(Glyph::ArchiveRestore)
                                        .disabled(view.busy == Some("restore"))
                                        .on_click(
                                            cx.listener(move |panel, _, window, cx| {
                                                panel.restore_bot(id.clone(), window, cx)
                                            }),
                                        ),
                                    )
                                }))
                            }
                        }
                    },
                )
            });

        div()
            .flex()
            .flex_col()
            .child(header)
            .when_some(
                self.bots
                    .failure
                    .as_ref()
                    .filter(|_| self.bots.value.is_some()),
                |this, failure| {
                    this.child(ui::problem_line(failure.sentence("refresh the bots"), t))
                },
            )
            .child(list)
            .child(archived)
    }

    fn render_bot_form(
        &mut self,
        bot: Option<Bot>,
        t: &Tokens,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let view = &self.bots_view;
        let name_missing = view.name.read(cx).value().trim().is_empty();
        let back = Action::icon("bots-back", Glyph::ChevronLeft, "Back to bots").on_click(
            cx.listener(|panel, _, _, cx| {
                panel.bots_view.close();
                cx.notify();
            }),
        );
        let title: SharedString = match &bot {
            Some(bot) => bot.name.clone().into(),
            None => "New bot".into(),
        };
        let open_chat = bot.as_ref().map(|bot| {
            let bot_id = bot.id.clone();
            Action::new("open-bot-chat", "Open chat")
                .glyph(Glyph::MessageSquare)
                .on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(PanelEvent::OpenBot {
                        bot_id: bot_id.clone(),
                    })
                }))
        });

        let fields = div()
            .flex()
            .flex_col()
            .gap_4()
            .child(ui::labelled(
                "Name",
                ui::text_field(&view.name, "Name", false, window, cx),
                None,
                cx,
            ))
            .child(ui::labelled(
                "Description",
                ui::text_field(&view.description, "Description", false, window, cx),
                None,
                cx,
            ))
            .child(ui::labelled(
                "Instructions",
                ui::text_area(&view.instructions, "Instructions", false, window, cx),
                None,
                cx,
            ));

        let submit = match &bot {
            Some(_) => Action::new("save-bot", "Save")
                .tone(Tone::Primary)
                .disabled(name_missing || !view.dirty(cx))
                .busy(view.saving)
                .on_click(cx.listener(|panel, _, window, cx| panel.save_bot(window, cx))),
            None => Action::new("create-bot", "Create bot")
                .tone(Tone::Primary)
                .disabled(name_missing)
                .busy(view.saving)
                .on_click(cx.listener(|panel, _, window, cx| panel.create_bot(window, cx))),
        };
        let reload = bot.as_ref().filter(|_| view.problem.is_some()).map(|bot| {
            let bot_id = bot.id.clone();
            Action::new("reload-bot", "Reload")
                .tone(Tone::Link)
                .on_click(cx.listener(move |panel, _, window, cx| {
                    panel.edit_bot(bot_id.clone(), window, cx)
                }))
        });

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(detail_header(title, back, open_chat, t).pb_0())
            .child(fields)
            .when_some(view.problem.clone(), |this, problem| {
                this.child(ui::problem_line(problem, t))
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(submit)
                    .children(reload),
            )
            .when_some(bot, |this, bot| {
                this.child(ui::divider(t))
                    .child(self.render_bot_settings(&bot, t, cx))
                    .child(ui::divider(t))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child(
                                Action::new("duplicate-bot", "Duplicate")
                                    .glyph(Glyph::Copy)
                                    .busy(self.bots_view.busy == Some("duplicate"))
                                    .on_click(cx.listener(|panel, _, window, cx| {
                                        panel.duplicate_bot(window, cx)
                                    })),
                            )
                            .child(
                                Action::new("archive-bot", "Archive")
                                    .glyph(Glyph::Archive)
                                    .busy(self.bots_view.busy == Some("archive"))
                                    .on_click(cx.listener(|panel, _, window, cx| {
                                        panel.archive_bot(window, cx)
                                    })),
                            ),
                    )
            })
    }

    fn render_bot_settings(&self, bot: &Bot, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let thinking = div()
            .flex()
            .flex_wrap()
            .gap_1()
            .children(THINKING.iter().map(|(label, level)| {
                let level = *level;
                Action::new(SharedString::from(format!("thinking-{label}")), *label)
                    .small()
                    .selected(same_thinking(bot.thinking_level, level))
                    .on_click(cx.listener(move |panel, _, window, cx| {
                        panel.set_bot_thinking(level, window, cx)
                    }))
            }));
        div()
            .flex()
            .flex_col()
            .child(ui::setting_row(
                "Notify me when it finishes",
                None,
                Toggle::new(
                    "bot-notify",
                    "Notify me when it finishes",
                    bot.notify_on_finish,
                )
                .on_change(cx.listener(|panel, on: &bool, window, cx| {
                    panel.set_bot_flag(Flag::NotifyOnFinish, *on, window, cx)
                })),
                t,
            ))
            .child(ui::setting_row(
                "Pinned",
                None,
                Toggle::new("bot-pinned", "Pinned", bot.pinned).on_change(cx.listener(
                    |panel, on: &bool, window, cx| {
                        panel.set_bot_flag(Flag::Pinned, *on, window, cx)
                    },
                )),
                t,
            ))
            .child(ui::setting_row("Thinking", None, thinking, t))
            .when_some(bot.model_id.clone(), |this, model| {
                this.child(ui::setting_row(
                    "Model",
                    Some(model.into()),
                    Action::new("clear-bot-model", "Use the space's model")
                        .tone(Tone::Link)
                        .on_click(
                            cx.listener(|panel, _, window, cx| panel.clear_bot_model(window, cx)),
                        ),
                    t,
                ))
            })
    }
}
