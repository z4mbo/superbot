use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::{self, MarketplaceCatalog, MarketplaceEntry, McpServer, PluginInstall, PluginPart, PluginPreview, ServerState};
use crate::app::Desktop;
use crate::theme::{radius, Theme};
use crate::ui::{empty_line, error_line, icon, pill_button, Tone, Type};

use super::confirm::Confirm;
use super::server_sign_in::Subject;
use super::services::service_mark;
use super::{back_button, count};

/// How many plugins the list shows at first, and adds each time more are asked for.
const PAGE: usize = 30;

/// The plugins this server's registries list, and what is installed from them.
struct Listing {
    catalog: MarketplaceCatalog,
    installs: Vec<PluginInstall>,
    /// Services the Connections tab already lists, so their plugins are not offered twice.
    direct: Vec<String>,
}

/// Where a list of registry plugins shows: connectors under Apps, skill packs under Skills.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Shelf {
    Apps,
    SkillPacks,
}

#[derive(Default)]
pub struct Marketplace {
    listing: Option<Result<Listing, String>>,
    /// How many plugins each shelf shows, Apps first.
    shown: [usize; 2],
    open: Option<OpenPlugin>,
    /// A change to the open plugin is on its way to the server.
    busy: bool,
    problem: Option<String>,
}

impl Marketplace {
    pub fn forget(&mut self) {
        *self = Self::default();
    }

    pub fn is_open(&self) -> bool {
        self.open.is_some()
    }

    pub fn unread(&self) -> bool {
        self.listing.is_none()
    }
}

/// A plugin's page: what its repository holds, read when it opens.
struct OpenPlugin {
    entry: MarketplaceEntry,
    preview: Option<Result<PluginPreview, String>>,
    /// The parts to add, chosen before it is installed.
    chosen: Vec<PluginPart>,
}

impl Listing {
    fn install(&self, entry: &MarketplaceEntry) -> Option<&PluginInstall> {
        self.installs.iter().find(|install| install.installs(entry))
    }

    /// The plugins to offer: not a brand the tab lists elsewhere, unless it is installed here.
    fn offered(&self, shelf: Shelf, query: &str) -> Vec<&MarketplaceEntry> {
        self.catalog
            .entries
            .iter()
            .filter(|entry| entry.has_connector == (shelf == Shelf::Apps))
            .filter(|entry| {
                self.install(entry).is_some() || !self.direct.iter().any(|name| entry.is_brand(name))
            })
            .filter(|entry| {
                query.is_empty()
                    || entry.display_name.to_lowercase().contains(query)
                    || entry.name.contains(query)
                    || entry.description.to_lowercase().contains(query)
            })
            .collect()
    }
}

fn parts_line(entry: &MarketplaceEntry) -> String {
    match (entry.has_connector, entry.skill_count) {
        (true, 0) => "Connector".into(),
        (true, skills) => format!("Connector · {}", count(skills as usize, "skill")),
        (false, skills) => count(skills as usize, "skill"),
    }
}

fn host(endpoint: &str) -> String {
    url::Url::parse(endpoint).ok().and_then(|url| url.host_str().map(str::to_owned)).unwrap_or_else(|| endpoint.into())
}

fn server_line(server: &McpServer, theme: &Theme) -> (&'static str, Hsla) {
    match server.state() {
        ServerState::Connected => ("Connected", theme.success),
        ServerState::NeedsSignIn | ServerState::NotConnected => ("Sign in to use it", theme.warning),
        ServerState::NeedsClient => ("Needs a client ID to sign in", theme.warning),
        ServerState::NotWorking => ("Not working. Sign in again or check it later.", theme.danger),
        ServerState::Disabled => ("Turned off", theme.ink_tertiary),
    }
}

impl Desktop {
    pub(super) fn load_marketplace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let work = async move {
            let (catalog, installs, presets) = tokio::try_join!(
                api.marketplace(&space_id, ""),
                api.plugin_installs(&space_id),
                api.source_presets(&space_id),
            )?;
            let managed = api.connection_catalog(&space_id).await.unwrap_or_default();
            let direct = presets.into_iter().map(|preset| preset.name).chain(managed.into_iter().map(|app| app.name));
            Ok(Listing { catalog, installs, direct: direct.collect() })
        };
        self.call(window, cx, work, |this, result, _, _| {
            let market = &mut this.store.marketplace;
            market.shown = market.shown.map(|shown| shown.max(PAGE));
            market.listing = Some(result.map_err(|error| api::explain(&error)));
        });
    }

    fn open_plugin(&mut self, entry: MarketplaceEntry, window: &mut Window, cx: &mut Context<Self>) {
        let installed = matches!(&self.store.marketplace.listing, Some(Ok(listing)) if listing.install(&entry).is_some());
        self.store.marketplace.problem = None;
        self.store.marketplace.open = Some(OpenPlugin { entry: entry.clone(), preview: None, chosen: Vec::new() });
        if !installed {
            self.preview_plugin(entry, window, cx);
        }
        cx.notify();
    }

    fn preview_plugin(&mut self, entry: MarketplaceEntry, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let source = entry.source.clone();
        let work = async move { api.preview_plugin(&space_id, &source).await };
        self.call(window, cx, work, move |this, result, _, _| {
            let Some(open) = this.store.marketplace.open.as_mut().filter(|open| open.entry.id == entry.id) else { return };
            if let Ok(preview) = &result {
                open.chosen = preview.parts();
            }
            open.preview = Some(result.map_err(|error| api::explain(&error)));
        });
    }

    /// Adds the chosen parts, or changes which parts an installed plugin keeps.
    fn set_parts(&mut self, parts: Vec<PluginPart>, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(open) = self.store.marketplace.open.as_ref() else { return };
        let Some(Ok(listing)) = &self.store.marketplace.listing else { return };
        let installed = listing.install(&open.entry).map(|install| install.id.clone());
        let preview = match (&installed, &open.preview) {
            (None, Some(Ok(preview))) => Some(preview.clone()),
            (None, _) => return,
            (Some(_), _) => None,
        };
        let (name, source) = (open.entry.display_name.clone(), open.entry.source.clone());
        self.store.marketplace.busy = true;
        self.store.marketplace.problem = None;
        let work = async move {
            match (installed, preview) {
                (Some(id), _) => api.set_plugin_parts(&space_id, &id, &parts).await,
                (None, Some(preview)) => api.install_plugin_parts(&space_id, &preview, &source, &parts).await.map(|_| ()),
                (None, None) => Ok(()),
            }
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            this.store.marketplace.busy = false;
            match result {
                Ok(()) => {
                    this.notify(format!("{name} updated."), false, None, cx);
                    this.load_marketplace(window, cx);
                    this.load_presets(window, cx);
                    this.reload_skills(window, cx);
                }
                Err(error) => this.store.marketplace.problem = Some(api::explain(&error)),
            }
        });
        cx.notify();
    }

    pub(super) fn remove_plugin(&mut self, install_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else {
            self.store.settle_confirm();
            return;
        };
        let work = async move { api.set_plugin_parts(&space_id, &install_id, &[]).await };
        self.call(window, cx, work, |this, result, window, cx| {
            this.store.settle_confirm();
            if let Err(error) = result {
                this.notify(api::explain(&error), true, None, cx);
            }
            this.load_marketplace(window, cx);
            this.load_presets(window, cx);
            this.reload_skills(window, cx);
        });
    }

    /// Reads the Space's skills again when they were read, since a plugin adds or removes some.
    fn reload_skills(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.store.skills.is_some() {
            self.load_store_skills(window, cx);
        }
    }

    /// The registries' plugins under the Connections tab's own services.
    pub(super) fn render_marketplace_section(&mut self, shelf: Shelf, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let query = self.store.query.read(cx).value().trim().to_lowercase();
        let heading = div().section().pb_1().child(match shelf {
            Shelf::Apps => "More apps",
            Shelf::SkillPacks => "Skill packs",
        });
        let listing = match &self.store.marketplace.listing {
            None => return Some(div().flex().flex_col().gap_1().child(heading).child(empty_line("Loading…", theme)).into_any_element()),
            Some(Err(problem)) => {
                return Some(
                    div()
                        .flex()
                        .flex_col()
                        .items_start()
                        .gap_3()
                        .child(heading)
                        .child(error_line(problem.clone(), theme))
                        .child(
                            pill_button("marketplace-retry", "Try again", Tone::Quiet, true, theme)
                                .on_click(cx.listener(|this, _, window, cx| this.load_marketplace(window, cx))),
                        )
                        .into_any_element(),
                )
            }
            Some(Ok(listing)) => listing,
        };
        let offered = listing.offered(shelf, &query);
        if offered.is_empty() {
            return None;
        }
        let shown = self.store.marketplace.shown[shelf as usize];
        let more = offered.len() > shown;
        let short = !listing.catalog.unavailable_registries.is_empty();
        let rows: Vec<(MarketplaceEntry, bool)> = offered
            .into_iter()
            .take(shown)
            .map(|entry| (entry.clone(), listing.install(entry).is_some()))
            .collect();
        let rows: Vec<AnyElement> =
            rows.into_iter().map(|(entry, installed)| self.marketplace_row(entry, installed, theme, cx)).collect();
        Some(
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(heading)
                .when(short, |section| {
                    section.child(empty_line("Some lists couldn't be read just now, so a few apps may be missing.", theme).pb_1())
                })
                .children(rows)
                .when(more, |section| {
                    section.child(
                        div().pt_2().flex().child(
                            pill_button(("marketplace-more", shelf as usize), "Show more", Tone::Quiet, true, theme).on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.store.marketplace.shown[shelf as usize] += PAGE;
                                    cx.notify();
                                },
                            )),
                        ),
                    )
                })
                .when(shelf == Shelf::Apps, |section| section.child(
                    div().pt_3().flex().child(
                        pill_button("marketplace-web", "Add an API or a repository on the web", Tone::Quiet, true, theme)
                            .child(icon("external-link", px(13.), theme.ink_secondary))
                            .on_click(cx.listener(|this, _, _, cx| this.open_web_page("/app?integrations", cx))),
                    ),
                ))
                .into_any_element(),
        )
    }

    fn marketplace_row(&mut self, entry: MarketplaceEntry, installed: bool, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let id = SharedString::from(format!("market-{}", entry.id));
        let action = pill_button(
            SharedString::from(format!("market-open-{}", entry.id)),
            if installed { "Manage" } else { "View" },
            Tone::Quiet,
            true,
            theme,
        );
        let hover = theme.raised.opacity(0.4);
        let opened = entry.clone();
        div()
            .id(id)
            .flex()
            .items_center()
            .gap_3()
            .p_2()
            .rounded(radius::CARD)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(move |this, _, window, cx| this.open_plugin(opened.clone(), window, cx)))
            .child(service_mark(&entry.display_name, &entry.name, theme))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .child(div().item().font_weight(FontWeight::SEMIBOLD).truncate().child(entry.display_name.clone()))
                            .when(installed, |row| row.child(icon("check", px(13.), theme.success))),
                    )
                    .child(div().body().text_color(theme.ink_secondary).truncate().child(entry.description.clone())),
            )
            .child(div().meta().text_color(theme.ink_tertiary).child(parts_line(&entry)))
            .child(action)
            .into_any_element()
    }

    pub(super) fn render_marketplace_plugin(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let market = &self.store.marketplace;
        let open = market.open.as_ref().expect("an open plugin");
        let entry = open.entry.clone();
        let listing = match &market.listing {
            Some(Ok(listing)) => Some(listing),
            _ => None,
        };
        let install = listing.and_then(|listing| listing.install(&entry)).cloned();
        let servers: Vec<McpServer> = match (&install, &self.store.presets.sources) {
            (Some(install), Some(Ok(sources))) => sources
                .servers
                .iter()
                .filter(|server| server.install_id.as_deref() == Some(install.id.as_str()))
                .cloned()
                .collect(),
            _ => Vec::new(),
        };
        let busy = market.busy;
        let problem = market.problem.clone();
        let preview = open.preview.clone();
        let chosen = open.chosen.clone();

        let back = back_button(theme).on_click(cx.listener(|this, _, _, cx| {
            this.store.marketplace.open = None;
            cx.notify();
        }));
        let action = match &install {
            Some(install) => {
                let (install_id, name) = (install.id.clone(), entry.display_name.clone());
                pill_button("remove-plugin", "Remove", Tone::Danger, !busy, theme).on_click(cx.listener(move |this, _, _, cx| {
                    this.store.confirm = Some(Confirm::RemovePlugin { install_id: install_id.clone(), name: name.clone() });
                    cx.notify();
                }))
            }
            None => {
                let ready = matches!(&preview, Some(Ok(_))) && !chosen.is_empty();
                let label = if busy { "Adding…" } else { "Add" };
                let parts = chosen.clone();
                pill_button("add-plugin", label, Tone::Primary, ready && !busy, theme)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if !parts.is_empty() {
                            this.set_parts(parts.clone(), window, cx)
                        }
                    }))
            }
        };

        let header = div()
            .flex()
            .items_center()
            .gap_3()
            .child(back)
            .child(service_mark(&entry.display_name, &entry.name, theme).size(px(48.)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().title().truncate().child(entry.display_name.clone()))
                    .child(div().meta().text_color(theme.ink_tertiary).child(parts_line(&entry))),
            )
            .child(action);

        let parts = match (&install, &preview) {
            (Some(install), _) => self.render_installed_parts(install, &servers, busy, theme, cx),
            (None, None) => empty_line("Reading what it adds…", theme).into_any_element(),
            (None, Some(Err(problem))) => {
                let retry = entry.clone();
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap_3()
                    .child(error_line(problem.clone(), theme))
                    .child(pill_button("preview-retry", "Try again", Tone::Quiet, true, theme).on_click(cx.listener(
                        move |this, _, window, cx| {
                            if let Some(open) = this.store.marketplace.open.as_mut() {
                                open.preview = None;
                            }
                            this.preview_plugin(retry.clone(), window, cx)
                        },
                    )))
                    .into_any_element()
            }
            (None, Some(Ok(preview))) => self.render_preview(preview, &chosen, theme, cx),
        };

        div()
            .id("marketplace-plugin")
            .size_full()
            .overflow_y_scroll()
            .pb_8()
            .flex()
            .flex_col()
            .gap_6()
            .child(header)
            .child(div().item().text_color(theme.ink_secondary).child(entry.description.clone()))
            .children(problem.map(|problem| error_line(problem, theme)))
            .child(parts)
            .into_any_element()
    }

    fn render_preview(&mut self, preview: &PluginPreview, chosen: &[PluginPart], theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let available = preview.parts();
        let elsewhere: Vec<String> = preview.elsewhere().map(|skipped| format!("{}: {}", skipped.name, skipped.reason)).collect();
        let toggles = available.iter().map(|part| {
            let on = chosen.contains(part);
            let part = *part;
            part_toggle(part, preview, on, theme).on_click(cx.listener(move |this, _, _, cx| {
                if let Some(open) = this.store.marketplace.open.as_mut() {
                    match open.chosen.iter().position(|chosen| *chosen == part) {
                        Some(index) => {
                            open.chosen.remove(index);
                        }
                        None => open.chosen.push(part),
                    }
                }
                cx.notify();
            }))
        });
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(div().section().child("What it adds"))
            .map(|section| {
                if available.is_empty() {
                    section.child(empty_line("Nothing in this plugin can run on this server.", theme))
                } else {
                    section.child(div().flex().flex_wrap().gap_2().children(toggles))
                }
            })
            .children(preview.mcp_servers.iter().map(|server| {
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(icon("plug", px(14.), theme.ink_secondary))
                    .child(div().name().child(server.name.clone()))
                    .child(div().meta().font_family(theme.mono.clone()).text_color(theme.ink_tertiary).child(host(&server.endpoint)))
            }))
            .when(!preview.skills.is_empty(), |section| {
                let names: Vec<&str> = preview.skills.iter().take(8).map(|skill| skill.name.as_str()).collect();
                let rest = preview.skills.len().saturating_sub(names.len());
                let line = if rest > 0 { format!("{} and {rest} more", names.join(", ")) } else { names.join(", ") };
                section.child(
                    div()
                        .flex()
                        .items_start()
                        .gap_2()
                        .child(icon("sparkles", px(14.), theme.ink_secondary).mt(px(3.)))
                        .child(div().flex_1().min_w_0().body().text_color(theme.ink_secondary).child(line)),
                )
            })
            .when(!elsewhere.is_empty(), |section| {
                section.child(
                    div()
                        .pt_2()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().name().child("Not added here"))
                        .children(elsewhere.into_iter().map(|line| div().body().text_color(theme.ink_tertiary).child(line))),
                )
            })
            .into_any_element()
    }

    fn render_installed_parts(
        &mut self,
        install: &PluginInstall,
        servers: &[McpServer],
        busy: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let parts = install.parts();
        let skills = install.skill_names();
        let rows: Vec<AnyElement> = servers
            .iter()
            .map(|server| {
                let (line, tone) = server_line(server, theme);
                let state = server.state();
                let needs_sign_in = !matches!(state, ServerState::Connected | ServerState::Disabled);
                let key = format!("plugin-server:{}", server.id);
                let signing = self.connection_busy(&key);
                let blocked = self.store.presets.busy.is_some() || self.store.presets.sign_in.is_some();
                let problem = self.connection_problem(&key).map(str::to_owned);
                let form = self.render_connection_form(&key, theme, cx);
                let agents = (state == ServerState::Connected).then(|| self.render_server_agents(&key, server, theme, cx));
                let (name, server_id) = (server.name.clone(), server.id.clone());
                let label = match (signing, state) {
                    (true, _) => "Signing in…",
                    (false, ServerState::NeedsClient) => "Add client ID",
                    (false, _) => "Sign in",
                };
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
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
                            .child(icon("plug", px(14.), theme.ink_secondary))
                            .child(div().flex_1().min_w_0().child(div().name().truncate().child(server.name.clone())).child(
                                div().meta().text_color(tone).child(line),
                            ))
                            .when(needs_sign_in, |row| {
                                row.child(
                                    pill_button(
                                        SharedString::from(format!("plugin-sign-in-{}", server.id)),
                                        label,
                                        Tone::Primary,
                                        !blocked,
                                        theme,
                                    )
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        if state == ServerState::NeedsClient {
                                            let subject = Subject::server(key.clone(), name.clone(), server_id.clone());
                                            this.open_client_form(subject, server_id.clone(), window, cx)
                                        } else {
                                            this.sign_in_server(key.clone(), name.clone(), server_id.clone(), window, cx)
                                        }
                                    })),
                                )
                            }),
                    )
                    .children(problem.map(|problem| error_line(problem, theme)))
                    .children(form)
                    .children(agents)
                    .into_any_element()
            })
            .collect();
        let toggles = [PluginPart::Connector, PluginPart::Skills].into_iter().filter(|part| {
            parts.contains(part) || matches!(part, PluginPart::Connector if !servers.is_empty())
        });
        let toggles: Vec<AnyElement> = toggles
            .map(|part| {
                let on = parts.contains(&part);
                let (kept, install_id, name) = (parts.clone(), install.id.clone(), install.name.clone());
                installed_toggle(part, on, !busy, theme)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let next: Vec<PluginPart> = if on {
                            kept.iter().copied().filter(|kept| *kept != part).collect()
                        } else {
                            kept.iter().copied().chain([part]).collect()
                        };
                        if next.is_empty() {
                            this.store.confirm = Some(Confirm::RemovePlugin { install_id: install_id.clone(), name: name.clone() });
                            cx.notify();
                        } else {
                            this.set_parts(next, window, cx);
                        }
                    }))
                    .into_any_element()
            })
            .collect();
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(div().section().child("What it adds"))
            .child(div().flex().flex_wrap().gap_2().children(toggles))
            .when(parts.contains(&PluginPart::Skills) && !skills.is_empty(), |section| {
                section.child(
                    div()
                        .flex()
                        .items_start()
                        .gap_2()
                        .child(icon("sparkles", px(14.), theme.ink_secondary).mt(px(3.)))
                        .child(div().flex_1().min_w_0().body().text_color(theme.ink_secondary).child(skills.join(", "))),
                )
            })
            .children(rows)
            .into_any_element()
    }
}

fn part_label(part: PluginPart, skills: usize) -> String {
    match part {
        PluginPart::Connector => "Connector".into(),
        PluginPart::Skills if skills > 0 => count(skills, "skill"),
        PluginPart::Skills => "Skills".into(),
    }
}

fn toggle(id: SharedString, label: String, on: bool, enabled: bool, theme: &Theme) -> Stateful<Div> {
    let hover = theme.raised_hover;
    div()
        .id(id)
        .h_8()
        .px_3()
        .flex()
        .items_center()
        .gap_1p5()
        .rounded_full()
        .body()
        .when(enabled, |toggle| toggle.cursor_pointer())
        .when(!enabled, |toggle| toggle.opacity(0.5))
        .map(|toggle| {
            if on {
                toggle.bg(theme.ink).text_color(theme.app).font_weight(FontWeight::MEDIUM).child(icon("check", px(13.), theme.app))
            } else {
                toggle.bg(theme.control.opacity(0.7)).text_color(theme.ink_secondary).hover(move |style| style.bg(hover))
            }
        })
        .child(label)
}

fn part_toggle(part: PluginPart, preview: &PluginPreview, on: bool, theme: &Theme) -> Stateful<Div> {
    let id = SharedString::from(format!("choose-{part:?}"));
    toggle(id, part_label(part, preview.skills.len()), on, true, theme)
}

fn installed_toggle(part: PluginPart, on: bool, enabled: bool, theme: &Theme) -> Stateful<Div> {
    let id = SharedString::from(format!("keep-{part:?}"));
    toggle(id, part_label(part, 0), on, enabled, theme)
}

#[cfg(test)]
mod tests {
    use super::host;

    #[test]
    fn an_endpoint_shows_as_its_host() {
        assert_eq!(host("https://mcp.example.com/v1/sse"), "mcp.example.com");
        assert_eq!(host("not a url"), "not a url");
    }
}
