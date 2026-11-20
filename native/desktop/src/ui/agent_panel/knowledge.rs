use superbot_features::{memory_notes, AgentSkillEntry, AgentSkillSource, MemoryBudget, MemoryDocument, TaughtSkill};

use super::*;

pub(super) enum Load<T> {
    Loading,
    Ready(T),
    Failed(String),
}

impl<T> Load<T> {
    pub(super) fn ready(&self) -> Option<&T> {
        match self {
            Self::Ready(value) => Some(value),
            _ => None,
        }
    }
}

/// The agent's memory and skills. Read when its Library or one of their pages shows, and again
/// after a change signal; a failed re-read keeps what was already shown.
#[derive(Default)]
pub(super) struct Knowledge {
    read_at: Option<u64>,
    pub(super) memory: Option<Load<Vec<MemoryDocument>>>,
    pub(super) budget: Option<MemoryBudget>,
    pub(super) taught: Option<Load<Vec<TaughtSkill>>>,
    pub(super) shared: Option<Load<Vec<AgentSkillEntry>>>,
}

impl Knowledge {
    pub(super) fn stale(&mut self) {
        self.read_at = None;
    }

    /// The skills a person can open here: plugin skills are listed with their plugin instead.
    pub(super) fn shared_skills(&self) -> Option<Vec<&AgentSkillEntry>> {
        let entries = self.shared.as_ref()?.ready()?;
        Some(entries.iter().filter(|entry| entry.source != AgentSkillSource::Plugin).collect())
    }
}

fn settle<T>(slot: &mut Option<Load<T>>, result: Result<T, Error>) {
    match result {
        Ok(value) => *slot = Some(Load::Ready(value)),
        Err(_) if matches!(slot, Some(Load::Ready(_))) => {}
        Err(error) => *slot = Some(Load::Failed(api::explain(&error))),
    }
}

pub(super) enum Page {
    Memory(memory::MemoryPage),
    Skills(skills::SkillsPage),
    /// The agent's files on its computer, in the Computer tab's browser.
    Folder,
}

impl Page {
    fn title(&self) -> &'static str {
        match self {
            Self::Memory(_) => "What it remembers",
            Self::Skills(_) => "Skills",
            Self::Folder => "Working folder",
        }
    }
}

impl Desktop {
    pub(super) fn wants_knowledge(&self) -> bool {
        self.agent_panel.as_ref().is_some_and(|panel| {
            (panel.tab == PanelTab::Library || panel.page.is_some())
                && panel.knowledge.read_at != Some(self.agent_info.generation)
        })
    }

    pub(super) fn read_knowledge(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let generation = self.agent_info.generation;
        let (Some((features, space)), Some(panel)) = (self.features(), self.agent_panel.as_mut()) else { return };
        let knowledge = &mut panel.knowledge;
        knowledge.read_at = Some(generation);
        knowledge.memory.get_or_insert(Load::Loading);
        knowledge.taught.get_or_insert(Load::Loading);
        knowledge.shared.get_or_insert(Load::Loading);
        let id = panel.agent_id.clone();

        let (read, bot) = (features.clone(), id.clone());
        let space_id = space.clone();
        self.call(window, cx, async move { read.space(space_id).bot_memory(&bot).await }, {
            let id = id.clone();
            move |this, result, _, _| {
                if let Some(panel) = this.agent_panel.as_mut().filter(|panel| panel.agent_id == id) {
                    settle(&mut panel.knowledge.memory, result);
                }
            }
        });
        let (read, bot) = (features.clone(), id.clone());
        let space_id = space.clone();
        self.call(window, cx, async move { read.space(space_id).memory_budget(&bot).await }, {
            let id = id.clone();
            move |this, result, _, _| {
                if let (Some(panel), Ok(budget)) =
                    (this.agent_panel.as_mut().filter(|panel| panel.agent_id == id), result)
                {
                    panel.knowledge.budget = Some(budget);
                }
            }
        });
        let (read, bot) = (features.clone(), id.clone());
        let space_id = space.clone();
        self.call(window, cx, async move { read.space(space_id).taught_skills(&bot).await }, {
            let id = id.clone();
            move |this, result, _, _| {
                if let Some(panel) = this.agent_panel.as_mut().filter(|panel| panel.agent_id == id) {
                    settle(&mut panel.knowledge.taught, result);
                }
            }
        });
        self.call(window, cx, async move { features.space(space).agent_skills().await }, move |this, result, _, _| {
            if let Some(panel) = this.agent_panel.as_mut().filter(|panel| panel.agent_id == id) {
                settle(&mut panel.knowledge.shared, result);
            }
        });
    }

    pub(super) fn open_library_page(&mut self, page: Page, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = self.agent_panel.as_mut() {
            panel.page = Some(page);
            panel.editing = None;
            panel.problem = None;
        }
        self.sync_agent_info(window, cx);
        cx.notify();
    }

    pub(super) fn agent_name(&self) -> String {
        self.agent_panel
            .as_ref()
            .and_then(|panel| self.agent_info.bot(&panel.agent_id))
            .map(|bot| bot.name.clone())
            .unwrap_or_default()
    }

    /// Escape on a Library page: closes what is open on it, then the page.
    pub(super) fn library_page_back(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(panel) = self.agent_panel.as_mut() else { return false };
        let Some(page) = panel.page.as_mut() else { return false };
        let closed_inside = match page {
            Page::Memory(page) => page.back(),
            Page::Skills(page) => page.back(),
            Page::Folder => panel.files.as_mut().is_some_and(|files| files.back()),
        };
        if !closed_inside {
            panel.page = None;
        }
        cx.notify();
        true
    }

    pub(super) fn close_library_page(&mut self, cx: &mut Context<Self>) {
        if let Some(panel) = self.agent_panel.as_mut() {
            panel.page = None;
        }
        cx.notify();
    }

    /// The memory, skills and working folder shortcuts under the conversation's items. The folder
    /// shows only once the computer's status says it has files to browse.
    pub(super) fn render_library_shortcuts(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let Some(panel) = self.agent_panel.as_ref() else { return div() };
        let folder = self.agent_info.bot(&panel.agent_id).filter(|bot| match &panel.computer {
            Some(ComputerView::Ready(status)) => files::browsable(status, uses_computer(bot)),
            _ => false,
        });
        let folder_value = folder.map(|bot| match bot.computer_mode {
            ComputerMode::Team => "Team computer".to_owned(),
            ComputerMode::Dedicated => "Its own computer".to_owned(),
        });
        let knowledge = &panel.knowledge;
        let memory_value = match &knowledge.memory {
            Some(Load::Ready(docs)) => Some(match memory_notes(docs).len() {
                0 => "Nothing yet".to_owned(),
                1 => "1 note".to_owned(),
                count => format!("{count} notes"),
            }),
            Some(Load::Failed(_)) => Some("Nothing yet".to_owned()),
            _ => None,
        };
        let skills_value = match (knowledge.taught.as_ref().and_then(Load::ready), knowledge.shared_skills()) {
            (Some(taught), Some(shared)) => {
                let count = taught.len() + shared.iter().filter(|entry| entry.source == AgentSkillSource::User).count();
                Some(if count == 0 { "None".to_owned() } else { count.to_string() })
            }
            _ => None,
        };
        div().mt_2().child(
            card(theme)
                .child(nav_row("library-memory", "brain", "What it remembers", memory_value, theme).on_click(
                    cx.listener(|this, _, window, cx| {
                        let page = memory::MemoryPage::new(&this.agent_name(), window, cx);
                        this.open_library_page(Page::Memory(page), window, cx);
                    }),
                ))
                .child(
                    nav_row("library-skills", "zap", "Skills", skills_value, theme)
                        .border_t_1()
                        .border_color(theme.ink_at(0.05))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_library_page(Page::Skills(skills::SkillsPage::default()), window, cx);
                        })),
                )
                .children(folder_value.map(|value| {
                    nav_row("library-folder", "folder", "Working folder", Some(value), theme)
                        .border_t_1()
                        .border_color(theme.ink_at(0.05))
                        .on_click(cx.listener(|this, _, window, cx| this.open_library_page(Page::Folder, window, cx)))
                })),
        )
    }

    pub(super) fn render_library_page(&self, bot: &Bot, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(page) = self.agent_panel.as_ref().and_then(|panel| panel.page.as_ref()) else {
            return div().into_any_element();
        };
        let ink = theme.ink;
        let hover = theme.ink_at(0.04);
        let back = div()
            .id("library-page-back")
            .mt(px(2.))
            .flex()
            .items_center()
            .gap(px(2.))
            .self_start()
            .py_1()
            .pl(px(2.))
            .pr_2()
            .rounded(px(8.))
            .body()
            .text_color(theme.ink_secondary)
            .cursor_pointer()
            .hover(move |style| style.bg(hover).text_color(ink))
            .on_click(cx.listener(|this, _, _, cx| this.close_library_page(cx)))
            .child(icon("chevron-left", px(15.), theme.ink_secondary))
            .child("Library");
        let body = match page {
            Page::Memory(state) => self.render_memory_page(bot, state, theme, cx),
            Page::Skills(state) => self.render_skills_page(bot, state, theme, cx),
            Page::Folder => div().child(self.render_computer_files(bot, theme, cx).unwrap_or_else(|| {
                page_card(theme)
                    .child(note_row(format!("{} has no files to browse here.", bot.name), false, theme))
                    .into_any_element()
            })),
        };
        div()
            .pt_2()
            .flex()
            .flex_col()
            .child(back)
            .child(
                div()
                    .mx_1()
                    .mt(px(6.))
                    .text_size(px(18.))
                    .line_height(px(24.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.ink)
                    .child(page.title()),
            )
            .child(body)
            .into_any_element()
    }
}

pub(super) fn nav_row(
    id: &'static str,
    glyph: &'static str,
    title: &'static str,
    value: Option<String>,
    theme: &Theme,
) -> Stateful<Div> {
    let hover = theme.ink_at(0.03);
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(10.))
        .min_h(px(46.))
        .px(px(14.))
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .child(icon(glyph, px(16.), theme.ink_secondary))
        .child(div().flex_1().name().text_color(theme.ink).child(title))
        .children(value.map(|value| div().body().text_color(theme.ink_secondary).child(value)))
        .child(icon("chevron-right", px(15.), theme.ink_tertiary))
}

/// A row of a card after the first: rows are divided by a hairline.
pub(super) fn divided<E: Styled>(row: E, index: usize, theme: &Theme) -> E {
    if index > 0 {
        row.border_t_1().border_color(theme.ink_at(0.05))
    } else {
        row
    }
}

pub(super) fn note_row(text: impl Into<SharedString>, warn: bool, theme: &Theme) -> Div {
    div()
        .px(px(14.))
        .py(px(11.))
        .body()
        .text_color(if warn { theme.warning } else { theme.ink_secondary })
        .child(text.into())
}

pub(super) fn link_row(
    id: impl Into<ElementId>,
    label: &'static str,
    glyph: &'static str,
    theme: &Theme,
) -> Stateful<Div> {
    let ink = theme.ink;
    div()
        .id(id)
        .flex()
        .items_center()
        .gap_2()
        .px(px(14.))
        .py(px(11.))
        .body()
        .text_color(theme.ink_secondary)
        .cursor_pointer()
        .hover(move |style| style.text_color(ink))
        .child(div().flex_1().min_w_0().child(label))
        .child(icon(glyph, px(14.), theme.ink_secondary))
}

pub(super) fn trash_button(id: impl Into<ElementId>, enabled: bool, theme: &Theme) -> Stateful<Div> {
    let hover = theme.ink_at(0.05);
    div()
        .id(id)
        .size_7()
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(8.))
        .when(enabled, |button| button.cursor_pointer().hover(move |style| style.bg(hover)))
        .when(!enabled, |button| button.opacity(0.5))
        .child(icon("trash", px(14.), theme.ink_tertiary))
}

pub(super) fn page_card(theme: &Theme) -> Div {
    card(theme).mt(px(14.))
}

pub(super) fn is_conflict(error: &Error) -> bool {
    matches!(error, Error::Server { status: 409, .. })
}

pub(super) fn page_label(text: impl Into<SharedString>, theme: &Theme) -> Div {
    div()
        .mx(px(14.))
        .mt_5()
        .mb_2()
        .body()
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme.ink_secondary)
        .child(text.into())
}

/// What to tell someone whose save was refused because a newer version arrived; the caller adds
/// the Reload and Overwrite buttons.
pub(super) fn conflict_notice(title: impl Into<SharedString>, help: impl Into<SharedString>, theme: &Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .gap_2()
        .px_3()
        .py(px(10.))
        .rounded(radius::CARD)
        .bg(theme.warning.opacity(0.1))
        .child(div().body().font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(title.into()))
        .child(div().body().text_color(theme.ink_secondary).child(help.into()))
}
