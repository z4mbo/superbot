use std::collections::HashSet;

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use superbot_features::local_acp;
use superbot_features::local_cli::{InstalledModel, LocalCli, Provider, Status};
use superbot_features::{BotSettings, Features, ModelOption, ModelSelection};
use superbot_workspace_panel::Section;

use crate::api;
use crate::app::{Desktop, Menu, MenuKind};
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::new_menu::menu_shadow;
use crate::ui::{icon, Type};

/// Rows a group shows before "Show all", so a provider with a long catalog stays one glance.
const SUGGESTED: usize = 6;
const LOCAL_GROUP: &str = "On this computer";

/// The model popover's own state; what it lists is read from the agent and the local CLI.
#[derive(Default)]
pub struct ModelMenu {
    query: Option<Entity<InputState>>,
    _query_events: Option<Subscription>,
    local: Option<Vec<LocalGroup>>,
    probing: bool,
    saving: bool,
    expanded: HashSet<String>,
    problem: Option<String>,
}

#[derive(Clone)]
struct LocalGroup {
    engine: &'static str,
    models: Vec<InstalledModel>,
}

#[derive(Clone)]
enum Pick {
    Main,
    Hosted(ModelOption),
    Local(InstalledModel),
}

struct Choice {
    pick: Pick,
    label: String,
    meta: String,
    current: bool,
}

struct Group {
    key: String,
    label: String,
    rows: Vec<Choice>,
}

/// Engines the desktop can run a local turn with, each with the models it reports.
async fn probe_local(cli: LocalCli) -> Vec<LocalGroup> {
    let direct = Provider::ALL.map(|provider| {
        let cli = cli.clone();
        async move {
            if cli.status(provider).await != Status::Ready {
                return None;
            }
            let models = cli.catalog(provider).await.ok()?;
            (!models.is_empty()).then_some(LocalGroup { engine: provider.name(), models })
        }
    });
    let acp = local_acp::inventory()
        .iter()
        .filter(|provider| {
            matches!(
                provider.disposition,
                local_acp::Disposition::Acp
                    | local_acp::Disposition::PiRpc
                    | local_acp::Disposition::LocalConfiguration
            )
        })
        .map(|provider| async move {
            let engine = if provider.disposition == local_acp::Disposition::LocalConfiguration {
                local_acp::load_custom(&LocalCli::config_dir()?).ok().flatten()
            } else {
                local_acp::discover(provider.id).ok().flatten()
            }?;
            let probe = engine.probe().await.ok()?;
            if probe.needs_auth || probe.models.is_empty() || !engine.safe_to_run().await.unwrap_or(false) {
                return None;
            }
            let models = probe
                .models
                .into_iter()
                .map(|model| InstalledModel { provider: provider.id.to_owned(), id: model.id, label: model.label })
                .collect();
            Some(LocalGroup { engine: provider.label, models })
        });
    let (direct, acp) =
        futures_util::join!(futures_util::future::join_all(direct), futures_util::future::join_all(acp));
    direct.into_iter().chain(acp).flatten().collect()
}

fn matches(query: &str, texts: &[&str]) -> bool {
    query.is_empty() || texts.iter().any(|text| text.to_lowercase().contains(query))
}

impl Desktop {
    /// Opens the model popover for `bot_id` where the pointer is: under the header's model half
    /// or the Details row that was clicked.
    pub(crate) fn open_model_menu(&mut self, bot_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let kind = MenuKind::Model(bot_id.to_owned());
        if self.menu.as_ref().is_some_and(|menu| menu.kind == kind) {
            self.menu = None;
            cx.notify();
            return;
        }
        let at = window.mouse_position() + point(px(0.), px(18.));
        self.menu = Some(Menu { kind, at });
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search models"));
        query.update(cx, |query, cx| query.focus(window, cx));
        let events = cx.subscribe_in(&query, window, |this, _, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { .. } => this.pick_first_model(window, cx),
            _ => cx.notify(),
        });
        let menu = &mut self.model_menu;
        menu.query = Some(query);
        menu._query_events = Some(events);
        menu.problem = None;
        menu.expanded.clear();
        self.sync_agent_info(window, cx);
        if self.model_menu.local.is_none() {
            self.probe_local_models(window, cx);
        }
        cx.notify();
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

    fn model_menu_query(&self, cx: &App) -> String {
        self.model_menu.query.as_ref().map(|query| query.read(cx).value().trim().to_lowercase()).unwrap_or_default()
    }

    /// The pinned current row, then each group of choices the search leaves.
    fn model_menu_rows(&self, bot_id: &str, query: &str) -> (Option<Choice>, Vec<Group>) {
        let local = self.local_cli().and_then(|cli| cli.selection(bot_id).ok().flatten());
        let own = self.agent_info.bot(bot_id).and_then(|bot| bot.model_provider.clone().zip(bot.model_id.clone()));
        let main_label = self.agent_info.main_model_label();
        let options = self.agent_info.model_options().unwrap_or_default();

        let current = if let Some(model) = &local {
            let engine = self.local_engine_name(model);
            Some(Choice { pick: Pick::Local(model.clone()), label: model.label.clone(), meta: engine, current: true })
        } else if let Some((provider, model_id)) = &own {
            let option = options.iter().find(|option| option.is(provider, model_id));
            option.map(|option| Choice {
                pick: Pick::Hosted(option.clone()),
                label: option.label.clone(),
                meta: option.source.clone(),
                current: true,
            })
        } else {
            main_label.clone().map(|label| Choice {
                pick: Pick::Main,
                label: "Main model".into(),
                meta: label,
                current: true,
            })
        };

        let mut groups: Vec<Group> = Vec::new();
        let following = local.is_none() && own.is_none();
        if !following && main_label.is_some() && matches(query, &["main model", main_label.as_deref().unwrap_or("")]) {
            groups.push(Group {
                key: "main".into(),
                label: String::new(),
                rows: vec![Choice {
                    pick: Pick::Main,
                    label: "Main model".into(),
                    meta: main_label.clone().unwrap_or_default(),
                    current: false,
                }],
            });
        }
        for option in options {
            if !matches(query, &[&option.label, &option.source, &option.model_id]) {
                continue;
            }
            let current =
                local.is_none() && own.as_ref().is_some_and(|(provider, model_id)| option.is(provider, model_id));
            let choice = Choice {
                pick: Pick::Hosted(option.clone()),
                label: option.label.clone(),
                meta: String::new(),
                current,
            };
            match groups.iter_mut().find(|group| group.key == option.source) {
                Some(group) => group.rows.push(choice),
                None => {
                    groups.push(Group { key: option.source.clone(), label: option.source.clone(), rows: vec![choice] })
                }
            }
        }
        let local_rows: Vec<Choice> = self
            .model_menu
            .local
            .iter()
            .flatten()
            .flat_map(|group| group.models.iter().map(move |model| (group.engine, model)))
            .filter(|(engine, model)| matches(query, &[&model.label, engine, LOCAL_GROUP]))
            .map(|(engine, model)| Choice {
                pick: Pick::Local(model.clone()),
                label: model.label.clone(),
                meta: engine.to_owned(),
                current: local.as_ref() == Some(model),
            })
            .collect();
        if !local_rows.is_empty() {
            groups.push(Group { key: LOCAL_GROUP.into(), label: LOCAL_GROUP.into(), rows: local_rows });
        }
        (current, groups)
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

    fn pick_first_model(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(MenuKind::Model(bot_id)) = self.menu.as_ref().map(|menu| menu.kind.clone()) else { return };
        let query = self.model_menu_query(cx);
        if query.is_empty() {
            return;
        }
        let (_, groups) = self.model_menu_rows(&bot_id, &query);
        if let Some(choice) = groups.into_iter().flat_map(|group| group.rows).next() {
            self.pick_model(bot_id, choice.pick, window, cx);
        }
    }

    fn close_model_menu(&mut self, cx: &mut Context<Self>) {
        self.menu = None;
        self.model_menu.query = None;
        self.model_menu._query_events = None;
        cx.notify();
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

    fn choice_row(
        &self,
        bot_id: &str,
        index: usize,
        choice: Choice,
        pinned: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let hover = theme.ink_at(0.06);
        let bot = bot_id.to_owned();
        let pick = choice.pick.clone();
        let id =
            if pinned { SharedString::from("model-current") } else { SharedString::from(format!("model-row-{index}")) };
        let leading = match (&choice.pick, pinned) {
            (Pick::Local(_), true) => Some(icon("monitor", px(14.), theme.ink_tertiary)),
            (Pick::Hosted(_), true) | (Pick::Main, true) => Some(icon("sparkles", px(14.), theme.ink_tertiary)),
            _ => None,
        };
        div()
            .id(id)
            .min_h(px(36.))
            .py_1()
            .pl(px(6.))
            .pr_2()
            .flex()
            .items_center()
            .gap_2()
            .rounded(radius::MENU_ROW)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(move |this, _, window, cx| {
                if pinned {
                    this.close_model_menu(cx);
                } else {
                    this.pick_model(bot.clone(), pick.clone(), window, cx);
                }
            }))
            .child(div().w(px(16.)).flex_shrink_0().flex().justify_center().children(leading))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(div().item().text_color(theme.ink).truncate().child(choice.label))
                    .when(!choice.meta.is_empty(), |text| {
                        text.child(div().meta().text_color(theme.ink_tertiary).truncate().child(choice.meta))
                    }),
            )
            .when(choice.current, |row| row.child(icon("check", px(14.), theme.ink)))
            .into_any_element()
    }

    fn quiet_row(
        &self,
        id: impl Into<ElementId>,
        glyph: Option<&'static str>,
        label: String,
        theme: &Theme,
    ) -> Stateful<Div> {
        div()
            .id(id)
            .h(px(32.))
            .pl(px(6.))
            .pr_2()
            .flex()
            .items_center()
            .gap_2()
            .rounded(radius::MENU_ROW)
            .child(
                div()
                    .w(px(16.))
                    .flex_shrink_0()
                    .flex()
                    .justify_center()
                    .children(glyph.map(|glyph| icon(glyph, px(16.), theme.ink_secondary))),
            )
            .child(div().flex_1().min_w_0().item().truncate().child(label))
    }

    /// The agent's model, chosen in a popover like the Simple menu: search, the current model
    /// pinned on top, the space's models by connection, then this computer's local engines.
    pub fn render_model_menu(&mut self, bot_id: &str, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let hover = theme.ink_at(0.06);
        let at = self.menu.as_ref().map(|menu| menu.at).unwrap_or_default();
        let query = self.model_menu_query(cx);
        let (current, groups) = self.model_menu_rows(bot_id, &query);
        let loading_hosted = self.agent_info.model_options().is_none();
        let probing = self.model_menu.probing;
        let probed_none = self.model_menu.local.as_ref().is_some_and(Vec::is_empty) && self.local_cli().is_some();
        let results: usize = groups.iter().map(|group| group.rows.len()).sum();

        let search = self.model_menu.query.clone().map(|input| {
            let clear = (!query.is_empty()).then(|| {
                div()
                    .id("model-search-clear")
                    .size_5()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(|this, _, window, cx| {
                        if let Some(query) = &this.model_menu.query {
                            query.update(cx, |query, cx| query.set_value("", window, cx));
                        }
                        cx.notify();
                    }))
                    .child(icon("x", px(14.), theme.ink_tertiary))
            });
            div()
                .h(px(36.))
                .flex_shrink_0()
                .pl(px(14.))
                .pr_2()
                .flex()
                .items_center()
                .gap_2()
                .border_b_1()
                .border_color(theme.ink_at(0.1))
                .child(icon("search", px(16.), theme.ink_tertiary))
                .child(div().flex_1().min_w_0().body().child(Input::new(&input).appearance(false).bordered(false)))
                .children(clear)
        });

        let mut list: Vec<AnyElement> = Vec::new();
        let mut groups = groups;
        let mut index = 1;
        if query.is_empty() {
            let pinned = current.is_some();
            if let Some(choice) = current {
                list.push(self.choice_row(bot_id, 0, choice, true, &theme, cx));
            }
            if groups.first().is_some_and(|group| group.key == "main") {
                for choice in groups.remove(0).rows {
                    list.push(self.choice_row(bot_id, index, choice, false, &theme, cx));
                    index += 1;
                }
            }
            if pinned && !groups.is_empty() {
                list.push(div().my_1().mx_2().h(px(1.)).bg(theme.hairline.opacity(0.5)).into_any_element());
            }
        }
        for (position, group) in groups.into_iter().enumerate() {
            let expanded = !query.is_empty() || self.model_menu.expanded.contains(&group.key);
            let total = group.rows.len();
            if !group.label.is_empty() {
                list.push(
                    div()
                        .when(position > 0, |label| label.mt_1())
                        .pl(px(30.))
                        .pr_2()
                        .pt_1p5()
                        .pb_1()
                        .meta()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.ink_tertiary)
                        .truncate()
                        .child(group.label.clone())
                        .into_any_element(),
                );
            }
            for choice in group.rows.into_iter().take(if expanded { usize::MAX } else { SUGGESTED }) {
                list.push(self.choice_row(bot_id, index, choice, false, &theme, cx));
                index += 1;
            }
            if total > SUGGESTED && query.is_empty() {
                let key = group.key.clone();
                let label = if expanded { "Show suggested".to_owned() } else { format!("Show all {total}") };
                list.push(
                    self.quiet_row(SharedString::from(format!("model-show-all-{position}")), None, label, &theme)
                        .text_color(theme.ink_secondary)
                        .cursor_pointer()
                        .hover(move |style| style.bg(hover))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.model_menu.expanded.remove(&key) {
                                this.model_menu.expanded.insert(key.clone());
                            }
                            cx.notify();
                        }))
                        .child(icon(if expanded { "chevron-up" } else { "chevron-down" }, px(16.), theme.ink_tertiary))
                        .into_any_element(),
                );
            }
        }
        if loading_hosted || probing {
            let label = if loading_hosted { "Looking for models…" } else { "Looking for local models…" };
            list.push(
                self.quiet_row("model-loading", None, label.into(), &theme)
                    .text_color(theme.ink_tertiary)
                    .child(Spinner::new().with_size(px(14.)).color(theme.ink_tertiary))
                    .into_any_element(),
            );
        } else if probed_none && query.is_empty() {
            list.push(
                self.quiet_row("model-local-again", Some("refresh-cw"), "Check this computer again".into(), &theme)
                    .text_color(theme.ink_secondary)
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(|this, _, window, cx| this.probe_local_models(window, cx)))
                    .into_any_element(),
            );
        }
        if !query.is_empty() && results == 0 && !loading_hosted {
            list.push(
                div()
                    .px_2()
                    .py_2()
                    .body()
                    .text_color(theme.ink_tertiary)
                    .child(format!("No models match \u{201c}{query}\u{201d}."))
                    .into_any_element(),
            );
        }

        let footer = div()
            .flex_shrink_0()
            .p(px(6.))
            .pt_0()
            .flex()
            .flex_col()
            .gap_0p5()
            .child(div().mb_1().mx_2().h(px(1.)).bg(theme.hairline.opacity(0.5)))
            .when_some(self.model_menu.problem.clone(), |footer, problem| {
                footer.child(div().px_2().py_1().body().text_color(theme.danger).child(problem))
            })
            .child(
                self.quiet_row("model-manage", Some("settings"), "Manage models".into(), &theme)
                    .text_color(theme.ink)
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.close_model_menu(cx);
                        this.show_workspace_section(Section::Models, window, cx);
                    }))
                    .child(icon("chevron-right", px(16.), theme.ink_tertiary)),
            );

        let sheet = div()
            .id("model-menu")
            .w(px(320.))
            .max_h(px(480.))
            .flex()
            .flex_col()
            .rounded(radius::CARD)
            .bg(theme.menu)
            .border_1()
            .border_color(theme.hairline.opacity(0.5))
            .shadow(menu_shadow(&theme))
            .occlude()
            .when(self.model_menu.saving, |sheet| sheet.opacity(0.7))
            .children(search)
            .child(
                div()
                    .id("model-menu-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p(px(6.))
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .children(list),
            )
            .child(footer);

        div()
            .id("menu-backdrop")
            .absolute()
            .inset_0()
            .occlude()
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| this.close_model_menu(cx)))
            .on_mouse_down(MouseButton::Right, cx.listener(|this, _, _, cx| this.close_model_menu(cx)))
            .child(
                deferred(
                    anchored().position(at).anchor(Anchor::TopCenter).snap_to_window_with_margin(px(8.)).child(sheet),
                )
                .with_priority(1),
            )
            .into_any_element()
    }
}
