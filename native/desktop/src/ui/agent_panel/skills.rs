use superbot_features::{AgentSkill, AgentSkillEntry, AgentSkillSource, SkillPlaybook, TaughtSkill, TaughtSkillStatus};

use super::knowledge::{conflict_notice, divided, link_row, note_row, page_card, page_label, Load, Page};
use super::*;

#[derive(Default)]
pub(super) struct SkillsPage {
    open: Option<SkillEditor>,
    busy: bool,
    problem: Option<String>,
    notice: Option<String>,
}

impl SkillsPage {
    /// Escape inside the page: closes the open skill first.
    pub(super) fn back(&mut self) -> bool {
        self.problem = None;
        self.open.take().is_some()
    }
}

enum SkillEditor {
    Taught(TaughtEditor),
    Shared(SharedEditor),
}

/// A skill taught to this agent, open as its playbook.
struct TaughtEditor {
    skill: TaughtSkill,
    name: Entity<InputState>,
    fields: Vec<(PlaybookField, Entity<TextareaState>)>,
    /// The newer version someone saved while this was open.
    conflict: Option<TaughtSkill>,
    confirm_delete: bool,
}

/// A Space skill open as its SKILL.md; `skill` is `None` for a new one.
struct SharedEditor {
    skill: Option<AgentSkill>,
    editor: Entity<TextareaState>,
    conflict: Option<AgentSkill>,
    confirm_delete: bool,
    _watch: Subscription,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PlaybookField {
    WhenToUse,
    Inputs,
    Steps,
    HowToCheck,
    WhatToReturn,
    ApprovalBoundaries,
    FailureHandling,
}

const PLAYBOOK: [(PlaybookField, &str); 7] = [
    (PlaybookField::WhenToUse, "When to use"),
    (PlaybookField::Inputs, "Inputs"),
    (PlaybookField::Steps, "Steps"),
    (PlaybookField::HowToCheck, "How to check"),
    (PlaybookField::WhatToReturn, "What to return"),
    (PlaybookField::ApprovalBoundaries, "Approval boundaries"),
    (PlaybookField::FailureHandling, "Failure handling"),
];

fn lines(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_owned).collect()
}

impl PlaybookField {
    fn read(self, playbook: &SkillPlaybook) -> String {
        match self {
            Self::WhenToUse => playbook.when_to_use.clone(),
            Self::Inputs => playbook.inputs.join("\n"),
            Self::Steps => playbook.steps.join("\n"),
            Self::HowToCheck => playbook.how_to_check.clone(),
            Self::WhatToReturn => playbook.what_to_return.clone(),
            Self::ApprovalBoundaries => playbook.approval_boundaries.clone(),
            Self::FailureHandling => playbook.failure_handling.clone(),
        }
    }

    fn write(self, playbook: &mut SkillPlaybook, value: &str) {
        match self {
            Self::WhenToUse => playbook.when_to_use = value.trim().to_owned(),
            Self::Inputs => playbook.inputs = lines(value),
            Self::Steps => playbook.steps = lines(value),
            Self::HowToCheck => playbook.how_to_check = value.trim().to_owned(),
            Self::WhatToReturn => playbook.what_to_return = value.trim().to_owned(),
            Self::ApprovalBoundaries => playbook.approval_boundaries = value.trim().to_owned(),
            Self::FailureHandling => playbook.failure_handling = value.trim().to_owned(),
        }
    }
}

const NEW_SKILL: &str = "---\nname: my-skill\ndescription: What this skill does and when the agent should use it.\n---\n\nSteps the agent should follow.\n";

fn status_hint(skill: &TaughtSkill) -> String {
    match skill.status {
        TaughtSkillStatus::Recording => "Being shown now".into(),
        TaughtSkillStatus::Drafting => "Writing it up…".into(),
        TaughtSkillStatus::Draft => "Draft".into(),
        TaughtSkillStatus::Saved => skill.playbook.when_to_use.clone(),
    }
}

enum Saved<T> {
    Done(T),
    Tried,
    Conflict(T),
}

impl Desktop {
    fn skills_page(&mut self) -> Option<&mut SkillsPage> {
        match self.agent_panel.as_mut()?.page.as_mut()? {
            Page::Skills(page) => Some(page),
            _ => None,
        }
    }

    fn reread_skills(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = self.agent_panel.as_mut() {
            panel.knowledge.stale();
        }
        self.sync_agent_info(window, cx);
    }

    fn skill_failed(&mut self, error: &Error, cx: &mut Context<Self>) {
        if let Some(page) = self.skills_page() {
            page.busy = false;
            page.problem = Some(api::explain(error));
        }
        cx.notify();
    }

    fn begin_skill_work(&mut self) -> bool {
        let Some(page) = self.skills_page().filter(|page| !page.busy) else { return false };
        page.busy = true;
        page.problem = None;
        page.notice = None;
        true
    }

    fn taught_editor(&mut self) -> Option<&mut TaughtEditor> {
        match self.skills_page()?.open.as_mut()? {
            SkillEditor::Taught(editor) => Some(editor),
            _ => None,
        }
    }

    fn shared_editor(&mut self) -> Option<&mut SharedEditor> {
        match self.skills_page()?.open.as_mut()? {
            SkillEditor::Shared(editor) => Some(editor),
            _ => None,
        }
    }

    fn open_taught_skill(&mut self, skill: TaughtSkill, window: &mut Window, cx: &mut Context<Self>) {
        let title = skill.title();
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("Name").default_value(title));
        let fields = PLAYBOOK
            .iter()
            .map(|(field, label)| {
                let value = field.read(&skill.playbook);
                let rows = value.lines().count().clamp(1, 10);
                let state = cx.new(|cx| {
                    TextareaState::new(window, cx).auto_grow(rows, 10).placeholder(*label).default_value(value)
                });
                (*field, state)
            })
            .collect();
        if let Some(page) = self.skills_page() {
            page.problem = None;
            page.notice = None;
            page.open =
                Some(SkillEditor::Taught(TaughtEditor { skill, name, fields, conflict: None, confirm_delete: false }));
        }
        cx.notify();
    }

    fn reload_taught_skill(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.taught_editor() else { return };
        let Some(latest) = editor.conflict.take() else { return };
        let name = editor.name.clone();
        let fields = editor.fields.clone();
        let title = latest.title();
        let playbook = latest.playbook.clone();
        editor.skill = latest;
        name.update(cx, |state, cx| state.set_value(title, window, cx));
        for (field, state) in fields {
            let value = field.read(&playbook);
            state.update(cx, |state, cx| state.set_value(value, window, cx));
        }
        cx.notify();
    }

    /// Writes the playbook, checking first that nobody saved a newer one since it was opened;
    /// then saves the skill for the agent to use, or asks the agent to try it once.
    fn save_taught_skill(&mut self, try_it: bool, overwrite: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let Some(editor) = self.taught_editor() else { return };
        let base = if overwrite {
            editor.conflict.clone().unwrap_or_else(|| editor.skill.clone())
        } else {
            editor.skill.clone()
        };
        let name = editor.name.read(cx).value().trim().to_owned();
        let mut playbook = base.playbook.clone();
        for (field, state) in &editor.fields {
            field.write(&mut playbook, &state.read(cx).value());
        }
        if !self.begin_skill_work() {
            return;
        }
        let work = async move {
            let space = features.space(space);
            let latest = space.taught_skill(&base.id).await?;
            if latest.updated_at != base.updated_at {
                return Ok(Saved::Conflict(latest));
            }
            let written = space.update_taught_skill(&base.id, &name, &playbook).await?;
            if try_it {
                space.try_taught_skill(&base.id).await?;
                return Ok(Saved::Tried);
            }
            Ok(Saved::Done(space.save_taught_skill(&written.id, &name).await?))
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            let agent = this.agent_name();
            let Some(page) = this.skills_page() else { return };
            page.busy = false;
            match result {
                Ok(Saved::Conflict(latest)) => {
                    if let Some(SkillEditor::Taught(editor)) = page.open.as_mut() {
                        editor.conflict = Some(latest);
                    }
                }
                Ok(Saved::Tried) => {
                    page.open = None;
                    page.notice = Some(format!("{agent} is trying it in its chat."));
                    this.reread_skills(window, cx);
                }
                Ok(Saved::Done(_)) => {
                    page.open = None;
                    this.reread_skills(window, cx);
                }
                Err(error) => this.skill_failed(&error, cx),
            }
        });
        cx.notify();
    }

    fn remove_taught_skill(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let Some(editor) = self.taught_editor() else { return };
        if !editor.confirm_delete {
            editor.confirm_delete = true;
            cx.notify();
            return;
        }
        let id = editor.skill.id.clone();
        if !self.begin_skill_work() {
            return;
        }
        let gone = id.clone();
        self.call(
            window,
            cx,
            async move { features.space(space).remove_taught_skill(&id).await },
            move |this, result, window, cx| match result {
                Ok(()) => {
                    if let Some(page) = this.skills_page() {
                        page.busy = false;
                        page.open = None;
                    }
                    if let Some(Load::Ready(taught)) =
                        this.agent_panel.as_mut().and_then(|panel| panel.knowledge.taught.as_mut())
                    {
                        taught.retain(|skill| skill.id != gone);
                    }
                    this.reread_skills(window, cx);
                }
                Err(error) => this.skill_failed(&error, cx),
            },
        );
        cx.notify();
    }

    fn show_shared_skill(&mut self, skill: Option<AgentSkill>, window: &mut Window, cx: &mut Context<Self>) {
        let content = skill.as_ref().map_or_else(|| NEW_SKILL.to_owned(), |skill| skill.content.clone());
        let editor = cx.new(|cx| TextareaState::new(window, cx).auto_grow(10, 24).default_value(content));
        if skill.as_ref().is_none_or(|skill| !skill.read_only) {
            editor.update(cx, |state, cx| {
                let end = state.value().len();
                state.set_selected_range(end..end, cx);
                state.focus(window, cx);
            });
        }
        let watch = cx.observe(&editor, |_, _, cx| cx.notify());
        if let Some(page) = self.skills_page() {
            page.problem = None;
            page.notice = None;
            page.open = Some(SkillEditor::Shared(SharedEditor {
                skill,
                editor,
                conflict: None,
                confirm_delete: false,
                _watch: watch,
            }));
        }
        cx.notify();
    }

    fn open_shared_skill(&mut self, entry: AgentSkillEntry, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        if !self.begin_skill_work() {
            return;
        }
        self.call(
            window,
            cx,
            async move { features.space(space).agent_skill(&entry.id).await },
            |this, result, window, cx| match result {
                Ok(skill) => {
                    if let Some(page) = this.skills_page() {
                        page.busy = false;
                    }
                    this.show_shared_skill(Some(skill), window, cx);
                }
                Err(error) => this.skill_failed(&error, cx),
            },
        );
        cx.notify();
    }

    fn save_shared_skill(&mut self, overwrite: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let Some(editor) = self.shared_editor() else { return };
        let content = editor.editor.read(cx).value().to_string();
        if content.trim().is_empty() {
            return;
        }
        let base =
            if overwrite { editor.conflict.clone().or_else(|| editor.skill.clone()) } else { editor.skill.clone() };
        if !self.begin_skill_work() {
            return;
        }
        let work = async move {
            let space = features.space(space);
            let Some(base) = base else { return Ok(Saved::Done(space.create_agent_skill(&content).await?)) };
            let latest = space.agent_skill(&base.id).await?;
            if latest.updated_at != base.updated_at {
                return Ok(Saved::Conflict(latest));
            }
            Ok(Saved::Done(space.update_agent_skill(&base.id, &content).await?))
        };
        self.call(window, cx, work, |this, result, window, cx| {
            let Some(page) = this.skills_page() else { return };
            page.busy = false;
            match result {
                Ok(Saved::Conflict(latest)) => {
                    if let Some(SkillEditor::Shared(editor)) = page.open.as_mut() {
                        editor.conflict = Some(latest);
                    }
                }
                Ok(_) => {
                    page.open = None;
                    this.reread_skills(window, cx);
                }
                Err(error) => this.skill_failed(&error, cx),
            }
        });
        cx.notify();
    }

    fn reload_shared_skill(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.shared_editor() else { return };
        let Some(latest) = editor.conflict.take() else { return };
        let state = editor.editor.clone();
        let content = latest.content.clone();
        editor.skill = Some(latest);
        state.update(cx, |state, cx| state.set_value(content, window, cx));
        cx.notify();
    }

    fn remove_shared_skill(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let Some(editor) = self.shared_editor() else { return };
        let Some(id) = editor.skill.as_ref().map(|skill| skill.id.clone()) else { return };
        if !editor.confirm_delete {
            editor.confirm_delete = true;
            cx.notify();
            return;
        }
        if !self.begin_skill_work() {
            return;
        }
        self.call(
            window,
            cx,
            async move { features.space(space).remove_agent_skill(&id).await },
            |this, result, window, cx| match result {
                Ok(()) => {
                    if let Some(page) = this.skills_page() {
                        page.busy = false;
                        page.open = None;
                    }
                    this.reread_skills(window, cx);
                }
                Err(error) => this.skill_failed(&error, cx),
            },
        );
        cx.notify();
    }

    pub(super) fn render_skills_page(
        &self,
        bot: &Bot,
        page: &SkillsPage,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        match page.open.as_ref() {
            Some(SkillEditor::Taught(editor)) => return self.render_taught_editor(bot, page, editor, theme, cx),
            Some(SkillEditor::Shared(editor)) => return self.render_shared_editor(page, editor, theme, cx),
            None => {}
        }
        let knowledge = self.agent_panel.as_ref().map(|panel| &panel.knowledge);
        let hover = theme.ink_at(0.03);
        let row = |id: SharedString, title: String, hint: String, value: Option<&'static str>, opens: bool| {
            div()
                .id(id)
                .flex()
                .items_center()
                .gap(px(10.))
                .min_h(px(46.))
                .px(px(14.))
                .py(px(8.))
                .when(opens, |row| row.cursor_pointer().hover(move |style| style.bg(hover)))
                .child(
                    div().flex_1().min_w_0().child(div().name().text_color(theme.ink).truncate().child(title)).when(
                        !hint.trim().is_empty(),
                        |text| {
                            text.child(div().mt(px(1.)).body().text_color(theme.ink_secondary).truncate().child(hint))
                        },
                    ),
                )
                .children(value.map(|value| div().flex_shrink_0().meta().text_color(theme.ink_tertiary).child(value)))
                .when(opens, |row| row.child(icon("chevron-right", px(15.), theme.ink_tertiary)))
        };
        let retry = |id: &'static str, theme: &Theme, cx: &mut Context<Self>| {
            divided(link_row(id, "Try again", "rotate-cw", theme), 1, theme).on_click(cx.listener(
                |this, _, window, cx| {
                    if let Some(panel) = this.agent_panel.as_mut() {
                        panel.knowledge.stale();
                        panel.knowledge.taught = None;
                        panel.knowledge.shared = None;
                    }
                    this.sync_agent_info(window, cx);
                    cx.notify();
                },
            ))
        };

        let mut taught_card = card(theme);
        match knowledge.and_then(|knowledge| knowledge.taught.as_ref()) {
            None | Some(Load::Loading) => taught_card = taught_card.child(note_row("Loading…", false, theme)),
            Some(Load::Failed(problem)) => {
                taught_card =
                    taught_card.child(note_row(problem.clone(), true, theme)).child(retry("taught-retry", theme, cx))
            }
            Some(Load::Ready(skills)) if skills.is_empty() => {
                taught_card = taught_card.child(note_row("Nothing taught yet.", false, theme))
            }
            Some(Load::Ready(skills)) => {
                for (index, skill) in skills.iter().enumerate() {
                    let opens = skill.status.editable() && !page.busy;
                    let open = skill.clone();
                    let element = row(
                        SharedString::from(format!("taught-{}", skill.id)),
                        skill.title(),
                        status_hint(skill),
                        None,
                        skill.status.editable(),
                    )
                    .when(opens, |row| {
                        row.on_click(
                            cx.listener(move |this, _, window, cx| this.open_taught_skill(open.clone(), window, cx)),
                        )
                    });
                    taught_card = taught_card.child(divided(element, index, theme));
                }
            }
        }

        let mut shared_card = card(theme);
        match (
            knowledge.and_then(|knowledge| knowledge.shared.as_ref()),
            knowledge.and_then(|knowledge| knowledge.shared_skills()),
        ) {
            (Some(Load::Failed(problem)), _) => {
                shared_card =
                    shared_card.child(note_row(problem.clone(), true, theme)).child(retry("shared-retry", theme, cx))
            }
            (_, Some(entries)) if entries.is_empty() => {
                shared_card = shared_card.child(note_row("No skills yet.", false, theme))
            }
            (_, Some(entries)) => {
                for (index, entry) in entries.into_iter().enumerate() {
                    let open = entry.clone();
                    let element = row(
                        SharedString::from(format!("shared-{}", entry.id)),
                        entry.name.clone(),
                        entry.description.clone(),
                        (entry.source == AgentSkillSource::Builtin).then_some("Built-in"),
                        true,
                    )
                    .when(!page.busy, |row| {
                        row.on_click(
                            cx.listener(move |this, _, window, cx| this.open_shared_skill(open.clone(), window, cx)),
                        )
                    });
                    shared_card = shared_card.child(divided(element, index, theme));
                }
            }
            _ => shared_card = shared_card.child(note_row("Loading…", false, theme)),
        }
        shared_card = shared_card.child(
            divided(link_row("shared-new", "New skill", "plus", theme), 1, theme).when(!page.busy, |row| {
                row.on_click(cx.listener(|this, _, window, cx| this.show_shared_skill(None, window, cx)))
            }),
        );

        let status = page
            .problem
            .clone()
            .map(|problem| (problem, true))
            .or_else(|| page.notice.clone().map(|notice| (notice, false)))
            .map(|(text, warn)| page_card(theme).child(note_row(text, warn, theme)));

        div()
            .flex()
            .flex_col()
            .children(status)
            .child(page_label(format!("Taught to {}", bot.name), theme))
            .child(taught_card)
            .child(page_label("In this space", theme))
            .child(shared_card)
    }

    fn render_taught_editor(
        &self,
        bot: &Bot,
        page: &SkillsPage,
        editor: &TaughtEditor,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let busy = page.busy;
        let blocked = busy || editor.conflict.is_some();
        let label = |text: &'static str| {
            div().meta().font_weight(FontWeight::MEDIUM).text_color(theme.ink_tertiary).child(text)
        };
        let conflict = editor.conflict.as_ref().map(|_| {
            conflict_notice(
                "Someone saved a newer version while you were editing.",
                "Reload to see it, or overwrite it with yours.",
                theme,
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        crate::ui::pill_button("taught-reload", "Reload", crate::ui::Tone::Quiet, !busy, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.reload_taught_skill(window, cx))),
                    )
                    .child(
                        crate::ui::pill_button("taught-overwrite", "Overwrite", crate::ui::Tone::Danger, !busy, theme)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.save_taught_skill(false, true, window, cx)),
                            ),
                    ),
            )
        });
        let confirm = editor.confirm_delete;
        page_card(theme).child(
            div()
                .flex()
                .flex_col()
                .gap(px(9.))
                .px(px(14.))
                .py(px(11.))
                .children(conflict)
                .child(label("Name"))
                .child(
                    crate::ui::field_box(theme)
                        .child(Input::new(&editor.name).appearance(false).bordered(false).small().disabled(busy)),
                )
                .children(editor.fields.iter().map(|(field, state)| {
                    let text = PLAYBOOK.iter().find(|(candidate, _)| candidate == field).map_or("", |(_, label)| label);
                    div().flex().flex_col().gap_1p5().child(label(text)).child(
                        crate::ui::field_box(theme).items_start().py_1().child(
                            Textarea::new(state).appearance(false).bordered(false).readonly(busy).aria_label(text),
                        ),
                    )
                }))
                .children(page.problem.clone().map(|problem| div().body().text_color(theme.warning).child(problem)))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(
                            crate::ui::pill_button(
                                "taught-delete",
                                if confirm { "Confirm delete" } else { "Delete" },
                                crate::ui::Tone::Danger,
                                !busy,
                                theme,
                            )
                            .when(!busy, |button| {
                                button.on_click(cx.listener(|this, _, window, cx| this.remove_taught_skill(window, cx)))
                            }),
                        )
                        .child(div().flex_1())
                        .child(
                            crate::ui::pill_button("taught-try", "Try it", crate::ui::Tone::Quiet, !blocked, theme)
                                .tooltip({
                                    let tip = format!("{} runs it once in its chat", bot.name);
                                    move |window, cx| Tooltip::new(tip.clone()).build(window, cx)
                                })
                                .when(!blocked, |button| {
                                    button.on_click(cx.listener(|this, _, window, cx| {
                                        this.save_taught_skill(true, false, window, cx)
                                    }))
                                }),
                        )
                        .child(
                            crate::ui::pill_button("taught-cancel", "Cancel", crate::ui::Tone::Quiet, !busy, theme)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if let Some(page) = this.skills_page() {
                                        page.back();
                                    }
                                    cx.notify();
                                })),
                        )
                        .child(
                            crate::ui::pill_button(
                                "taught-save",
                                if busy { "Saving…" } else { "Save" },
                                crate::ui::Tone::Primary,
                                !blocked,
                                theme,
                            )
                            .when(!blocked, |button| {
                                button.on_click(
                                    cx.listener(|this, _, window, cx| this.save_taught_skill(false, false, window, cx)),
                                )
                            }),
                        ),
                ),
        )
    }

    fn render_shared_editor(
        &self,
        page: &SkillsPage,
        editor: &SharedEditor,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let busy = page.busy;
        let read_only = editor.skill.as_ref().is_some_and(|skill| skill.read_only);
        let unchanged = editor
            .skill
            .as_ref()
            .is_some_and(|skill| editor.editor.read(cx).value().as_ref() == skill.content.as_str());
        let can_save = !busy && !read_only && editor.conflict.is_none() && !unchanged;
        let title = editor.skill.as_ref().map_or_else(|| "New skill".to_owned(), |skill| skill.name.clone());
        let conflict = editor.conflict.as_ref().map(|_| {
            conflict_notice(
                "This skill changed while you were editing.",
                "Reload to see the new version, or overwrite it with yours.",
                theme,
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        crate::ui::pill_button("shared-reload", "Reload", crate::ui::Tone::Quiet, !busy, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.reload_shared_skill(window, cx))),
                    )
                    .child(
                        crate::ui::pill_button("shared-overwrite", "Overwrite", crate::ui::Tone::Danger, !busy, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.save_shared_skill(true, window, cx))),
                    ),
            )
        });
        let delete = editor.skill.as_ref().filter(|skill| !skill.read_only).map(|_| {
            let confirm = editor.confirm_delete;
            crate::ui::pill_button(
                "shared-delete",
                if confirm { "Confirm delete" } else { "Delete" },
                crate::ui::Tone::Danger,
                !busy,
                theme,
            )
            .when(!busy, |button| {
                button.on_click(cx.listener(|this, _, window, cx| this.remove_shared_skill(window, cx)))
            })
        });
        page_card(theme).child(
            div()
                .flex()
                .flex_col()
                .gap(px(9.))
                .px(px(14.))
                .py(px(11.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(icon("zap", px(16.), theme.ink_secondary))
                        .child(div().flex_1().min_w_0().name().text_color(theme.ink).truncate().child(title))
                        .when(read_only, |row| {
                            row.child(div().meta().text_color(theme.ink_tertiary).child("Built-in"))
                        }),
                )
                .children(conflict)
                .child(
                    crate::ui::field_box(theme).items_start().py_1().font_family(theme.mono.clone()).child(
                        Textarea::new(&editor.editor)
                            .appearance(false)
                            .bordered(false)
                            .readonly(busy || read_only)
                            .aria_label("SKILL.md"),
                    ),
                )
                .children(page.problem.clone().map(|problem| div().body().text_color(theme.warning).child(problem)))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .children(delete)
                        .child(div().flex_1())
                        .child(
                            crate::ui::pill_button(
                                "shared-cancel",
                                if read_only { "Close" } else { "Cancel" },
                                crate::ui::Tone::Quiet,
                                !busy,
                                theme,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(page) = this.skills_page() {
                                    page.back();
                                }
                                cx.notify();
                            })),
                        )
                        .when(!read_only, |row| {
                            row.child(
                                crate::ui::pill_button(
                                    "shared-save",
                                    if busy { "Saving…" } else { "Save" },
                                    crate::ui::Tone::Primary,
                                    can_save,
                                    theme,
                                )
                                .when(can_save, |button| {
                                    button.on_click(
                                        cx.listener(|this, _, window, cx| this.save_shared_skill(false, window, cx)),
                                    )
                                }),
                            )
                        }),
                ),
        )
    }
}
