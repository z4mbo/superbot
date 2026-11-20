use std::collections::{HashMap, HashSet};

use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use superbot_features::{
    model_options, Bot, BotSettings, ComputerMode, ComputerState, ComputerStatus, Error, Features, MainModel,
    ModelCatalogEntry, ModelConnection, ModelOption, ThinkingLevel,
};
use superbot_workspace_panel::Section;

use crate::api::{self, Target};
use crate::app::Desktop;
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::{bot_avatar, bot_ink, error_line, icon, Type};

mod computer;
mod conversations;
mod library;
mod look;
mod parts;
mod screen;
mod settings;
mod view;

use parts::*;
pub(crate) use parts::round_button;

const PANEL_MAX: Pixels = px(569.);
const PANEL_MIN: Pixels = px(320.);

/// What the desktop knows about agents beyond the sidebar summary: each agent's settings and
/// the space's models, read again after `stale` (a change signal or the window coming back).
#[derive(Default)]
pub struct AgentInfo {
    generation: u64,
    bots: HashMap<String, Bot>,
    bots_read: HashMap<String, u64>,
    reading: HashSet<String>,
    models: Option<Models>,
    models_read: Option<u64>,
    models_reading: bool,
}

struct Models {
    options: Vec<ModelOption>,
    catalog: Vec<ModelCatalogEntry>,
    connections: Vec<ModelConnection>,
    main: MainModel,
}

impl Models {
    fn name(&self, provider: &str, model_id: &str) -> String {
        self.options
            .iter()
            .find(|option| option.is(provider, model_id))
            .map(|option| option.label.clone())
            .or_else(|| {
                self.catalog
                    .iter()
                    .find(|entry| entry.provider == provider && entry.id == model_id)
                    .map(|entry| entry.label.clone())
            })
            .unwrap_or_else(|| model_id.to_owned())
    }
}

impl AgentInfo {
    pub fn stale(&mut self) {
        self.generation += 1;
    }

    pub fn bot(&self, id: &str) -> Option<&Bot> {
        self.bots.get(id)
    }

    /// The models the space can run, `None` until read.
    pub(crate) fn model_options(&self) -> Option<&[ModelOption]> {
        Some(&self.models.as_ref()?.options)
    }

    /// The levels `provider`/`model_id` can think at: its connection's when it runs on one, else
    /// the catalog's. Empty when the model takes no setting or the models are not read yet.
    pub(crate) fn thinking_levels(&self, provider: &str, model_id: &str, credential: Option<&str>) -> Vec<ThinkingLevel> {
        let Some(models) = self.models.as_ref() else { return Vec::new() };
        credential
            .and_then(|id| models.connections.iter().find(|connection| connection.id == id))
            .map(|connection| connection.thinking_levels.clone())
            .filter(|levels| !levels.is_empty())
            .or_else(|| {
                models
                    .catalog
                    .iter()
                    .find(|entry| entry.provider == provider && entry.id == model_id)
                    .map(|entry| entry.thinking_levels.clone())
            })
            .unwrap_or_default()
    }

    /// The model agents without their own run on, as provider, model and connection.
    pub(crate) fn main_choice(&self) -> Option<(String, String, Option<String>)> {
        let choice = self.models.as_ref()?.main.running()?;
        Some((choice.provider.clone(), choice.model_id.clone(), choice.credential_id.clone()))
    }

    /// What agents without their own model run on, `None` until read.
    pub(crate) fn main_model_label(&self) -> Option<String> {
        let models = self.models.as_ref()?;
        Some(match models.main.running() {
            Some(choice) => models.name(&choice.provider, &choice.model_id),
            None => "Not chosen".into(),
        })
    }

    /// The model this agent answers with: its own, else the space's. `None` until both are read.
    pub fn model_label(&self, id: &str) -> Option<String> {
        let (bot, models) = (self.bots.get(id)?, self.models.as_ref()?);
        Some(match bot.model_provider.as_deref().zip(bot.model_id.as_deref()) {
            Some((provider, model_id)) => models.name(provider, model_id),
            None => match models.main.running() {
                Some(choice) => models.name(&choice.provider, &choice.model_id),
                None => "Choose a model".into(),
            },
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PanelTab {
    Details,
    Library,
    Computer,
    Inbox,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Name,
    Description,
    Instructions,
}

enum Editor {
    Line(Entity<InputState>),
    Text(Entity<TextareaState>),
}

enum ComputerView {
    Loading,
    Ready(ComputerStatus),
    /// The server keeps no computer for this agent.
    Missing,
    Failed(String),
}

/// The agent's side panel: who it is, its model and its computer, and its settings page.
pub struct AgentPanel {
    agent_id: String,
    tab: PanelTab,
    settings: bool,
    computer: Option<ComputerView>,
    computer_busy: bool,
    editing: Option<(Field, Editor)>,
    saving: bool,
    problem: Option<String>,
    screen: Option<screen::ScreenSession>,
    library: Option<(Target, library::LibraryView)>,
    _editor_events: Option<Subscription>,
    look: look::LookEditor,
}

impl AgentPanel {
    fn new(agent_id: String, tab: PanelTab) -> Self {
        Self {
            agent_id,
            tab,
            settings: false,
            computer: None,
            computer_busy: false,
            editing: None,
            saving: false,
            problem: None,
            screen: None,
            library: None,
            _editor_events: None,
            look: look::LookEditor::default(),
        }
    }
}

enum Change {
    Name(String),
    Description(String),
    Instructions { text: String, expected: String },
    Notify(bool),
    DisabledTools(Vec<String>),
}

/// The built-in tools that let an agent see and use its computer.
const COMPUTER_TOOLS: [&str; 2] = ["computer_observe", "computer_act"];

fn uses_computer(bot: &Bot) -> bool {
    !bot.disabled_builtin_tools.iter().any(|tool| COMPUTER_TOOLS.contains(&tool.as_str()))
}

fn computer_tools_set(bot: &Bot, on: bool) -> Vec<String> {
    let mut tools: Vec<String> =
        bot.disabled_builtin_tools.iter().filter(|tool| !COMPUTER_TOOLS.contains(&tool.as_str())).cloned().collect();
    if !on {
        tools.extend(COMPUTER_TOOLS.iter().map(|tool| (*tool).to_owned()));
    }
    tools
}

fn chat_agent(desktop: &Desktop) -> Option<String> {
    match &desktop.chat.as_ref()?.target {
        Target::Agent(id) | Target::Conversation { agent: id, .. } => Some(id.clone()),
        Target::Group(_) => None,
    }
}

impl Desktop {
    pub(crate) fn chat_model_label(&self, id: &str) -> Option<String> {
        self.selected_local_model().map(|model| model.label).or_else(|| self.agent_info.model_label(id))
    }

    fn features(&self) -> Option<(Features, String)> {
        Some((Features::new(self.api.as_ref()?.client.clone()), self.space_id()?))
    }

    pub fn toggle_agent_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.agent_panel.take().is_none() {
            if let Some(id) = chat_agent(self) {
                self.agent_panel = Some(AgentPanel::new(id, PanelTab::Details));
                self.inbox.open = false;
                self.agent_info.stale();
                self.sync_agent_info(window, cx);
            }
        }
        cx.notify();
    }

    pub fn close_agent_panel(&mut self, cx: &mut Context<Self>) {
        self.agent_panel = None;
        cx.notify();
    }

    /// Escape inside the panel: leaves an editor, then the settings page.
    pub fn agent_panel_back(&mut self, cx: &mut Context<Self>) -> bool {
        if self.close_look_editor(cx) {
            return true;
        }
        let Some(panel) = self.agent_panel.as_mut() else { return false };
        if panel.screen.take().is_some() {
            panel.computer = None;
        } else if panel.editing.take().is_some() {
            panel._editor_events = None;
        } else if panel.settings {
            panel.settings = false;
        } else {
            return false;
        }
        cx.notify();
        true
    }

    /// Reads what the open conversation's header and panel show, and keeps the panel on the
    /// agent whose conversation is open.
    pub fn sync_agent_info(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let agent = chat_agent(self);
        if let Some(panel) = &self.agent_panel {
            match &agent {
                None => self.agent_panel = None,
                Some(id) if *id != panel.agent_id => {
                    let tab = panel.tab;
                    self.agent_panel = Some(AgentPanel::new(id.clone(), tab));
                }
                Some(_) => {}
            }
        }
        let Some(id) = agent else { return };
        let generation = self.agent_info.generation;
        if self.agent_info.bots_read.get(&id) != Some(&generation) && !self.agent_info.reading.contains(&id) {
            self.read_agent(id.clone(), window, cx);
        }
        if self.agent_info.models_read != Some(generation) && !self.agent_info.models_reading {
            self.read_models(window, cx);
        }
        if self.agent_panel.is_some() {
            self.read_conversations(&id, generation, window, cx);
        }
        let shown = self.chat.as_ref().map(|chat| chat.target.clone());
        let wants_library = self.agent_panel.as_ref().is_some_and(|panel| {
            panel.tab == PanelTab::Library && panel.library.as_ref().map(|(at, _)| at) != shown.as_ref()
        });
        if wants_library {
            self.read_library(window, cx);
        }
        let wants_computer =
            self.agent_panel.as_ref().is_some_and(|panel| panel.tab == PanelTab::Computer && panel.computer.is_none());
        if wants_computer {
            self.read_computer(window, cx);
        }
    }

    fn read_agent(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let generation = self.agent_info.generation;
        self.agent_info.reading.insert(id.clone());
        let read = id.clone();
        self.call(window, cx, async move { features.space(space).bot(&read).await }, move |this, result, _, _| {
            this.agent_info.reading.remove(&id);
            this.agent_info.bots_read.insert(id.clone(), generation);
            if let Ok(bot) = result {
                this.agent_info.bots.insert(id, bot);
            }
        });
    }

    fn read_models(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let generation = self.agent_info.generation;
        self.agent_info.models_reading = true;
        let work = async move {
            let space = features.space(space);
            futures_util::try_join!(space.model_catalog(), space.model_connections(), space.main_model())
        };
        self.call(window, cx, work, move |this, result, _, _| {
            this.agent_info.models_reading = false;
            this.agent_info.models_read = Some(generation);
            if let Ok((catalog, connections, main)) = result {
                let options = model_options(&connections, &catalog);
                this.agent_info.models = Some(Models { options, catalog, connections, main });
            }
        });
    }

    fn read_computer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some((features, space)), Some(panel)) = (self.features(), self.agent_panel.as_mut()) else { return };
        panel.computer = Some(ComputerView::Loading);
        let id = panel.agent_id.clone();
        let read = id.clone();
        self.call(
            window,
            cx,
            async move { features.space(space).computer_status(&read).await },
            move |this, result, _, _| this.show_computer(&id, result),
        );
    }

    fn show_computer(&mut self, agent_id: &str, result: Result<ComputerStatus, Error>) {
        let Some(panel) = self.agent_panel.as_mut().filter(|panel| panel.agent_id == agent_id) else { return };
        panel.computer_busy = false;
        panel.computer = Some(match result {
            Ok(status) => ComputerView::Ready(status),
            Err(Error::Server { status: 404, code, .. }) if code.as_deref() == Some("NOT_FOUND") => {
                ComputerView::Missing
            }
            Err(error) => ComputerView::Failed(api::explain(&error)),
        });
    }

    fn switch_computer(&mut self, start: bool, window: &mut Window, cx: &mut Context<Self>) {
        let (Some((features, space)), Some(panel)) = (self.features(), self.agent_panel.as_mut()) else { return };
        if panel.computer_busy {
            return;
        }
        panel.computer_busy = true;
        let id = panel.agent_id.clone();
        let target = id.clone();
        let work = async move {
            let space = features.space(space);
            if start {
                space.start_computer(&target).await
            } else {
                space.stop_computer(&target).await
            }
        };
        self.call(window, cx, work, move |this, result, _, _| this.show_computer(&id, result));
        cx.notify();
    }

    fn set_computer_mode(&mut self, mode: ComputerMode, window: &mut Window, cx: &mut Context<Self>) {
        let (Some((features, space)), Some(panel)) = (self.features(), self.agent_panel.as_mut()) else { return };
        if panel.saving {
            return;
        }
        panel.saving = true;
        panel.problem = None;
        let id = panel.agent_id.clone();
        let target = id.clone();
        self.call(
            window,
            cx,
            async move { features.space(space).set_bot_computer(&target, mode).await },
            move |this, result, window, cx| {
                this.saved(&id, result, window, cx);
                if let Some(panel) = this.agent_panel.as_mut().filter(|panel| panel.agent_id == id) {
                    panel.computer = None;
                }
                this.sync_agent_info(window, cx);
            },
        );
        cx.notify();
    }

    fn change_agent(&mut self, change: Change, window: &mut Window, cx: &mut Context<Self>) {
        let (Some((features, space)), Some(panel)) = (self.features(), self.agent_panel.as_mut()) else { return };
        if panel.saving {
            return;
        }
        panel.saving = true;
        panel.problem = None;
        let id = panel.agent_id.clone();
        let target = id.clone();
        let work = async move {
            let tools: Vec<&str> = match &change {
                Change::DisabledTools(tools) => tools.iter().map(String::as_str).collect(),
                _ => Vec::new(),
            };
            let mut settings = BotSettings::default();
            match &change {
                Change::Name(name) => settings.name = Some(name),
                Change::Description(description) => settings.description = Some(description),
                Change::Instructions { text, expected } => {
                    settings.instructions = Some(text);
                    settings.expected_instructions = Some(expected);
                }
                Change::Notify(on) => settings.notify_on_finish = Some(*on),
                Change::DisabledTools(_) => settings.disabled_builtin_tools = Some(&tools),
            }
            features.space(space).update_bot(&target, &settings).await
        };
        self.call(window, cx, work, move |this, result, window, cx| this.saved(&id, result, window, cx));
        cx.notify();
    }

    fn saved(&mut self, agent_id: &str, result: Result<Bot, Error>, _: &mut Window, cx: &mut Context<Self>) {
        let failure = match result {
            Ok(bot) => {
                self.agent_info.bots.insert(agent_id.to_owned(), bot);
                self.reload_space(cx);
                None
            }
            Err(error) => Some(api::explain(&error)),
        };
        if let Some(panel) = self.agent_panel.as_mut().filter(|panel| panel.agent_id == agent_id) {
            panel.saving = false;
            if failure.is_none() {
                panel.editing = None;
                panel._editor_events = None;
            }
            panel.problem = failure;
        }
    }

    fn edit(&mut self, field: Field, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bot) = self.agent_panel.as_ref().and_then(|panel| self.agent_info.bot(&panel.agent_id)) else {
            return;
        };
        let (editor, events) = match field {
            Field::Instructions => {
                let text = bot.instructions.clone();
                let state = cx.new(|cx| {
                    TextareaState::new(window, cx)
                        .auto_grow(4, 14)
                        .placeholder(format!("Tell {} how to work for you", bot.name))
                        .default_value(text)
                });
                state.update(cx, |state, cx| {
                    let end = state.value().len();
                    state.set_selected_range(end..end, cx);
                    state.focus(window, cx);
                });
                (Editor::Text(state), None)
            }
            Field::Name | Field::Description => {
                let (value, placeholder) = match field {
                    Field::Name => (bot.name.clone(), "Name"),
                    _ => (bot.description.clone(), "What it does"),
                };
                let state = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).default_value(value));
                state.update(cx, |state, cx| {
                    let end = state.value().len();
                    state.set_selected_range(end..end, cx);
                    state.focus(window, cx);
                });
                let events = cx.subscribe_in(&state, window, |this, _, event: &InputEvent, window, cx| {
                    if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                        this.commit_edit(window, cx);
                    }
                });
                (Editor::Line(state), Some(events))
            }
        };
        if let Some(panel) = self.agent_panel.as_mut() {
            panel.problem = None;
            panel.editing = Some((field, editor));
            panel._editor_events = events;
        }
        cx.notify();
    }

    fn commit_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.agent_panel.as_ref() else { return };
        let Some(bot) = self.agent_info.bot(&panel.agent_id) else { return };
        let Some((field, editor)) = panel.editing.as_ref() else { return };
        let value = match editor {
            Editor::Line(state) => state.read(cx).value().trim().to_owned(),
            Editor::Text(state) => state.read(cx).value().trim().to_owned(),
        };
        let change = match field {
            Field::Name if !value.is_empty() && value != bot.name => Some(Change::Name(value)),
            Field::Description if value != bot.description.trim() => Some(Change::Description(value)),
            Field::Instructions if value != bot.instructions.trim() => {
                Some(Change::Instructions { text: value, expected: bot.instructions.clone() })
            }
            _ => None,
        };
        match change {
            Some(change) => self.change_agent(change, window, cx),
            None => {
                self.agent_panel_back(cx);
            }
        }
    }

    pub(crate) fn choose_agent_model(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = chat_agent(self) {
            self.show_agent_model(&id, window, cx);
        }
    }
}
