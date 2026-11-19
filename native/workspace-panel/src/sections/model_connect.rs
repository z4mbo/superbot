use gpui_kit::component::input::InputState;
use gpui_kit::prelude::*;
use gpui_kit::{div, App, Div, Entity, SharedString, Window};
use superbot_features::{
    model_providers, ApiProtocol, ConnectMethod, ConnectModel, EndpointPreset, ModelProvider,
    Patch, ProbeServer, RoutingField,
};

use crate::icons::{icon, Glyph};
use crate::panel::{detail_header, WorkspacePanel};
use crate::sections::models::{glyph_plate, Page};
use crate::theme::Tokens;
use crate::ui::{self, Action, Row, Toggle, Tone};

/// Models shown before **Show all**.
const SHORT_LIST: usize = 6;
/// Providers listed before a filter field is worth its space.
const FILTER_FROM: usize = 8;
/// The server keeps at most 500 models per connection, the main one included.
const MAX_OTHER_MODELS: usize = 499;

const PROTOCOLS: [(ApiProtocol, &str); 3] = [
    (ApiProtocol::ChatCompletions, "Chat Completions"),
    (ApiProtocol::Responses, "Responses"),
    (ApiProtocol::AnthropicMessages, "Messages"),
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Busy {
    Find,
    Check,
    Connect,
}

/// One provider's connection form. The key lives only in its masked field
/// until it is sent, and the field is emptied whenever a form opens or saves.
pub(crate) struct ConnectForm {
    filter: Entity<InputState>,
    address: Entity<InputState>,
    key: Entity<InputState>,
    model_name: Entity<InputState>,
    account: Entity<InputState>,
    gateway: Entity<InputState>,
    project: Entity<InputState>,
    region: Entity<InputState>,
    /// The models a server listed, with the address that listed them.
    found: Option<(String, Vec<String>)>,
    chosen: Option<String>,
    show_all: bool,
    protocol: ApiProtocol,
    protocol_open: bool,
    make_main: bool,
    busy: Option<Busy>,
    problem: Option<SharedString>,
    notice: Option<SharedString>,
}

impl ConnectForm {
    pub(crate) fn new(window: &mut Window, cx: &mut App) -> Self {
        let masked = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder("Paste the key")
        });
        Self {
            filter: ui::new_input("Filter providers", window, cx),
            address: ui::new_input("http://localhost:8080/v1", window, cx),
            key: masked,
            model_name: ui::new_input("The model's name on the server", window, cx),
            account: ui::new_input("Account ID", window, cx),
            gateway: ui::new_input("Gateway ID", window, cx),
            project: ui::new_input("Project ID", window, cx),
            region: ui::new_input("global", window, cx),
            found: None,
            chosen: None,
            show_all: false,
            protocol: ApiProtocol::default(),
            protocol_open: false,
            make_main: true,
            busy: None,
            problem: None,
            notice: None,
        }
    }

    pub(crate) fn leave(&mut self) {
        self.found = None;
        self.chosen = None;
        self.show_all = false;
        self.protocol = ApiProtocol::default();
        self.protocol_open = false;
        self.busy = None;
        self.problem = None;
        self.notice = None;
    }

    pub(crate) fn clear_filter(&self, window: &mut Window, cx: &mut App) {
        ui::set_input(&self.filter, "", window, cx);
    }

    fn text(&self, field: &Entity<InputState>, cx: &App) -> String {
        field.read(cx).value().trim().to_owned()
    }

    /// The server's listed models, while they belong to the address typed now.
    fn listed(&self, cx: &App) -> Option<&[String]> {
        let address = self.text(&self.address, cx);
        self.found
            .as_ref()
            .filter(|(listed_for, models)| *listed_for == address && !models.is_empty())
            .map(|(_, models)| models.as_slice())
    }

    fn server_model(&self, cx: &App) -> String {
        match (self.listed(cx), &self.chosen) {
            (Some(models), Some(chosen)) if models.contains(chosen) => chosen.clone(),
            _ => self.text(&self.model_name, cx),
        }
    }

    fn routing_input(&self, field: RoutingField) -> Option<&Entity<InputState>> {
        match field {
            RoutingField::AccountId => Some(&self.account),
            RoutingField::GatewayId => Some(&self.gateway),
            RoutingField::ProjectId => Some(&self.project),
            RoutingField::Region => Some(&self.region),
            RoutingField::Unknown => None,
        }
    }
}

/// The routing ids a form asks for: a project always comes with its region.
fn routing_fields(provider: &ModelProvider) -> Vec<RoutingField> {
    let mut fields = provider.routing_fields.clone();
    if fields.contains(&RoutingField::ProjectId) && !fields.contains(&RoutingField::Region) {
        fields.push(RoutingField::Region);
    }
    fields
}

fn routing_label(field: RoutingField) -> &'static str {
    match field {
        RoutingField::AccountId => "Account ID",
        RoutingField::GatewayId => "Gateway ID",
        RoutingField::ProjectId => "Project ID",
        RoutingField::Region => "Region",
        RoutingField::Unknown => "",
    }
}

/// Routing ids go into a URL path, so the server takes one plain segment.
fn routing_id_ok(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn found_sentence(count: usize) -> String {
    match count {
        0 => "The server answered but listed no models. Enter one by name.".to_owned(),
        1 => "Found 1 model.".to_owned(),
        count => format!("Found {count} models."),
    }
}

impl WorkspacePanel {
    fn provider(&self, id: &str) -> Option<ModelProvider> {
        model_providers(self.models.catalog.value.as_deref()?)
            .into_iter()
            .find(|provider| provider.id == id)
    }

    fn open_provider(
        &mut self,
        provider: &ModelProvider,
        preset: Option<&EndpointPreset>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let make_main = self
            .models
            .main
            .value
            .as_ref()
            .is_none_or(|main| main.primary.is_none());
        let form = &mut self.models.form;
        form.leave();
        form.make_main = make_main;
        form.chosen = provider.models.first().map(|model| model.id.clone());
        let address = preset.map_or("", |preset| preset.base_url.as_str());
        ui::set_input(&form.address, address, window, cx);
        for field in [
            &form.key,
            &form.model_name,
            &form.account,
            &form.gateway,
            &form.project,
        ] {
            ui::set_input(field, "", window, cx);
        }
        ui::set_input(&form.region, "global", window, cx);
        self.models.page = Page::Connect {
            provider: provider.id.clone(),
            preset: preset.map(|preset| preset.name.clone()),
        };
        let first = match provider.method {
            ConnectMethod::Server if preset.is_none() => Some(&form.address),
            ConnectMethod::Server | ConnectMethod::Key => Some(&form.key),
            ConnectMethod::SignIn => None,
        };
        if let Some(first) = first {
            first.update(cx, |field, cx| field.focus(window, cx));
        }
        cx.notify();
    }

    fn leave_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        ui::set_input(&self.models.form.key, "", window, cx);
        self.models.form.leave();
        self.models.page = Page::Providers;
        cx.notify();
    }

    fn find_models(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let form = &mut self.models.form;
        let address = form.text(&form.address, cx);
        if address.is_empty() || form.busy.is_some() {
            return;
        }
        let key = form.text(&form.key, cx);
        let protocol = form.protocol;
        form.busy = Some(Busy::Find);
        form.problem = None;
        form.notice = None;
        let remote = self.remote.clone();
        let asked = address.clone();
        self.request(
            window,
            cx,
            async move {
                let probe = ProbeServer {
                    base_url: &asked,
                    api_key: (!key.is_empty()).then_some(key.as_str()),
                    api_protocol: Some(protocol),
                    credential_id: None,
                };
                remote.space().probe_server_models(&probe).await
            },
            move |panel, models, _, _| {
                let form = &mut panel.models.form;
                form.busy = None;
                match models {
                    Ok(models) => {
                        form.notice = Some(found_sentence(models.len()).into());
                        if !form
                            .chosen
                            .as_ref()
                            .is_some_and(|chosen| models.contains(chosen))
                        {
                            form.chosen = models.first().cloned();
                        }
                        form.found = Some((address, models));
                    }
                    Err(failure) => {
                        form.found = None;
                        form.problem = Some(failure.sentence("list that server's models").into());
                    }
                }
            },
        );
    }

    fn check_key(&mut self, provider: &str, window: &mut Window, cx: &mut Context<Self>) {
        let form = &mut self.models.form;
        let key = form.text(&form.key, cx);
        if key.len() < 8 || form.busy.is_some() {
            return;
        }
        form.busy = Some(Busy::Check);
        form.problem = None;
        form.notice = None;
        let remote = self.remote.clone();
        let provider = provider.to_owned();
        self.request(
            window,
            cx,
            async move { remote.space().probe_provider_models(&provider, &key).await },
            |panel, models, _, _| {
                let form = &mut panel.models.form;
                form.busy = None;
                match models {
                    Ok(_) => form.notice = Some("The key works.".into()),
                    Err(failure) => form.problem = Some(failure.sentence("check the key").into()),
                }
            },
        );
    }

    /// Whether everything a save needs is filled in.
    fn connect_ready(&self, provider: &ModelProvider, preset: bool, cx: &App) -> bool {
        let form = &self.models.form;
        let key = form.text(&form.key, cx);
        match provider.method {
            ConnectMethod::Server => {
                !form.text(&form.address, cx).is_empty()
                    && !form.server_model(cx).is_empty()
                    && (!preset || !key.is_empty())
            }
            ConnectMethod::Key => {
                key.len() >= 8
                    && form.chosen.is_some()
                    && provider.native()
                    && routing_fields(provider).into_iter().all(|field| {
                        form.routing_input(field)
                            .is_some_and(|input| routing_id_ok(&form.text(input, cx)))
                    })
            }
            ConnectMethod::SignIn => false,
        }
    }

    fn connect(
        &mut self,
        provider: ModelProvider,
        preset: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.models.form.busy.is_some() || !self.connect_ready(&provider, preset.is_some(), cx) {
            return;
        }
        let form = &mut self.models.form;
        let key = form.text(&form.key, cx);
        let server = provider.method == ConnectMethod::Server;
        let address = form.text(&form.address, cx);
        let model_id = if server {
            form.server_model(cx)
        } else {
            form.chosen.clone().unwrap_or_default()
        };
        let routing: Vec<(RoutingField, String)> = routing_fields(&provider)
            .into_iter()
            .filter_map(|field| Some((field, form.text(form.routing_input(field)?, cx))))
            .collect();
        let others: Vec<String> = match (server, form.listed(cx)) {
            (true, Some(models)) => models
                .iter()
                .filter(|model| **model != model_id)
                .take(MAX_OTHER_MODELS)
                .cloned()
                .collect(),
            _ => Vec::new(),
        };
        let protocol = form.protocol;
        let make_main = form.make_main;
        let label = preset.clone().unwrap_or_else(|| provider.name.clone());
        form.busy = Some(Busy::Connect);
        form.problem = None;
        form.notice = None;
        let model_name = provider
            .models
            .iter()
            .find(|model| model.id == model_id)
            .map_or_else(|| model_id.clone(), |model| model.label.clone());
        let remote = self.remote.clone();
        let provider_id = provider.id.clone();
        let saved_label = label.clone();
        self.request(
            window,
            cx,
            async move {
                let routed = |wanted: RoutingField| {
                    routing
                        .iter()
                        .find(|(field, _)| *field == wanted)
                        .map(|(_, value)| value.as_str())
                };
                let others: Vec<&str> = others.iter().map(String::as_str).collect();
                let input = ConnectModel {
                    provider: &provider_id,
                    api_key: (!key.is_empty()).then_some(key.as_str()),
                    base_url: server.then_some(address.as_str()),
                    api_protocol: server.then_some(protocol),
                    model_id: Some(&model_id),
                    label: Some(&saved_label),
                    account_id: routed(RoutingField::AccountId),
                    gateway_id: routed(RoutingField::GatewayId),
                    project_id: routed(RoutingField::ProjectId),
                    region: routed(RoutingField::Region),
                    credential_id: Patch::Clear,
                    enabled_model_ids: (!others.is_empty()).then_some(others.as_slice()),
                    make_default: Some(make_main),
                };
                remote.space().connect_model(&input).await
            },
            move |panel, saved, window, cx| {
                panel.models.form.busy = None;
                match saved {
                    Ok(_) => {
                        ui::set_input(&panel.models.form.key, "", window, cx);
                        panel.models.close();
                        let message = if make_main {
                            format!("{label} is connected. Agents use {model_name} now.")
                        } else {
                            format!("{label} is connected.")
                        };
                        panel.toast(message, None, cx);
                        panel.load_models(window, cx);
                    }
                    Err(failure) => {
                        panel.models.form.problem =
                            Some(failure.sentence(&format!("connect {label}")).into());
                    }
                }
            },
        );
    }

    pub(crate) fn render_providers(
        &self,
        t: &Tokens,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let Some(catalog) = self.models.catalog.value.as_deref() else {
            return ui::loading_line(t);
        };
        let providers = model_providers(catalog);
        if providers.is_empty() {
            return ui::notice("This server doesn't offer any model providers.", None, t);
        }
        let form = &self.models.form;
        let query = form.text(&form.filter, cx).to_lowercase();
        let shown = |name: &str| query.is_empty() || name.to_lowercase().contains(&query);
        let mut rows: Vec<Row> = Vec::new();
        for provider in &providers {
            if shown(&provider.name) {
                rows.push(self.provider_row(provider, None, t, cx));
            }
            for preset in &provider.endpoint_presets {
                if shown(&preset.name) {
                    rows.push(self.provider_row(provider, Some(preset), t, cx));
                }
            }
        }
        div()
            .flex()
            .flex_col()
            .gap_2()
            .when(providers.len() >= FILTER_FROM, |this| {
                this.child(ui::text_field(
                    &form.filter,
                    "Filter providers",
                    false,
                    window,
                    cx,
                ))
            })
            .child(div().flex().flex_col().children(rows))
    }

    fn provider_row(
        &self,
        provider: &ModelProvider,
        preset: Option<&EndpointPreset>,
        t: &Tokens,
        cx: &mut Context<Self>,
    ) -> Row {
        let (name, detail, glyph) = match (provider.method, preset) {
            (_, Some(preset)) => (
                preset.name.clone(),
                "Hosted, with an API key",
                Glyph::Server,
            ),
            (ConnectMethod::Server, None) => (
                provider.name.clone(),
                "Your own server, such as one on this computer",
                Glyph::Server,
            ),
            (ConnectMethod::Key, None) if !provider.native() => (
                provider.name.clone(),
                "Finished in the browser",
                Glyph::KeyRound,
            ),
            (ConnectMethod::Key, None) if provider.sign_in => (
                provider.name.clone(),
                "API key or account sign-in",
                Glyph::KeyRound,
            ),
            (ConnectMethod::Key, None) => (provider.name.clone(), "API key", Glyph::KeyRound),
            (ConnectMethod::SignIn, None) => (
                provider.name.clone(),
                "Account sign-in, in the browser",
                Glyph::KeyRound,
            ),
        };
        let id = SharedString::from(match preset {
            Some(preset) => format!("provider-{}-{}", provider.id, preset.name),
            None => format!("provider-{}", provider.id),
        });
        let native = provider.native() || preset.is_some();
        let opened = provider.clone();
        let preset = preset.cloned();
        Row::new(id, name)
            .leading(glyph_plate(glyph, t))
            .detail(detail)
            .trailing(icon(
                if native {
                    Glyph::ChevronRight
                } else {
                    Glyph::ExternalLink
                },
                16.,
                t.ink_tertiary,
            ))
            .on_click(cx.listener(move |panel, _, window, cx| {
                if opened.method == ConnectMethod::Key && !opened.native() {
                    panel.open_web_models(cx);
                } else {
                    panel.open_provider(&opened, preset.as_ref(), window, cx);
                }
            }))
    }

    pub(crate) fn render_connect(
        &mut self,
        provider_id: &str,
        preset: Option<&str>,
        t: &Tokens,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let back = Action::icon("connect-back", Glyph::ChevronLeft, "Back")
            .on_click(cx.listener(|panel, _, window, cx| panel.leave_form(window, cx)));
        let Some(provider) = self.provider(provider_id) else {
            return div()
                .flex()
                .flex_col()
                .child(detail_header("Connect a model", back, [], t))
                .child(ui::notice("This provider is no longer offered.", None, t));
        };
        let title = preset.map_or_else(|| provider.name.clone(), str::to_owned);
        let header = detail_header(title, back, [], t);
        let body = match provider.method {
            ConnectMethod::SignIn => {
                return div()
                    .flex()
                    .flex_col()
                    .child(header)
                    .child(self.render_sign_in(&provider, t, cx))
            }
            ConnectMethod::Server => self.render_server_fields(preset.is_some(), t, window, cx),
            ConnectMethod::Key => self.render_key_fields(&provider, t, window, cx),
        };
        let form = &self.models.form;
        let has_main = self
            .models
            .main
            .value
            .as_ref()
            .is_some_and(|main| main.primary.is_some());
        let ready = self.connect_ready(&provider, preset.is_some(), cx);
        let preset = preset.map(str::to_owned);
        let footer = div()
            .flex()
            .flex_col()
            .gap_3()
            .when(has_main, |this| {
                this.child(ui::setting_row(
                    "Make it the main model",
                    None,
                    Toggle::new("make-main", "Make it the main model", form.make_main).on_change(
                        cx.listener(|panel, on: &bool, _, cx| {
                            panel.models.form.make_main = *on;
                            cx.notify();
                        }),
                    ),
                    t,
                ))
            })
            .when_some(form.problem.clone(), |this, problem| {
                this.child(ui::problem_line(problem, t))
            })
            .child(
                div().flex().child(
                    Action::new("connect", "Connect")
                        .tone(Tone::Primary)
                        .disabled(!ready)
                        .busy(form.busy == Some(Busy::Connect))
                        .on_click(cx.listener(move |panel, _, window, cx| {
                            panel.connect(provider.clone(), preset.clone(), window, cx)
                        })),
                ),
            );
        div()
            .flex()
            .flex_col()
            .gap_5()
            .child(header.pb_0())
            .child(body)
            .child(footer)
    }

    fn render_sign_in(&self, provider: &ModelProvider, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let label = provider
            .sign_in_label
            .clone()
            .unwrap_or_else(|| "Continue in the browser".to_owned());
        ui::card(t)
            .child(ui::body(
                format!("{} connects with an account sign-in, which finishes in the browser. This list updates when you come back.", provider.name),
                t.ink_secondary,
            ))
            .child(
                div().flex().child(
                    Action::new("continue-in-browser", label)
                        .tone(Tone::Primary)
                        .glyph(Glyph::ExternalLink)
                        .on_click(cx.listener(|panel, _, _, cx| panel.open_web_models(cx))),
                ),
            )
    }

    fn render_server_fields(
        &self,
        preset: bool,
        t: &Tokens,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let form = &self.models.form;
        let address_typed = !form.text(&form.address, cx).is_empty();
        let connection = ui::card(t)
            .child(ui::labelled(
                "Server address",
                ui::text_field(&form.address, "Server address", false, window, cx),
                None,
                cx,
            ))
            .child(ui::labelled(
                if preset {
                    "API key"
                } else {
                    "API key, if the server needs one"
                },
                ui::text_field(&form.key, "API key", false, window, cx),
                None,
                cx,
            ))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_3()
                    .child(
                        Action::new("find-models", "Find models")
                            .disabled(!address_typed)
                            .busy(form.busy == Some(Busy::Find))
                            .on_click(
                                cx.listener(|panel, _, window, cx| panel.find_models(window, cx)),
                            ),
                    )
                    .when_some(form.notice.clone(), |this, notice| {
                        this.child(ui::body(notice, t.ink_secondary))
                    }),
            );
        let model = match form.listed(cx) {
            Some(models) => {
                let chosen = form.chosen.clone();
                let rows = models.iter().enumerate().map(|(index, model)| {
                    let picked = model.clone();
                    Row::new(SharedString::from(format!("found-{index}")), model.clone())
                        .when(chosen.as_deref() == Some(model.as_str()), |row| {
                            row.trailing(icon(Glyph::Check, 16., t.ink))
                        })
                        .on_click(cx.listener(move |panel, _, _, cx| {
                            panel.models.form.chosen = Some(picked.clone());
                            cx.notify();
                        }))
                });
                self.model_list(rows.collect(), t, cx)
            }
            None => ui::labelled(
                "Model",
                ui::text_field(&form.model_name, "Model name", false, window, cx),
                None,
                cx,
            ),
        };
        let protocol_name = PROTOCOLS
            .iter()
            .find(|(protocol, _)| *protocol == form.protocol)
            .map_or("", |(_, name)| name);
        let protocol = if form.protocol_open {
            ui::setting_row(
                "Protocol",
                None,
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(PROTOCOLS.iter().map(|(protocol, name)| {
                        let protocol = *protocol;
                        Action::new(SharedString::from(format!("protocol-{name}")), *name)
                            .small()
                            .selected(form.protocol == protocol)
                            .on_click(cx.listener(move |panel, _, _, cx| {
                                let form = &mut panel.models.form;
                                if form.protocol != protocol {
                                    form.protocol = protocol;
                                    form.found = None;
                                    form.notice = None;
                                }
                                cx.notify();
                            }))
                    })),
                t,
            )
        } else {
            div().flex().child(
                Action::new("show-protocol", format!("Protocol: {protocol_name}"))
                    .tone(Tone::Quiet)
                    .small()
                    .on_click(cx.listener(|panel, _, _, cx| {
                        panel.models.form.protocol_open = true;
                        cx.notify();
                    })),
            )
        };
        div()
            .flex()
            .flex_col()
            .gap_5()
            .child(connection)
            .child(model)
            .child(protocol)
    }

    fn render_key_fields(
        &self,
        provider: &ModelProvider,
        t: &Tokens,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let form = &self.models.form;
        let key_typed = form.text(&form.key, cx).len() >= 8;
        let routing = routing_fields(provider).into_iter().filter_map(|field| {
            let input = form.routing_input(field)?;
            let typed = form.text(input, cx);
            let label = routing_label(field);
            Some(ui::labelled(
                label,
                ui::text_field(
                    input,
                    label,
                    !typed.is_empty() && !routing_id_ok(&typed),
                    window,
                    cx,
                ),
                (!typed.is_empty() && !routing_id_ok(&typed))
                    .then(|| "Use only letters, numbers, dashes and underscores.".into()),
                cx,
            ))
        });
        let connection = ui::card(t)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1p5()
                    .child(ui::labelled(
                        "API key",
                        ui::text_field(&form.key, "API key", false, window, cx),
                        None,
                        cx,
                    ))
                    .when_some(provider.hint.clone(), |this, hint| {
                        this.child(ui::meta(hint, t))
                    }),
            )
            .children(routing)
            .when(provider.catalog_probe || form.notice.is_some(), |this| {
                let provider_id = provider.id.clone();
                this.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_3()
                        .when(provider.catalog_probe, |this| {
                            this.child(
                                Action::new("check-key", "Check key")
                                    .disabled(!key_typed)
                                    .busy(form.busy == Some(Busy::Check))
                                    .on_click(cx.listener(move |panel, _, window, cx| {
                                        panel.check_key(&provider_id, window, cx)
                                    })),
                            )
                        })
                        .when_some(form.notice.clone(), |this, notice| {
                            this.child(ui::body(notice, t.ink_secondary))
                        }),
                )
            });
        let chosen = form.chosen.clone();
        let rows = provider
            .models
            .iter()
            .enumerate()
            .map(|(index, model)| {
                let picked = model.id.clone();
                Row::new(
                    SharedString::from(format!("catalog-{index}")),
                    model.label.clone(),
                )
                .when(chosen.as_deref() == Some(model.id.as_str()), |row| {
                    row.trailing(icon(Glyph::Check, 16., t.ink))
                })
                .on_click(cx.listener(move |panel, _, _, cx| {
                    panel.models.form.chosen = Some(picked.clone());
                    cx.notify();
                }))
            })
            .collect();
        div()
            .flex()
            .flex_col()
            .gap_5()
            .child(connection)
            .child(self.model_list(rows, t, cx))
            .when(provider.sign_in, |this| {
                this.child(
                    div().flex().child(
                        Action::new("sign-in-instead", "Sign in with an account instead")
                            .tone(Tone::Link)
                            .small()
                            .glyph(Glyph::ExternalLink)
                            .on_click(cx.listener(|panel, _, _, cx| panel.open_web_models(cx))),
                    ),
                )
            })
    }

    /// A list of models to choose one from, short until **Show all**.
    fn model_list(&self, rows: Vec<Row>, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let total = rows.len();
        let show_all = self.models.form.show_all || total <= SHORT_LIST + 1;
        let shown = if show_all { total } else { SHORT_LIST };
        div()
            .flex()
            .flex_col()
            .gap_1p5()
            .child(ui::group_label("Model", t))
            .child(
                ui::card(t)
                    .p_2()
                    .gap_0()
                    .children(rows.into_iter().take(shown)),
            )
            .when(!show_all, |this| {
                this.child(
                    div().flex().child(
                        Action::new("show-all-models", format!("Show all {total} models"))
                            .tone(Tone::Link)
                            .small()
                            .on_click(cx.listener(|panel, _, _, cx| {
                                panel.models.form.show_all = true;
                                cx.notify();
                            })),
                    ),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_ids_are_one_plain_path_segment() {
        assert!(routing_id_ok("team_a-1"));
        assert!(!routing_id_ok(""));
        assert!(!routing_id_ok("a/b"));
        assert!(!routing_id_ok(&"x".repeat(65)));
    }

    #[test]
    fn a_server_that_lists_nothing_asks_for_a_name() {
        assert_eq!(found_sentence(1), "Found 1 model.");
        assert!(found_sentence(0).contains("Enter one by name"));
    }
}
