mod local;
mod view;

use std::cell::Cell;
use std::collections::HashSet;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::base::ElementExt as _;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::*;
use superbot_features::local_cli::{InstalledModel, Provider};
use superbot_features::{BotSettings, Features, ModelOption, ModelSelection, Patch, ThinkingLevel};
use superbot_workspace_panel::Section;

use crate::api;
use crate::app::{Desktop, Menu, MenuKind};
use local::{probe_local, Favorites, LocalGroup};

/// Past this many models the menu offers a search field, as the Simple menu does.
const SEARCH_AFTER: usize = 12;
/// Models a group suggests before "Show all": one more where the current model sits.
const GROUP_SUGGESTIONS: usize = 3;
const CURRENT_GROUP_SUGGESTIONS: usize = 4;
const LOCAL_GROUP: &str = "On this computer";
const TYPEAHEAD_RESET: Duration = Duration::from_millis(1000);

/// The model popover's own state; what it lists is read from the agent, the space's models and
/// this computer's local engines.
#[derive(Default)]
pub struct ModelMenu {
    header: Rc<Cell<Bounds<Pixels>>>,
    details: Rc<Cell<Bounds<Pixels>>>,
    trigger: ModelTrigger,
    query: Option<Entity<InputState>>,
    _query_events: Option<Subscription>,
    focus: Option<FocusHandle>,
    _focus_events: Vec<Subscription>,
    /// Focus reached the menu since it opened, so focus leaving it (Tab) closes it.
    armed: bool,
    local: Option<Vec<LocalGroup>>,
    probing: bool,
    saving: bool,
    expanded: HashSet<String>,
    problem: Option<String>,
    favorites: Option<Favorites>,
    /// Favorites as they were when the menu opened: a starred row moves up the next time it
    /// opens, never under the pointer.
    starred_at_open: HashSet<String>,
    highlight: Option<Spot>,
    /// Where the keyboard can go, in the order the last frame drew it.
    nav: Vec<Stop>,
    search_shown: bool,
    fresh: bool,
    thinking_open: bool,
    /// The thinking level just saved, shown until the agent is read again.
    effort: Option<Option<ThinkingLevel>>,
    typed: Option<(String, Instant)>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum ModelTrigger {
    #[default]
    Header,
    Details,
}

impl ModelMenu {
    fn bounds(&self, trigger: ModelTrigger) -> &Rc<Cell<Bounds<Pixels>>> {
        match trigger {
            ModelTrigger::Header => &self.header,
            ModelTrigger::Details => &self.details,
        }
    }
}

/// The keyboard's place: a row, or the favorite star beside it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Spot {
    pub row: usize,
    pub star: bool,
}

#[derive(Clone)]
pub(super) enum Pick {
    Main,
    Hosted(ModelOption),
    Local(InstalledModel),
}

#[derive(Clone)]
pub(super) enum Act {
    Close,
    Pick(Pick),
    Toggle(String),
    Thinking,
    Effort(Option<ThinkingLevel>),
    Recheck,
    Manage,
}

pub(super) struct Stop {
    pub act: Act,
    pub star: Option<String>,
    pub text: String,
}

#[derive(Clone, Copy)]
pub(super) enum Gutter {
    Blank,
    Hosted,
    Local,
    Thinking,
    Manage,
    Recheck,
}

pub(super) enum Trailing {
    None,
    Check,
    Chevron(&'static str),
    Value(String, &'static str),
}

pub(super) enum Line {
    Row {
        nav: usize,
        label: String,
        meta: Option<String>,
        gutter: Gutter,
        trailing: Trailing,
        star: Option<bool>,
        quiet: bool,
    },
    Label(String, Gutter),
    Separator,
    Status(String),
    Note(String),
    Effort {
        first: usize,
        levels: Vec<Option<ThinkingLevel>>,
        current: Option<ThinkingLevel>,
    },
    Hint(String),
}

pub(super) struct Sheet {
    pub search: bool,
    pub lines: Vec<Line>,
    pub footer: Vec<Line>,
    pub nav: Vec<Stop>,
}

struct Choice {
    pick: Pick,
    label: String,
    meta: Option<String>,
    key: String,
}

fn favorite_key(pick: &Pick) -> String {
    match pick {
        Pick::Main => String::new(),
        Pick::Hosted(option) => format!("{}\n{}", option.provider, option.model_id),
        Pick::Local(model) => format!("local:{}\n{}", model.provider, model.id),
    }
}

fn matches(query: &str, texts: &[&str]) -> bool {
    query.is_empty() || texts.iter().any(|text| text.to_lowercase().contains(query))
}

pub(super) fn level_label(level: Option<ThinkingLevel>) -> &'static str {
    match level {
        None => "Auto",
        Some(ThinkingLevel::Off) => "Off",
        Some(ThinkingLevel::Minimal) => "Minimal",
        Some(ThinkingLevel::Low) => "Low",
        Some(ThinkingLevel::Medium) => "Medium",
        Some(ThinkingLevel::High) => "High",
        Some(ThinkingLevel::Xhigh) => "Extra high",
        Some(ThinkingLevel::Max) => "Max",
    }
}

fn level_hint(level: Option<ThinkingLevel>) -> &'static str {
    match level {
        None => "Recommended. Effort is picked per message.",
        Some(ThinkingLevel::Off) => "No extra thinking. The fastest replies.",
        Some(ThinkingLevel::Minimal | ThinkingLevel::Low) => "A little thinking. Quick replies for simple asks.",
        Some(ThinkingLevel::Medium) => "Some thinking. A good balance for most work.",
        Some(ThinkingLevel::High) => "Careful thinking for harder problems. Slower.",
        Some(ThinkingLevel::Xhigh) => "Very careful, for tricky multi-step work. Slower still.",
        Some(ThinkingLevel::Max) => "Thinks as long as it needs. Slowest, for the hardest jobs.",
    }
}

/// Moves through `count` stops the way the Simple menu does: arrows wrap, Home and End jump.
fn next_index(key: &str, current: Option<usize>, count: usize) -> Option<usize> {
    if count == 0 {
        return None;
    }
    match key {
        "down" => Some(current.map_or(0, |at| (at + 1) % count)),
        "up" => Some(current.map_or(count - 1, |at| (at + count - 1) % count)),
        "home" => Some(0),
        "end" => Some(count - 1),
        _ => None,
    }
}

impl Desktop {
    pub(crate) fn model_menu_button(&self, trigger: ModelTrigger, cx: &mut Context<Self>) -> Stateful<Div> {
        let bounds = self.model_menu.bounds(trigger).clone();
        let open = self.model_menu.trigger == trigger
            && matches!(self.menu.as_ref().map(|menu| &menu.kind), Some(MenuKind::Model(_)));
        let id = match trigger {
            ModelTrigger::Header => "chat-head-model",
            ModelTrigger::Details => "agent-model",
        };
        div()
            .id(id)
            .relative()
            .on_prepaint(move |area, window, _| {
                if bounds.replace(area) != area && open {
                    window.refresh();
                }
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                if let Some(bot) = this.chat.as_ref().and_then(|chat| chat.target.agent()).map(str::to_owned) {
                    this.open_model_menu(&bot, trigger, window, cx);
                }
            }))
    }

    fn open_model_menu(&mut self, bot_id: &str, trigger: ModelTrigger, window: &mut Window, cx: &mut Context<Self>) {
        let kind = MenuKind::Model(bot_id.to_owned());
        if self.menu.as_ref().is_some_and(|menu| menu.kind == kind) {
            self.close_model_menu(cx);
            return;
        }
        self.model_menu.trigger = trigger;
        let at = self.model_menu.bounds(trigger).get().bottom_left();
        self.menu = Some(Menu { kind, at });
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search models"));
        let events = cx.subscribe_in(&query, window, |this, _, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { .. } => this.model_menu_enter(window, cx),
            InputEvent::Change => {
                this.model_menu.highlight = None;
                cx.notify();
            }
            _ => {}
        });
        let focus = self.model_menu_focus(window, cx);
        window.focus(&focus, cx);
        cx.on_next_frame(window, |this, window, cx| {
            if let Some(focus) = this.model_menu.focus.clone() {
                window.focus(&focus, cx);
            }
        });
        let favorites = match (&self.api, &self.me) {
            (Some(api), Some(me)) => Favorites::load(api.client.server(), &me.user_id),
            _ => Favorites::load("", ""),
        };
        let menu = &mut self.model_menu;
        menu.starred_at_open = favorites.starred.clone();
        menu.favorites = Some(favorites);
        menu.query = Some(query);
        menu._query_events = Some(events);
        menu.armed = false;
        menu.problem = None;
        menu.expanded.clear();
        menu.highlight = None;
        menu.fresh = true;
        menu.thinking_open = false;
        menu.effort = None;
        menu.typed = None;
        self.sync_agent_info(window, cx);
        if self.model_menu.local.is_none() {
            self.probe_local_models(window, cx);
        }
        cx.notify();
    }

    /// One focus handle for every opening, as the New menu keeps: a handle made fresh each time
    /// can lose focus before the sheet that tracks it is drawn.
    fn model_menu_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) -> FocusHandle {
        if let Some(focus) = &self.model_menu.focus {
            return focus.clone();
        }
        let focus = cx.focus_handle();
        let focus_in = cx.on_focus_in(&focus, window, |this, _, _| this.model_menu.armed = true);
        let focus_out = cx.on_focus_out(&focus, window, |this, _, _, cx| {
            let open = matches!(this.menu.as_ref().map(|menu| &menu.kind), Some(MenuKind::Model(_)));
            if open && this.model_menu.armed {
                this.close_model_menu(cx);
            }
        });
        self.model_menu.focus = Some(focus.clone());
        self.model_menu._focus_events = vec![focus_in, focus_out];
        focus
    }

    fn probe_local_models(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cli) = self.local_cli() else {
            self.model_menu.local = Some(Vec::new());
            return;
        };
        if self.model_menu.probing {
            return;
        }
        self.model_menu.probing = true;
        self.call(window, cx, async move { Ok(probe_local(cli).await) }, |this, groups, _, _| {
            this.model_menu.probing = false;
            this.model_menu.local = Some(groups.unwrap_or_default());
        });
        cx.notify();
    }

    pub(crate) fn close_model_menu(&mut self, cx: &mut Context<Self>) {
        self.menu = None;
        let menu = &mut self.model_menu;
        menu.query = None;
        menu._query_events = None;
        menu.armed = false;
        menu.nav.clear();
        menu.highlight = None;
        cx.notify();
    }

    fn model_menu_bot(&self) -> Option<String> {
        match &self.menu.as_ref()?.kind {
            MenuKind::Model(bot_id) => Some(bot_id.clone()),
            _ => None,
        }
    }

    fn model_menu_query(&self, cx: &App) -> String {
        self.model_menu.query.as_ref().map(|query| query.read(cx).value().trim().to_lowercase()).unwrap_or_default()
    }

    fn local_engine_name(&self, model: &InstalledModel) -> String {
        self.model_menu
            .local
            .iter()
            .flatten()
            .find(|group| group.models.contains(model))
            .map(|group| group.engine.to_owned())
            .or_else(|| {
                Provider::ALL.iter().find(|provider| provider.id() == model.provider).map(|p| p.name().to_owned())
            })
            .unwrap_or_else(|| LOCAL_GROUP.to_owned())
    }

    /// What the popover shows for `bot_id`, as the Simple menu builds it: the current model pinned,
    /// following the main model, then each source's suggestions with favorites first.
    pub(super) fn model_sheet(&self, bot_id: &str, typed_query: &str) -> Sheet {
        let local = self.local_cli().and_then(|cli| cli.selection(bot_id).ok().flatten());
        let bot = self.agent_info.bot(bot_id);
        let name = bot.map(|bot| bot.name.clone()).unwrap_or_else(|| "This agent".into());
        let own = bot.and_then(|bot| bot.model_provider.clone().zip(bot.model_id.clone()));
        let main_label = self.agent_info.main_model_label();
        let options = self.agent_info.model_options().unwrap_or_default();
        let live = self.model_menu.favorites.as_ref().map(|favorites| &favorites.starred);
        let starred = &self.model_menu.starred_at_open;

        let mut sources: Vec<(String, bool, Vec<Choice>)> = Vec::new();
        for option in options {
            let pick = Pick::Hosted(option.clone());
            let choice = Choice { key: favorite_key(&pick), pick, label: option.label.clone(), meta: None };
            match sources.iter_mut().find(|(source, local, _)| !local && *source == option.source) {
                Some((_, _, rows)) => rows.push(choice),
                None => sources.push((option.source.clone(), false, vec![choice])),
            }
        }
        let locals: Vec<Choice> = self
            .model_menu
            .local
            .iter()
            .flatten()
            .flat_map(|group| group.models.iter().map(move |model| (group.engine, model)))
            .map(|(engine, model)| {
                let pick = Pick::Local(model.clone());
                Choice { key: favorite_key(&pick), pick, label: model.label.clone(), meta: Some(engine.to_owned()) }
            })
            .collect();
        if !locals.is_empty() {
            sources.push((LOCAL_GROUP.to_owned(), true, locals));
        }
        let total: usize = sources.iter().map(|(_, _, rows)| rows.len()).sum();
        let search = total > SEARCH_AFTER;
        let query = if search { typed_query } else { "" };

        let is_current = |pick: &Pick| match (pick, &local) {
            (Pick::Local(model), Some(chosen)) => model == chosen,
            (Pick::Hosted(option), None) => own.as_ref().is_some_and(|(provider, id)| option.is(provider, id)),
            _ => false,
        };
        if let Some(at) = sources.iter().position(|(_, _, rows)| rows.iter().any(|row| is_current(&row.pick))) {
            let group = sources.remove(at);
            sources.insert(0, group);
        }

        let mut nav: Vec<Stop> = Vec::new();
        let mut lines: Vec<Line> = Vec::new();
        let stop = |nav: &mut Vec<Stop>, act: Act, star: Option<String>, text: &str| {
            nav.push(Stop { act, star, text: text.to_owned() });
            nav.len() - 1
        };

        if query.is_empty() {
            let current = if let Some(model) = &local {
                Some((
                    model.label.clone(),
                    format!("{} on this computer", self.local_engine_name(model)),
                    Gutter::Local,
                ))
            } else if let Some((provider, model_id)) = &own {
                let label = options
                    .iter()
                    .find(|option| option.is(provider, model_id))
                    .map(|option| option.label.clone())
                    .unwrap_or_else(|| model_id.clone());
                Some((label, format!("{name}'s model, used in all its chats"), Gutter::Hosted))
            } else {
                main_label
                    .clone()
                    .map(|label| (label, "Main model, for agents without their own".to_owned(), Gutter::Hosted))
            };
            let pinned = current.is_some();
            if let Some((label, meta, gutter)) = current {
                let at = stop(&mut nav, Act::Close, None, &label);
                lines.push(Line::Row {
                    nav: at,
                    label,
                    meta: Some(meta),
                    gutter,
                    trailing: Trailing::Check,
                    star: None,
                    quiet: false,
                });
            }
            if (local.is_some() || own.is_some()) && main_label.is_some() {
                let label = "Use the main model".to_owned();
                let at = stop(&mut nav, Act::Pick(Pick::Main), None, &label);
                lines.push(Line::Row {
                    nav: at,
                    label,
                    meta: main_label.clone(),
                    gutter: Gutter::Blank,
                    trailing: Trailing::None,
                    star: None,
                    quiet: false,
                });
            }
            if pinned && !sources.is_empty() {
                lines.push(Line::Separator);
            }
        }

        let mut results = 0;
        for (source, is_local, rows) in sources {
            let holds_current = rows.iter().any(|row| is_current(&row.pick));
            let (shown, toggle): (Vec<Choice>, Option<(bool, usize)>) = if query.is_empty() {
                let total = rows.len();
                let others: Vec<Choice> = rows.into_iter().filter(|row| !is_current(&row.pick)).collect();
                let limit = if holds_current { CURRENT_GROUP_SUGGESTIONS } else { GROUP_SUGGESTIONS };
                let (mut suggested, rest): (Vec<Choice>, Vec<Choice>) =
                    others.into_iter().partition(|row| starred.contains(&row.key));
                let mut rest = rest.into_iter();
                while suggested.len() < limit {
                    match rest.next() {
                        Some(row) => suggested.push(row),
                        None => break,
                    }
                }
                let rest: Vec<Choice> = rest.collect();
                let open = self.model_menu.expanded.contains(&source) || rest.len() == 1;
                let toggle = (rest.len() > 1).then_some((self.model_menu.expanded.contains(&source), total));
                if open {
                    suggested.extend(rest);
                }
                (suggested, toggle)
            } else {
                let found: Vec<Choice> = rows
                    .into_iter()
                    .filter(|row| matches(query, &[&row.label, &source, row.meta.as_deref().unwrap_or("")]))
                    .collect();
                (found, None)
            };
            if shown.is_empty() && toggle.is_none() {
                continue;
            }
            results += shown.len();
            lines.push(Line::Label(source.clone(), if is_local { Gutter::Local } else { Gutter::Hosted }));
            for choice in shown {
                let current = is_current(&choice.pick);
                let starred_now = live.is_some_and(|live| live.contains(&choice.key));
                let at = stop(&mut nav, Act::Pick(choice.pick), Some(choice.key), &choice.label);
                lines.push(Line::Row {
                    nav: at,
                    label: choice.label,
                    meta: choice.meta,
                    gutter: Gutter::Blank,
                    trailing: if current { Trailing::Check } else { Trailing::None },
                    star: Some(starred_now),
                    quiet: false,
                });
            }
            if let Some((expanded, total)) = toggle {
                let label =
                    if expanded { "Show suggested only".to_owned() } else { format!("Show all {total} models") };
                let at = stop(&mut nav, Act::Toggle(source), None, &label);
                lines.push(Line::Row {
                    nav: at,
                    label,
                    meta: None,
                    gutter: Gutter::Blank,
                    trailing: Trailing::Chevron(if expanded { "chevron-up" } else { "chevron-down" }),
                    star: None,
                    quiet: true,
                });
            }
        }

        if self.agent_info.model_options().is_none() {
            lines.push(Line::Status("Looking for models…".into()));
        }
        if self.model_menu.probing {
            lines.push(Line::Status("Looking for local models…".into()));
        } else if query.is_empty()
            && self.local_cli().is_some()
            && self.model_menu.local.as_ref().is_some_and(Vec::is_empty)
        {
            let label = "Check this computer again".to_owned();
            let at = stop(&mut nav, Act::Recheck, None, &label);
            lines.push(Line::Row {
                nav: at,
                label,
                meta: None,
                gutter: Gutter::Recheck,
                trailing: Trailing::None,
                star: None,
                quiet: true,
            });
        }
        if !query.is_empty() && results == 0 {
            lines.push(Line::Note(format!("Nothing matches \u{201c}{typed_query}\u{201d}")));
        }

        let mut footer = Vec::new();
        let levels = if local.is_some() {
            Vec::new()
        } else if let Some((provider, model_id)) = &own {
            let credential = options
                .iter()
                .find(|option| option.is(provider, model_id))
                .and_then(|option| option.credential_id.clone());
            self.agent_info.thinking_levels(provider, model_id, credential.as_deref())
        } else {
            self.agent_info
                .main_choice()
                .map(|(provider, model_id, credential)| {
                    self.agent_info.thinking_levels(&provider, &model_id, credential.as_deref())
                })
                .unwrap_or_default()
        };
        if !levels.is_empty() {
            let current = self.model_menu.effort.unwrap_or_else(|| bot.and_then(|bot| bot.thinking_level));
            let open = self.model_menu.thinking_open;
            footer.push(Line::Separator);
            let at = stop(&mut nav, Act::Thinking, None, "Thinking");
            footer.push(Line::Row {
                nav: at,
                label: "Thinking".into(),
                meta: None,
                gutter: Gutter::Thinking,
                trailing: if open {
                    Trailing::Chevron("chevron-up")
                } else {
                    Trailing::Value(level_label(current).into(), "chevron-down")
                },
                star: None,
                quiet: false,
            });
            if open {
                let choices: Vec<Option<ThinkingLevel>> =
                    std::iter::once(None).chain(levels.into_iter().map(Some)).collect();
                let first = nav.len();
                for level in &choices {
                    stop(&mut nav, Act::Effort(*level), None, level_label(*level));
                }
                footer.push(Line::Effort { first, levels: choices, current });
                footer.push(Line::Hint(level_hint(current).into()));
            }
        }
        footer.push(Line::Separator);
        let at = stop(&mut nav, Act::Manage, None, "Manage models");
        footer.push(Line::Row {
            nav: at,
            label: "Manage models".into(),
            meta: None,
            gutter: Gutter::Manage,
            trailing: Trailing::Chevron("chevron-right"),
            star: None,
            quiet: false,
        });
        Sheet { search, lines, footer, nav }
    }

    pub(super) fn model_menu_act(&mut self, act: Act, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bot_id) = self.model_menu_bot() else { return };
        match act {
            Act::Close => self.close_model_menu(cx),
            Act::Pick(pick) => self.pick_model(bot_id, pick, window, cx),
            Act::Toggle(source) => {
                if !self.model_menu.expanded.remove(&source) {
                    self.model_menu.expanded.insert(source);
                }
                cx.notify();
            }
            Act::Thinking => {
                self.model_menu.thinking_open = !self.model_menu.thinking_open;
                cx.notify();
            }
            Act::Effort(level) => self.save_thinking(bot_id, level, window, cx),
            Act::Recheck => self.probe_local_models(window, cx),
            Act::Manage => {
                self.close_model_menu(cx);
                self.show_workspace_section(Section::Models, window, cx);
            }
        }
    }

    pub(super) fn toggle_favorite(&mut self, key: &str, cx: &mut Context<Self>) {
        if let Some(favorites) = self.model_menu.favorites.as_mut() {
            self.model_menu.problem = favorites.toggle(key).err().map(str::to_owned);
        }
        cx.notify();
    }

    /// Enter in the search field: the highlighted row, else the first model the search found.
    fn model_menu_enter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(spot) = self.model_menu.highlight {
            self.activate_spot(spot, window, cx);
            return;
        }
        if self.model_menu_query(cx).is_empty() {
            return;
        }
        let first =
            self.model_menu.nav.iter().find(|stop| matches!(stop.act, Act::Pick(Pick::Hosted(_) | Pick::Local(_))));
        if let Some(act) = first.map(|stop| stop.act.clone()) {
            self.model_menu_act(act, window, cx);
        }
    }

    fn activate_spot(&mut self, spot: Spot, window: &mut Window, cx: &mut Context<Self>) {
        let Some(stop) = self.model_menu.nav.get(spot.row) else { return };
        match (&stop.star, spot.star) {
            (Some(key), true) => {
                let key = key.clone();
                self.toggle_favorite(&key, cx);
            }
            _ => {
                let act = stop.act.clone();
                self.model_menu_act(act, window, cx);
            }
        }
    }

    /// The Simple menu's keys: arrows, Home and End move between rows (wrapping), the arrow away
    /// from the line's start reaches a row's star and back, Enter or Space acts, Tab leaves, and
    /// typing jumps to a row, or into the search field when there is one.
    pub(super) fn model_menu_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        let menu = &self.model_menu;
        let count = menu.nav.len();
        let at = menu.highlight;
        let in_search = menu.search_shown
            && menu.query.as_ref().is_some_and(|query| query.read(cx).focus_handle(cx).is_focused(window));
        let go = |this: &mut Self, row: Option<usize>, cx: &mut Context<Self>| {
            this.model_menu.highlight = row.map(|row| Spot { row, star: false });
            cx.notify();
            true
        };
        match key {
            "tab" => {
                self.close_model_menu(cx);
                true
            }
            "down" | "up" | "home" | "end" => {
                if in_search {
                    match (key, at) {
                        ("down", None) => go(self, (count > 0).then_some(0), cx),
                        ("up", Some(Spot { row: 0, .. })) => go(self, None, cx),
                        ("up" | "down", Some(spot)) => go(self, next_index(key, Some(spot.row), count), cx),
                        _ => false,
                    }
                } else {
                    go(self, next_index(key, at.map(|spot| spot.row), count), cx)
                }
            }
            "right" | "left" => {
                let Some(spot) = at else { return false };
                let has_star = menu.nav.get(spot.row).is_some_and(|stop| stop.star.is_some());
                if !has_star || (in_search && !spot.star && key == "left") {
                    return false;
                }
                self.model_menu.highlight = Some(Spot { row: spot.row, star: key == "right" });
                cx.notify();
                true
            }
            "enter" | "space" if !(in_search && key == "space") => match at {
                Some(spot) => {
                    self.activate_spot(spot, window, cx);
                    true
                }
                None => false,
            },
            _ => {
                let Some(text) = event.keystroke.key_char.as_deref() else { return false };
                if modifiers.control || modifiers.alt || modifiers.platform || text.chars().count() != 1 || in_search {
                    return false;
                }
                if self.model_menu.search_shown {
                    if let Some(query) = self.model_menu.query.clone() {
                        query.update(cx, |query, cx| {
                            let typed = format!("{}{text}", query.value());
                            query.set_value(typed, window, cx);
                            query.focus(window, cx);
                        });
                    }
                    self.model_menu.highlight = None;
                    cx.notify();
                    return true;
                }
                let now = Instant::now();
                let typed = match &self.model_menu.typed {
                    Some((typed, at)) if now.duration_since(*at) < TYPEAHEAD_RESET => format!("{typed}{text}"),
                    _ => text.to_owned(),
                }
                .to_lowercase();
                let start = at.map_or(0, |spot| if typed.chars().count() > 1 { spot.row } else { spot.row + 1 });
                let found = (0..count)
                    .map(|offset| (start + offset) % count)
                    .find(|row| self.model_menu.nav[*row].text.to_lowercase().starts_with(&typed));
                self.model_menu.typed = Some((typed, now));
                if found.is_some() {
                    go(self, found, cx);
                }
                true
            }
        }
    }

    fn pick_model(&mut self, bot_id: String, pick: Pick, window: &mut Window, cx: &mut Context<Self>) {
        if self.model_menu.saving {
            return;
        }
        let cli = self.local_cli();
        if let Pick::Local(model) = &pick {
            match cli.map(|cli| cli.save_selection(&bot_id, Some(model))) {
                Some(Ok(())) => self.close_model_menu(cx),
                Some(Err(problem)) => self.model_menu.problem = Some(problem.to_owned()),
                None => self.model_menu.problem = Some("Local models are unavailable here.".into()),
            }
            cx.notify();
            return;
        }
        let (Some(api), Some(space)) = (self.api.as_ref(), self.space_id()) else { return };
        let features = Features::new(api.client.clone());
        self.model_menu.saving = true;
        self.model_menu.problem = None;
        let save = bot_id.clone();
        let work = async move {
            let model = match &pick {
                Pick::Hosted(option) => ModelSelection::set(&option.provider, &option.model_id),
                _ => ModelSelection::clear(),
            };
            let settings = BotSettings { model: Some(model), ..Default::default() };
            features.space(space).update_bot(&save, &settings).await
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            this.model_menu.saving = false;
            match result {
                Ok(_) => {
                    this.agent_info.stale();
                    this.sync_agent_info(window, cx);
                    let local = cli.filter(|cli| cli.selection(&bot_id).ok().flatten().is_some());
                    match local.map(|cli| cli.save_selection(&bot_id, None)) {
                        Some(Err(problem)) => this.model_menu.problem = Some(problem.to_owned()),
                        _ => this.close_model_menu(cx),
                    }
                }
                Err(error) => this.model_menu.problem = Some(api::explain(&error)),
            }
        });
        cx.notify();
    }

    fn save_thinking(
        &mut self,
        bot_id: String,
        level: Option<ThinkingLevel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space)) = (self.api.as_ref(), self.space_id()) else { return };
        if self.model_menu.saving {
            return;
        }
        let features = Features::new(api.client.clone());
        self.model_menu.saving = true;
        self.model_menu.problem = None;
        let work = async move {
            let thinking_level = match level {
                Some(level) => Patch::Set(level),
                None => Patch::Clear,
            };
            let settings = BotSettings { thinking_level, ..Default::default() };
            features.space(space).update_bot(&bot_id, &settings).await
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            this.model_menu.saving = false;
            match result {
                Ok(bot) => {
                    this.model_menu.effort = Some(bot.thinking_level);
                    this.agent_info.stale();
                    this.sync_agent_info(window, cx);
                }
                Err(error) => this.model_menu.problem = Some(api::explain(&error)),
            }
        });
        cx.notify();
    }
}
