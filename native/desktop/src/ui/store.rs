mod agents;
mod app_view;
mod confirm;
mod detail;
mod marketplace;
mod presets;
mod server_sign_in;
mod services;
mod skills;
mod t3_inbox;

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::{self, Installation, ManifestPart, PluginVersion};
use crate::app::create::Template;
use crate::app::{Desktop, View};
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::chrome::SegmentTrack;
use crate::ui::creator::Draft;
use crate::ui::releases::VersionSwitch;
use crate::ui::{empty_line, error_line, field_box, icon, page, pill_button, Tone, Type};
use app_view::{app_parts, OpenApp};
use confirm::Confirm;
use marketplace::Shelf;
use services::{Services, SignIn};
use superbot_features::AgentSkillEntry;

/// The Store's four parts, each one kind of thing to add.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Agents,
    Skills,
    Plugins,
    Apps,
}

/// The lists within Plugins.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Discover,
    Installed,
    Yours,
    Review,
}

/// What the server found for a search across the whole registry.
pub struct Found {
    pub query: String,
    pub plugins: Vec<PluginVersion>,
}

pub struct Rejection {
    pub version_id: String,
    pub reason: Entity<InputState>,
}

pub struct Store {
    pub section: Section,
    pub tab: Tab,
    pub templates: Option<Result<Vec<Template>, String>>,
    pub skills: Option<Result<Vec<AgentSkillEntry>, String>>,
    pub query: Entity<InputState>,
    pub loading: bool,
    pub loaded: bool,
    pub error: Option<String>,
    pub catalog: Vec<PluginVersion>,
    pub found: Option<Found>,
    searches: u64,
    pub installations: Vec<Installation>,
    pub mine: Vec<PluginVersion>,
    pub queue: Vec<PluginVersion>,
    /// The slug of the plugin whose page is open.
    pub detail: Option<String>,
    /// The id of the version, installation or agent with a change on its way to the server.
    pub busy: Option<String>,
    pub draft: Option<Draft>,
    pub rejection: Option<Rejection>,
    pub version_switch: Option<VersionSwitch>,
    pub app: Option<OpenApp>,
    pub t3: Option<t3_inbox::T3Inbox>,
    pub confirm: Option<Confirm>,
    /// The confirmed change is on its way to the server.
    pub confirming: bool,
    pub services: Option<Result<Services, String>>,
    pub services_loading: bool,
    pub sign_in: Option<SignIn>,
    pub presets: presets::Presets,
    pub marketplace: marketplace::Marketplace,
    sign_ins: u64,
    _query_changed: Subscription,
}

impl Store {
    pub fn new(window: &mut Window, cx: &mut Context<Desktop>) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search"));
        let changed = cx.subscribe(&query, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.search_plugins(cx);
            }
        });
        Self {
            section: Section::Apps,
            tab: Tab::Discover,
            templates: None,
            skills: None,
            query,
            loading: false,
            loaded: false,
            error: None,
            catalog: Vec::new(),
            found: None,
            searches: 0,
            installations: Vec::new(),
            mine: Vec::new(),
            queue: Vec::new(),
            detail: None,
            busy: None,
            draft: None,
            rejection: None,
            version_switch: None,
            app: None,
            t3: None,
            confirm: None,
            confirming: false,
            services: None,
            services_loading: false,
            sign_in: None,
            sign_ins: 0,
            presets: presets::Presets::default(),
            marketplace: marketplace::Marketplace::default(),
            _query_changed: changed,
        }
    }

    /// Drops what was read for another Space or another account.
    pub fn forget(&mut self) {
        self.loaded = false;
        self.error = None;
        self.catalog.clear();
        self.found = None;
        self.installations.clear();
        self.mine.clear();
        self.queue.clear();
        self.detail = None;
        self.busy = None;
        self.draft = None;
        self.rejection = None;
        self.version_switch = None;
        self.app = None;
        self.t3 = None;
        self.confirm = None;
        self.confirming = false;
        self.services = None;
        self.sign_in = None;
        self.presets.forget();
        self.marketplace.forget();
        self.templates = None;
        self.skills = None;
    }

    pub fn settle_confirm(&mut self) {
        self.confirm = None;
        self.confirming = false;
    }

    /// Leaves the installation on the version it is pinned to. False when no switch was open
    /// or one is already on its way to the server.
    pub fn cancel_version_switch(&mut self) -> bool {
        match &self.version_switch {
            Some(switch) if !switch.busy => {
                self.version_switch = None;
                true
            }
            _ => false,
        }
    }

    /// Every approved version of one plugin, newest first.
    fn releases(&self, slug: &str) -> Vec<PluginVersion> {
        let mut releases: Vec<PluginVersion> = Vec::new();
        let found = self.found.iter().flat_map(|found| &found.plugins);
        for version in self.catalog.iter().chain(found).filter(|version| version.slug == slug) {
            if !releases.iter().any(|known| known.id == version.id) {
                releases.push(version.clone());
            }
        }
        releases.sort_by(|a, b| b.version.cmp(&a.version));
        releases
    }

    /// The newest approved version of each plugin, by name: what the server found for the
    /// search in the field, or everything read so far while that answer is on its way.
    pub fn latest(&self, query: &str) -> Vec<&PluginVersion> {
        let versions = match &self.found {
            Some(found) if found.query == query => &found.plugins,
            _ => &self.catalog,
        };
        let mut latest: Vec<&PluginVersion> = Vec::new();
        for version in versions {
            match latest.iter_mut().find(|known| known.slug == version.slug) {
                Some(known) if known.version < version.version => *known = version,
                Some(_) => {}
                None => latest.push(version),
            }
        }
        latest.sort_by_key(|version| version.manifest.name.to_lowercase());
        latest
    }

    pub fn installation(&self, slug: &str) -> Option<&Installation> {
        self.installations.iter().find(|installation| installation.plugin.slug == slug)
    }
}

impl Desktop {
    /// Asks the server for the search once typing pauses, since Discover shows only what has
    /// been read and the registry can hold more.
    fn search_plugins(&mut self, cx: &mut Context<Self>) {
        const TYPING_PAUSE: std::time::Duration = std::time::Duration::from_millis(300);
        self.store.searches += 1;
        let search = self.store.searches;
        let query = self.store.query.read(cx).value().trim().to_lowercase();
        cx.notify();
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else {
            return;
        };
        if query.is_empty() {
            self.store.found = None;
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TYPING_PAUSE).await;
            let current = |this: &Self| this.store.searches == search;
            if !this.read_with(cx, |this, _| current(this)).unwrap_or(false) {
                return;
            }
            let asked = query.clone();
            let result = crate::runtime::network(async move { api.discover(&space_id, Some(&asked)).await }).await;
            this.update(cx, |this, cx| {
                if let (true, Ok(plugins)) = (current(this), result) {
                    this.store.found = Some(Found { query, plugins });
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    pub fn load_store(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else {
            return;
        };
        let reviews = self.me.as_ref().is_some_and(|me| me.is_admin);
        self.store.loading = true;
        self.store.error = None;
        let work = async move {
            let (catalog, installations, mine) = tokio::try_join!(
                api.discover(&space_id, None),
                api.installations(&space_id),
                api.my_plugins(&space_id)
            )?;
            let queue = if reviews { api.review_queue(&space_id).await? } else { Vec::new() };
            Ok((catalog, installations, mine, queue))
        };
        self.call(window, cx, work, |this, result, _, _| {
            this.store.loading = false;
            match result {
                Ok((catalog, installations, mine, queue)) => {
                    this.store.loaded = true;
                    this.store.catalog = catalog;
                    this.store.installations = installations;
                    this.store.mine = mine;
                    this.store.queue = queue;
                }
                Err(error) => this.store.error = Some(api::explain(&error)),
            }
        });
        self.load_section(window, cx);
        cx.notify();
    }

    /// Reads installations and the open app's records again after the server says they changed,
    /// so a record an agent adds shows up while the app is open.
    pub fn plugins_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        if self.view != View::Store || !self.store.loaded {
            return;
        }
        let work = async move { api.installations(&space_id).await };
        self.call(window, cx, work, |this, result, _, _| {
            if let Ok(installations) = result {
                this.store.installations = installations;
            }
        });
        if self.store.app.is_some() {
            self.load_records(false, window, cx);
        }
        if self.store.t3.is_some() {
            self.load_t3_records(window, cx);
        }
    }

    fn install(&mut self, version: &PluginVersion, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else {
            return;
        };
        let (version_id, name) = (version.id.clone(), version.manifest.name.clone());
        self.store.busy = Some(version_id.clone());
        let work = async move { api.install_plugin(&space_id, &version_id).await };
        self.call(window, cx, work, move |this, result, _, cx| {
            this.store.busy = None;
            match result {
                Ok(installation) => {
                    this.store.installations.retain(|known| known.id != installation.id);
                    this.store.installations.push(installation);
                    this.notify(format!("{name} installed. Choose which agents can use it."), false, None, cx);
                }
                Err(error) => this.notify(api::explain(&error), true, None, cx),
            }
        });
        cx.notify();
    }

    fn review(&mut self, version_id: String, rejection: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else {
            return;
        };
        if rejection.as_ref().is_some_and(|reason| reason.trim().is_empty()) {
            self.notify("Say why it was rejected, so its author can fix it.", true, None, cx);
            return;
        }
        self.store.busy = Some(version_id.clone());
        let work = async move {
            api.review_plugin(&space_id, &version_id, rejection.as_deref()).await?;
            tokio::try_join!(api.review_queue(&space_id), api.discover(&space_id, None))
        };
        self.call(window, cx, work, |this, result, _, cx| {
            this.store.busy = None;
            match result {
                Ok((queue, catalog)) => {
                    this.store.queue = queue;
                    this.store.catalog = catalog;
                    this.store.rejection = None;
                }
                Err(error) => this.notify(api::explain(&error), true, None, cx),
            }
        });
        cx.notify();
    }

    pub fn render_store(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let body = if self.store.draft.is_some() {
            self.render_creator(window, cx)
        } else if self.store.t3.is_some() {
            self.render_t3_inbox(&theme, cx)
        } else if self.store.app.is_some() {
            self.render_app(&theme, cx)
        } else if self.store.marketplace.is_open() {
            self.render_marketplace_plugin(&theme, cx)
        } else if let Some(slug) = self.store.detail.clone() {
            self.render_plugin_page(&slug, &theme, cx)
        } else {
            self.render_store_home(&theme, window, cx)
        };
        page(body, window, cx).into_any_element()
    }

    /// Reads what the open section shows, unless it was read already.
    fn load_section(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.store.section {
            Section::Agents => self.load_store_templates(window, cx),
            Section::Skills => self.load_store_skills(window, cx),
            Section::Apps => self.load_services(window, cx),
            Section::Plugins => {
                if self.store.marketplace.unread() {
                    self.load_marketplace(window, cx);
                }
            }
        }
    }

    fn show_section(&mut self, section: Section, window: &mut Window, cx: &mut Context<Self>) {
        self.store.section = section;
        self.store.rejection = None;
        let unread = match section {
            Section::Agents => self.store.templates.is_none(),
            Section::Skills => self.store.skills.is_none(),
            Section::Apps => self.store.services.is_none(),
            Section::Plugins => self.store.marketplace.unread(),
        };
        if unread {
            self.load_section(window, cx);
        }
        cx.notify();
    }

    fn render_store_home(&mut self, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let admin = self.me.as_ref().is_some_and(|me| me.is_admin);
        let (section, tab) = (self.store.section, self.store.tab);
        let sections = [
            (Section::Agents, "Agents", "bot"),
            (Section::Skills, "Skills", "sparkles"),
            (Section::Plugins, "Plugins", "puzzle"),
            (Section::Apps, "Apps", "layout-grid"),
        ];
        let subtitle = match section {
            Section::Agents => "Ready-made agents to add to this Space.",
            Section::Skills => "What your agents know how to do.",
            Section::Plugins => "Community plugins with skills, connectors and apps.",
            Section::Apps => "Accounts and services your agents can use.",
        };
        let tabs = [
            (Tab::Discover, "Discover", true),
            (Tab::Installed, "Installed", true),
            (Tab::Yours, "Yours", true),
            (Tab::Review, "Review", admin),
        ];
        let track = SegmentTrack::new("store-sections", theme, window, cx);
        let switcher = div().flex().child(track.element().items_center().gap_1().children(sections.into_iter().map(
            |(value, label, glyph)| {
                let chosen = section == value;
                let button = section_tab(label)
                    .child(icon(glyph, px(15.), if chosen { theme.ink } else { theme.ink_secondary }))
                    .child(label)
                    .on_click(cx.listener(move |this, _, window, cx| this.show_section(value, window, cx)));
                track.control(button, chosen, theme)
            },
        )));
        let header = div()
            .flex()
            .flex_col()
            .gap_4()
            .pb_4()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_0p5()
                            .child(div().page_title().child("Store"))
                            .child(div().body().text_color(theme.ink_secondary).child(subtitle)),
                    )
                    .when(section == Section::Plugins, |row| {
                        row.child(pill_button("create-plugin", "Create plugin", Tone::Primary, true, theme).on_click(
                            cx.listener(|this, _, window, cx| {
                                this.store.draft = Some(Draft::new(None, window, cx));
                                cx.notify();
                            }),
                        ))
                    }),
            )
            .child(switcher)
            .child(
                div()
                    .h_9()
                    .px_3p5()
                    .flex()
                    .items_center()
                    .gap_2p5()
                    .rounded_full()
                    .bg(theme.control.opacity(0.7))
                    .child(icon("search", px(15.), theme.ink_secondary))
                    .child(div().flex_1().child(Input::new(&self.store.query).appearance(false).bordered(false))),
            )
            .when(section == Section::Plugins, |header| {
                let track = SegmentTrack::new("store-plugin-tabs", theme, window, cx);
                header.child(div().flex().child(track.element().items_center().gap_1().children(
                    tabs.into_iter().filter(|(_, _, shown)| *shown).map(|(value, label, _)| {
                        let button = section_tab(label)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.store.tab = value;
                                this.store.rejection = None;
                                cx.notify();
                            }))
                            .child(label);
                        track.control(button, tab == value, theme)
                    }),
                )))
            });

        let content = match section {
            Section::Agents => self.render_store_agents(theme, window, cx),
            Section::Skills => self.render_store_skills(theme, window, cx),
            Section::Apps => self.render_services(theme, cx),
            Section::Plugins => self.render_plugins(theme, window, cx),
        };

        div()
            .size_full()
            .flex()
            .flex_col()
            .child(header)
            .child(div().id("store-scroll").flex_1().min_h_0().overflow_y_scroll().pb_8().child(content))
            .into_any_element()
    }

    fn render_plugins(&mut self, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let tab = self.store.tab;
        let registry = if let Some(error) = self.store.error.clone() {
            Some(
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap_3()
                    .child(error_line(error, theme))
                    .child(
                        pill_button("store-retry", "Try again", Tone::Quiet, true, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.load_store(window, cx))),
                    )
                    .into_any_element(),
            )
        } else if !self.store.loaded {
            Some(empty_line(if self.store.loading { "Loading plugins…" } else { "" }, theme).into_any_element())
        } else {
            match tab {
                Tab::Yours => return self.render_yours(theme, cx),
                Tab::Review => return self.render_review(theme, cx),
                Tab::Discover | Tab::Installed => self.render_catalog(tab == Tab::Installed, theme, window, cx),
            }
        };
        if matches!(tab, Tab::Yours | Tab::Review) {
            return registry.unwrap_or_else(|| div().into_any_element());
        }
        let shelf = if tab == Tab::Installed { Shelf::Installed } else { Shelf::Packages };
        let packages = self.render_marketplace_section(shelf, theme, cx);
        if registry.is_none() && packages.is_none() {
            let line = if !self.store.query.read(cx).value().trim().is_empty() {
                "No plugin matches that search."
            } else if tab == Tab::Installed {
                "Nothing installed in this Space yet. Install a plugin from Discover."
            } else {
                "No plugins are published yet. Create the first one."
            };
            return empty_line(line, theme).pt_2().into_any_element();
        }
        let registry = registry.map(|list| {
            div().flex().flex_col().gap_1().child(div().section().pb_1().child("Community")).child(list).into_any_element()
        });
        div().flex().flex_col().gap_6().children(registry).children(packages).into_any_element()
    }

    /// The community registry's plugins, or the ones installed here; none when nothing matches.
    fn render_catalog(
        &mut self,
        installed_only: bool,
        theme: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let query = self.store.query.read(cx).value().trim().to_lowercase();
        // The server has already matched these, on more than the fields shown here.
        let matched = !installed_only && self.store.found.as_ref().is_some_and(|found| found.query == query);
        let installed: Vec<PluginVersion> = self.store.installations.iter().map(|known| known.plugin.clone()).collect();
        let shown: Vec<PluginVersion> =
            if installed_only { installed } else { self.store.latest(&query).into_iter().cloned().collect() }
                .into_iter()
                .filter(|version| {
                    matched
                        || query.is_empty()
                        || version.manifest.name.to_lowercase().contains(&query)
                        || version.manifest.description.to_lowercase().contains(&query)
                        || version.slug.contains(&query)
                })
                .collect();

        if shown.is_empty() {
            return None;
        }

        let columns = if window.viewport_size().width > px(1180.) { 2 } else { 1 };
        Some(
            div()
            .grid()
            .grid_cols(columns)
            .gap_x_4()
            .gap_y_1()
            .children(shown.into_iter().map(|version| self.render_card(version, theme, cx)))
            .into_any_element(),
        )
    }

    fn render_card(&mut self, version: PluginVersion, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let installation = self.store.installation(&version.slug);
        let installed = installation.is_some();
        let busy = self.store.busy.as_deref() == Some(version.id.as_str());
        let slug = version.slug.clone();
        let hover = theme.raised.opacity(0.4);
        let openable = installation.and_then(|installation| {
            app_parts(&installation.plugin.manifest.parts)
                .next()
                .map(|part| (installation.clone(), part.id().to_owned()))
        });
        let action = if let Some((installation, part_id)) = openable {
            pill_button(SharedString::from(format!("open-{}", version.id)), "Open", Tone::Quiet, true, theme).on_click(
                cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.open_app(&installation, &part_id, window, cx);
                }),
            )
        } else if installed {
            pill_button(SharedString::from(format!("manage-{}", version.id)), "Manage", Tone::Quiet, true, theme)
                .on_click(cx.listener({
                    let slug = slug.clone();
                    move |this, _, _, cx| {
                        this.store.detail = Some(slug.clone());
                        cx.stop_propagation();
                        cx.notify();
                    }
                }))
        } else {
            let label = if busy { "Installing…" } else { "Install" };
            pill_button(SharedString::from(format!("install-{}", version.id)), label, Tone::Quiet, !busy, theme)
                .on_click(cx.listener({
                    let version = version.clone();
                    move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.install(&version, window, cx);
                    }
                }))
        };
        div()
            .id(SharedString::from(format!("plugin-{}", version.id)))
            .flex()
            .items_center()
            .gap_3()
            .p_2()
            .rounded(radius::CARD)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.store.detail = Some(slug.clone());
                cx.notify();
            }))
            .child(plugin_mark(&version, px(40.), theme))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .child(
                                div()
                                    .item()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .truncate()
                                    .child(version.manifest.name.clone()),
                            )
                            .when(installed, |row| row.child(icon("check", px(13.), theme.success))),
                    )
                    .child(
                        div()
                            .body()
                            .text_color(theme.ink_secondary)
                            .truncate()
                            .child(version.manifest.description.clone()),
                    ),
            )
            .child(action)
            .into_any_element()
    }

    fn render_yours(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        if self.store.mine.is_empty() {
            return empty_line("Nothing published yet. Create a plugin to submit it for review.", theme)
                .pt_2()
                .into_any_element();
        }
        let mut mine = self.store.mine.clone();
        mine.sort_by(|a, b| a.slug.cmp(&b.slug).then(b.version.cmp(&a.version)));
        div()
            .flex()
            .flex_col()
            .gap_1()
            .children(mine.into_iter().enumerate().map(|(index, version)| {
                let newest = self
                    .store
                    .mine
                    .iter()
                    .filter(|other| other.slug == version.slug)
                    .all(|other| other.version <= version.version);
                let (label, tone) = status_label(&version.status, theme);
                let revise = version.clone();
                div()
                    .flex()
                    .items_start()
                    .gap_3()
                    .p_2()
                    .child(plugin_mark(&version, px(40.), theme))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        div()
                                            .item()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .truncate()
                                            .child(version.manifest.name.clone()),
                                    )
                                    .child(div().meta().text_color(tone).child(label)),
                            )
                            .child(
                                div()
                                    .meta()
                                    .text_color(theme.ink_tertiary)
                                    .child(format!("{} · Version {}", version.slug, version.version)),
                            )
                            .children(
                                version
                                    .reason
                                    .clone()
                                    .map(|reason| div().pt_1().body().text_color(theme.ink_secondary).child(reason)),
                            ),
                    )
                    .when(newest, |row| {
                        row.child(pill_button(("revise", index), "New version", Tone::Quiet, true, theme).on_click(
                            cx.listener(move |this, _, window, cx| {
                                this.store.draft = Some(Draft::new(Some(&revise), window, cx));
                                cx.notify();
                            }),
                        ))
                    })
            }))
            .into_any_element()
    }

    fn render_review(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        if self.store.queue.is_empty() {
            return empty_line("Nothing is waiting for review.", theme).pt_2().into_any_element();
        }
        let busy = self.store.busy.clone();
        let rejecting =
            self.store.rejection.as_ref().map(|rejection| (rejection.version_id.clone(), rejection.reason.clone()));
        div()
            .flex()
            .flex_col()
            .gap_3()
            .children(self.store.queue.clone().into_iter().enumerate().map(|(index, version)| {
                let waiting = busy.as_deref() == Some(version.id.as_str());
                let reason = rejecting.as_ref().filter(|(id, _)| id == &version.id).map(|(_, reason)| reason.clone());
                let (approve_id, reject_id) = (version.id.clone(), version.id.clone());
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .pb_5()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(plugin_mark(&version, px(40.), theme))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .item()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .truncate()
                                            .child(version.manifest.name.clone()),
                                    )
                                    .child(
                                        div()
                                            .meta()
                                            .text_color(theme.ink_tertiary)
                                            .child(format!("{} · Version {}", version.slug, version.version)),
                                    ),
                            )
                            .when(reason.is_none(), |row| {
                                row.child(
                                    pill_button(("reject", index), "Reject…", Tone::Quiet, !waiting, theme).on_click(
                                        cx.listener(move |this, _, window, cx| {
                                            let input = cx.new(|cx| {
                                                InputState::new(window, cx).placeholder("What needs to change")
                                            });
                                            input.update(cx, |input, cx| input.focus(window, cx));
                                            this.store.rejection =
                                                Some(Rejection { version_id: reject_id.clone(), reason: input });
                                            cx.notify();
                                        }),
                                    ),
                                )
                                .child(
                                    pill_button(
                                        ("approve", index),
                                        if waiting { "Approving…" } else { "Approve" },
                                        Tone::Primary,
                                        !waiting,
                                        theme,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, window, cx| this.review(approve_id.clone(), None, window, cx),
                                    )),
                                )
                            }),
                    )
                    .child(div().body().text_color(theme.ink_secondary).child(version.manifest.description.clone()))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .children(version.manifest.parts.iter().map(|part| part_card(part, theme))),
                    )
                    .children(reason.map(|reason| {
                        let (input, version_id) = (reason.clone(), version.id.clone());
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                field_box(theme).flex_1().child(Input::new(&reason).appearance(false).bordered(false)),
                            )
                            .child(pill_button(("cancel-reject", index), "Cancel", Tone::Quiet, true, theme).on_click(
                                cx.listener(|this, _, _, cx| {
                                    this.store.rejection = None;
                                    cx.notify();
                                }),
                            ))
                            .child(
                                pill_button(("confirm-reject", index), "Reject", Tone::Danger, !waiting, theme)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        let reason = input.read(cx).value().trim().to_owned();
                                        this.review(version_id.clone(), Some(reason), window, cx)
                                    })),
                            )
                    }))
            }))
            .into_any_element()
    }
}

pub fn back_button(theme: &Theme) -> Stateful<Div> {
    let hover = theme.raised;
    div()
        .id("back")
        .size_8()
        .flex_shrink_0()
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .child(icon("chevron-left", px(20.), theme.ink_secondary))
}

/// A plugin's mark: its initial on its own colour. Marks are the one exception that gets a plate.
fn plugin_mark(version: &PluginVersion, size: Pixels, theme: &Theme) -> Div {
    let initial: String = version
        .manifest
        .name
        .chars()
        .find(|letter| letter.is_alphanumeric())
        .into_iter()
        .flat_map(char::to_uppercase)
        .collect();
    div()
        .size(size)
        .flex_shrink_0()
        .rounded(radius::FIELD)
        .bg(theme.identity_for(&version.slug))
        .flex()
        .items_center()
        .justify_center()
        .text_size(size * 0.45)
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(gpui_kit::white())
        .child(initial)
}

fn part_card(part: &ManifestPart, theme: &Theme) -> Div {
    let (kind, glyph, body, mono) = match part {
        ManifestPart::Skill { instructions, .. } => ("Skill", "sparkles", instructions.clone(), false),
        ManifestPart::Mcp { endpoint, .. } => ("Connector", "plug", endpoint.clone(), true),
        ManifestPart::App { fields, .. } => {
            let labels: Vec<&str> = fields.iter().map(|field| field.label.as_str()).collect();
            ("App", "table", labels.join(" · "), false)
        }
    };
    div()
        .flex()
        .flex_col()
        .gap_1p5()
        .p_3()
        .rounded(radius::CARD)
        .bg(theme.ink_at(0.03))
        .border_1()
        .border_color(theme.hairline.opacity(0.5))
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(icon(glyph, px(14.), theme.ink_secondary))
                .child(div().name().child(part.id().to_owned()))
                .child(div().meta().text_color(theme.ink_tertiary).child(kind)),
        )
        .child(
            div()
                .body()
                .text_color(theme.ink_secondary)
                .when(mono, |body| body.font_family(theme.mono.clone()))
                .when(!mono, |body| body.line_clamp(6))
                .child(body),
        )
}

fn status_label(status: &str, theme: &Theme) -> (&'static str, Hsla) {
    match status {
        "approved" => ("Published", theme.success),
        "rejected" => ("Rejected", theme.danger),
        _ => ("In review", theme.warning),
    }
}

pub fn count(amount: usize, noun: &str) -> String {
    if amount == 1 {
        format!("1 {noun}")
    } else {
        format!("{amount} {noun}s")
    }
}

/// One tab in either of the Store’s section rows.
fn section_tab(label: &'static str) -> Stateful<Div> {
    div().id(label).h_8().px_3p5().flex().items_center().gap_1p5().rounded_full().body().cursor_pointer()
}
