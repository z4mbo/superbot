use std::collections::{BTreeMap, HashMap};

use superbot_features::{
    ComputerProviderScope, ComputerProviderSettings, ProviderField, ProviderFieldKind, DEFAULT_COMPUTER_PROVIDER,
};

use super::*;

/// Where computers run, as this account may see and change it: the deployment's choice for an
/// administrator, otherwise this account's own. `None` while unread or when the read failed,
/// which hides the row.
pub(super) struct Providers {
    scope: ComputerProviderScope,
    settings: ComputerProviderSettings,
}

impl Providers {
    /// What the Computer tab's row says: the chosen provider's own name, or the server's default.
    pub(super) fn label(&self) -> String {
        self.settings
            .option(&self.settings.provider)
            .map(|option| option.display_name.clone())
            .unwrap_or_else(|| "Default".to_owned())
    }
}

/// The page that chooses where computers run, and the chosen provider's settings.
pub(super) struct ProviderPage {
    chosen: String,
    inputs: HashMap<String, Entity<InputState>>,
    picks: BTreeMap<String, String>,
    advanced: bool,
    saving: bool,
    problem: Option<String>,
}

impl ProviderPage {
    fn new(
        settings: &ComputerProviderSettings,
        chosen: String,
        window: &mut Window,
        cx: &mut Context<Desktop>,
    ) -> Self {
        let mut page = Self {
            chosen: String::new(),
            inputs: HashMap::new(),
            picks: BTreeMap::new(),
            advanced: false,
            saving: false,
            problem: None,
        };
        page.choose(settings, chosen, window, cx);
        page
    }

    /// Picks a provider, filled with what is saved for it when it is the one already in use.
    fn choose(
        &mut self,
        settings: &ComputerProviderSettings,
        chosen: String,
        window: &mut Window,
        cx: &mut Context<Desktop>,
    ) {
        let current = chosen == settings.provider;
        self.inputs.clear();
        self.picks.clear();
        self.problem = None;
        for field in settings.option(&chosen).map(|option| option.fields.as_slice()).unwrap_or_default() {
            let saved = current.then(|| settings.values.get(&field.key).cloned()).flatten().unwrap_or_default();
            match field.kind {
                ProviderFieldKind::Select | ProviderFieldKind::Toggle => {
                    self.picks.insert(field.key.clone(), saved);
                }
                kind => {
                    let secret_saved = current
                        && kind == ProviderFieldKind::Secret
                        && settings.saved_secrets.get(&field.key) == Some(&true);
                    let hint = if secret_saved { Some("Saved".to_owned()) } else { field.placeholder.clone() };
                    let input = cx.new(|cx| {
                        let state =
                            InputState::new(window, cx).masked(kind == ProviderFieldKind::Secret).default_value(saved);
                        match hint {
                            Some(hint) => state.placeholder(hint),
                            None => state,
                        }
                    });
                    self.inputs.insert(field.key.clone(), input);
                }
            }
        }
        self.chosen = chosen;
    }

    fn values(&self, cx: &App) -> BTreeMap<String, String> {
        let mut values: BTreeMap<String, String> =
            self.inputs.iter().map(|(key, input)| (key.clone(), input.read(cx).value().trim().to_owned())).collect();
        values.extend(
            self.picks.iter().filter(|(_, value)| !value.is_empty()).map(|(key, value)| (key.clone(), value.clone())),
        );
        values
    }
}

/// The providers a person can see for this computer: none on a computer that is their own
/// machine, and none where this server runs no computers.
pub(super) fn has_providers(status: &ComputerStatus) -> bool {
    status.offered() && !status.runs_on_user_machine
}

impl Desktop {
    /// Reads where computers run once the Computer tab shows a computer that can run elsewhere.
    /// An administrator sees the deployment's choice; anyone else, their own account's.
    pub(super) fn sync_computer_providers(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let Some(panel) = self.agent_panel.as_mut() else { return };
        let wanted = panel.tab == PanelTab::Computer
            && matches!(&panel.computer, Some(ComputerView::Ready(status)) if has_providers(status));
        if !wanted || panel.providers_read {
            return;
        }
        panel.providers_read = true;
        let agent = panel.agent_id.clone();
        let work = async move {
            let space = features.space(space);
            match space.computer_provider_settings(ComputerProviderScope::Deployment).await {
                Ok(settings) if settings.choosable() => Ok((ComputerProviderScope::Deployment, settings)),
                Ok(_) | Err(Error::Server { status: 403, .. }) => space
                    .computer_provider_settings(ComputerProviderScope::Account)
                    .await
                    .map(|settings| (ComputerProviderScope::Account, settings)),
                Err(error) => Err(error),
            }
        };
        self.call(window, cx, work, move |this, result, _, _| {
            let Some(panel) = this.agent_panel.as_mut().filter(|panel| panel.agent_id == agent) else { return };
            panel.providers = result
                .ok()
                .filter(|(_, settings)| settings.choosable())
                .map(|(scope, settings)| Providers { scope, settings });
        });
    }

    pub(super) fn open_provider_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(providers) = self.agent_panel.as_ref().and_then(|panel| panel.providers.as_ref()) else { return };
        let settings = providers.settings.clone();
        let page = ProviderPage::new(&settings, settings.provider.clone(), window, cx);
        self.open_library_page(knowledge::Page::Provider(page), window, cx);
    }

    fn with_provider_page(&mut self, change: impl FnOnce(&mut ProviderPage, &ComputerProviderSettings)) {
        let Some(panel) = self.agent_panel.as_mut() else { return };
        let (Some(providers), Some(knowledge::Page::Provider(page))) = (panel.providers.as_ref(), panel.page.as_mut())
        else {
            return;
        };
        change(page, &providers.settings);
    }

    fn choose_provider(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.agent_panel.as_mut() else { return };
        let (Some(providers), Some(knowledge::Page::Provider(page))) = (panel.providers.as_ref(), panel.page.as_mut())
        else {
            return;
        };
        if page.saving || page.chosen == id {
            return;
        }
        page.choose(&providers.settings, id, window, cx);
        cx.notify();
    }

    fn save_provider(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let Some(panel) = self.agent_panel.as_mut() else { return };
        let (Some(providers), Some(knowledge::Page::Provider(page))) = (panel.providers.as_ref(), panel.page.as_mut())
        else {
            return;
        };
        if page.saving {
            return;
        }
        page.saving = true;
        page.problem = None;
        let scope = providers.scope;
        let chosen = page.chosen.clone();
        let values = if chosen == DEFAULT_COMPUTER_PROVIDER { BTreeMap::new() } else { page.values(cx) };
        let agent = panel.agent_id.clone();
        let work = async move { features.space(space).save_computer_provider(scope, &chosen, &values).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            let Some(panel) = this.agent_panel.as_mut().filter(|panel| panel.agent_id == agent) else { return };
            let page = match panel.page.as_mut() {
                Some(knowledge::Page::Provider(page)) => Some(page),
                _ => None,
            };
            let settings = match result {
                Ok(settings) => settings,
                Err(error) => {
                    if let Some(page) = page {
                        page.saving = false;
                        page.problem = Some(api::explain(&error));
                    }
                    return;
                }
            };
            if let Some(page) = page {
                page.saving = false;
                page.choose(&settings, settings.provider.clone(), window, cx);
            }
            panel.providers = Some(Providers { scope, settings });
            this.notify("Saved", false, None, cx);
        });
        cx.notify();
    }

    /// The Computer tab's row that opens the provider page, once there is a choice to make.
    pub(super) fn render_provider_row(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<Stateful<Div>> {
        let providers = self.agent_panel.as_ref()?.providers.as_ref()?;
        let title = match providers.scope {
            ComputerProviderScope::Deployment => "Computers run on",
            ComputerProviderScope::Account => "Your computers run on",
        };
        Some(
            knowledge::nav_row("agent-computer-provider", "server", title, Some(providers.label()), theme)
                .border_t_1()
                .border_color(theme.ink_at(0.05))
                .on_click(cx.listener(|this, _, window, cx| this.open_provider_page(window, cx))),
        )
    }

    pub(super) fn render_provider_page(&self, page: &ProviderPage, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let Some(providers) = self.agent_panel.as_ref().and_then(|panel| panel.providers.as_ref()) else {
            return div();
        };
        let settings = &providers.settings;
        let hover = theme.ink_at(0.03);
        let choice = |id: String, name: String, hint: Option<&'static str>, index: usize, cx: &mut Context<Self>| {
            let chosen = page.chosen == id;
            let pick = id.clone();
            knowledge::divided(
                div()
                    .id(SharedString::from(format!("provider-{index}")))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .min_h(px(46.))
                    .px(px(14.))
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(move |this, _, window, cx| this.choose_provider(pick.clone(), window, cx)))
                    .child(radio(chosen, theme))
                    .child(div().flex_1().min_w_0().name().text_color(theme.ink).truncate().child(name))
                    .children(hint.map(|hint| div().body().text_color(theme.ink_tertiary).child(hint))),
                index,
                theme,
            )
        };
        let mut rows =
            vec![choice(DEFAULT_COMPUTER_PROVIDER.to_owned(), "Default".to_owned(), Some("Set by this server"), 0, cx)];
        for (index, option) in settings.providers.iter().enumerate() {
            rows.push(choice(option.id.clone(), option.display_name.clone(), None, index + 1, cx));
        }
        let fields: Vec<&ProviderField> =
            settings.option(&page.chosen).map(|option| option.fields.iter().collect()).unwrap_or_default();
        let has_advanced = fields.iter().any(|field| field.advanced);
        let shown: Vec<&ProviderField> = fields.into_iter().filter(|field| !field.advanced || page.advanced).collect();
        let ink = theme.ink;
        let form = (!shown.is_empty() || has_advanced).then(|| {
            knowledge::page_card(theme)
                .p(px(14.))
                .gap_3()
                .children(shown.into_iter().map(|field| self.render_provider_field(page, field, theme, cx)))
                .when(has_advanced && !page.advanced, |form| {
                    form.child(
                        div()
                            .id("provider-advanced")
                            .self_start()
                            .body()
                            .text_color(theme.ink_secondary)
                            .cursor_pointer()
                            .hover(move |style| style.text_color(ink))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.with_provider_page(|page, _| page.advanced = true);
                                cx.notify();
                            }))
                            .child("More settings"),
                    )
                })
        });
        let unchanged = page.chosen == settings.provider && page.chosen == DEFAULT_COMPUTER_PROVIDER;
        div()
            .flex()
            .flex_col()
            .child(knowledge::page_card(theme).children(rows))
            .children(form)
            .children(page.problem.clone().map(|problem| div().mt_3().px_1().child(error_line(problem, theme))))
            .child(
                div()
                    .mt(px(14.))
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(
                        crate::ui::pill_button(
                            "provider-save",
                            if page.saving { "Saving…" } else { "Save" },
                            crate::ui::Tone::Primary,
                            !page.saving && !unchanged,
                            theme,
                        )
                        .on_click(cx.listener(|this, _, window, cx| this.save_provider(window, cx))),
                    )
                    .child(
                        div()
                            .flex_1()
                            .meta()
                            .text_color(theme.ink_tertiary)
                            .child("Running computers move the next time they start."),
                    ),
            )
    }

    fn render_provider_field(
        &self,
        page: &ProviderPage,
        field: &ProviderField,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let label = div().body().font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(field.label.clone());
        let description = field.description.clone().map(|text| div().meta().text_color(theme.ink_tertiary).child(text));
        let control = match field.kind {
            ProviderFieldKind::Select => {
                let current = page.picks.get(&field.key).cloned().unwrap_or_default();
                let mut options: Vec<(String, String)> =
                    field.options.iter().map(|option| (option.value.clone(), option.label.clone())).collect();
                if !field.required {
                    options.insert(0, (String::new(), "Default".to_owned()));
                }
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1p5()
                    .children(options.into_iter().enumerate().map(|(index, (value, label))| {
                        let key = field.key.clone();
                        option_chip(
                            SharedString::from(format!("provider-{}-{index}", field.key)),
                            label,
                            value == current,
                            theme,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let (key, value) = (key.clone(), value.clone());
                            this.with_provider_page(move |page, _| {
                                page.picks.insert(key, value);
                            });
                            cx.notify();
                        }))
                    }))
                    .into_any_element()
            }
            ProviderFieldKind::Toggle => {
                let on = page.picks.get(&field.key).map(String::as_str) == Some("true");
                let key = field.key.clone();
                div()
                    .id(SharedString::from(format!("provider-{}", field.key)))
                    .self_start()
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let key = key.clone();
                        this.with_provider_page(move |page, _| {
                            page.picks.insert(key, if on { "false" } else { "true" }.to_owned());
                        });
                        cx.notify();
                    }))
                    .child(switch(on, theme.ink, theme))
                    .into_any_element()
            }
            _ => match page.inputs.get(&field.key) {
                Some(input) => crate::ui::field_box(theme)
                    .child(Input::new(input).appearance(false).bordered(false))
                    .into_any_element(),
                None => div().into_any_element(),
            },
        };
        div().flex().flex_col().gap_1p5().child(label).child(control).children(description).into_any_element()
    }
}

fn radio(on: bool, theme: &Theme) -> Div {
    div()
        .size(px(18.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .border_1()
        .border_color(if on { theme.ink } else { theme.ink_at(0.25) })
        .when(on, |ring| ring.child(div().size(px(8.)).rounded_full().bg(theme.ink)))
}

fn option_chip(id: SharedString, label: String, on: bool, theme: &Theme) -> Stateful<Div> {
    let hover = theme.raised_hover;
    div()
        .id(id)
        .h_7()
        .px_3()
        .flex()
        .items_center()
        .rounded_full()
        .body()
        .cursor_pointer()
        .map(|chip| {
            if on {
                chip.bg(theme.ink).text_color(theme.app)
            } else {
                chip.bg(theme.control).text_color(theme.ink).hover(move |style| style.bg(hover))
            }
        })
        .child(label)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use superbot_features::ComputerStatus;

    use super::has_providers;

    #[test]
    fn a_computer_on_this_machine_or_none_at_all_has_nowhere_else_to_run() {
        let status = |fields: serde_json::Value| -> ComputerStatus {
            let mut base = json!({
                "botId": "bot-1", "mode": "team", "kind": "server", "state": "stopped",
                "controlHolder": "none", "takeoverRequested": false, "screenAvailable": false,
                "busyBotName": null
            });
            base.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
            serde_json::from_value(base).unwrap()
        };
        assert!(has_providers(&status(json!({}))));
        assert!(!has_providers(&status(json!({ "kind": "none" }))));
        assert!(!has_providers(&status(json!({ "runsOnUserMachine": true }))));
    }
}
