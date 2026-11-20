use gpui_kit::component::input::{Input, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::{self, McpServer, ServerState, SourceInstall, SourcePreset};
use crate::app::Desktop;
use crate::theme::{radius, Theme};
use crate::ui::{error_line, field_box, icon, pill_button, Tone, Type};

use super::confirm::Confirm;
use super::server_sign_in::{Subject, Waiting};
use super::services::service_mark;

/// The services this server connects to directly, and what the person connected through them.
pub struct Sources {
    presets: Vec<SourcePreset>,
    installs: Vec<SourceInstall>,
    pub(super) servers: Vec<McpServer>,
    pub(super) assignments: Vec<api::Assignment>,
}

/// Direct connections in the Connections tab: what was read, and the one change in progress.
#[derive(Default)]
pub struct Presets {
    pub(super) sources: Option<Result<Sources, String>>,
    pub(super) form: Option<Form>,
    /// The key of the row with a request on its way to the server.
    pub(super) busy: Option<String>,
    pub(super) sign_in: Option<Waiting>,
    pub(super) attempts: u64,
    /// The key of the row whose agent choice is open.
    pub(super) choosing_agents: Option<String>,
    /// Why the last change to a row failed, shown under it.
    pub(super) problem: Option<(String, String)>,
}

impl Presets {
    pub fn forget(&mut self) {
        self.sources = None;
        self.form = None;
        self.busy = None;
        self.sign_in = None;
        self.choosing_agents = None;
        self.problem = None;
    }

    pub(super) fn signing_in(&self, attempt: u64) -> bool {
        self.sign_in.as_ref().is_some_and(|waiting| waiting.attempt == attempt)
    }
}

/// What a row asks for before it connects. Its fields are dropped as soon as it is sent.
pub enum Form {
    Token { preset: String, token: Entity<InputState>, address: Option<Entity<InputState>> },
    Address { preset: String, address: Entity<InputState> },
    Client { subject: Subject, server_id: String, client_id: Entity<InputState>, secret: Entity<InputState> },
}

impl Form {
    fn key(&self) -> &str {
        match self {
            Self::Token { preset, .. } | Self::Address { preset, .. } => preset,
            Self::Client { subject, .. } => &subject.key,
        }
    }
}

/// What a disconnect removes: the token source, or the signed-in server with its grant.
#[derive(Clone)]
pub enum Source {
    Install(String),
    Server(String),
}

/// Where one preset stands for this person.
enum Link<'a> {
    Token(&'a SourceInstall),
    Server(&'a McpServer),
    None,
}

fn link<'a>(preset: &SourcePreset, sources: &'a Sources) -> Link<'a> {
    if preset.sign_in {
        return sources.servers.iter().find(|server| serves(preset, server)).map_or(Link::None, Link::Server);
    }
    let install = sources.installs.iter().find(|install| match &preset.url {
        Some(url) => install.preset() == Some(preset.id.as_str()) || api::same_endpoint(&install.source, url),
        None => install.name == preset.name,
    });
    install.map_or(Link::None, Link::Token)
}

/// The server a sign-in preset added: at its endpoint, or by name when the person chose the address.
pub(super) fn serves(preset: &SourcePreset, server: &McpServer) -> bool {
    server.install_id.is_none()
        && (preset.endpoint().is_some_and(|endpoint| server.serves(endpoint))
            || (preset.url.is_none() && server.name == preset.name))
}

/// A name with only its letters and digits, lowercased, so "Google Calendar" and
/// "google-calendar" name the same service.
fn plain(value: &str) -> String {
    value.chars().filter(char::is_ascii_alphanumeric).map(|letter| letter.to_ascii_lowercase()).collect()
}

impl Desktop {
    pub(super) fn load_presets(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let work = async move {
            let (presets, installs, servers, assignments) = tokio::try_join!(
                api.source_presets(&space_id),
                api.mcp_sources(&space_id),
                api.mcp_servers(&space_id),
                api.mcp_assignments(&space_id),
            )?;
            Ok(Sources { presets, installs, servers, assignments })
        };
        self.call(window, cx, work, |this, result, _, _| {
            this.store.presets.sources = Some(result.map_err(|error| api::explain(&error)));
        });
    }

    fn preset(&self, id: &str) -> Option<SourcePreset> {
        let Some(Ok(sources)) = &self.store.presets.sources else { return None };
        sources.presets.iter().find(|preset| preset.id == id).cloned()
    }

    fn connect_preset(&mut self, preset: SourcePreset, window: &mut Window, cx: &mut Context<Self>) {
        self.store.presets.problem = None;
        self.store.presets.choosing_agents = None;
        if !preset.sign_in {
            let token = cx.new(|cx| InputState::new(window, cx).masked(true).placeholder("Token"));
            let address = preset.url.is_none().then(|| self.address_field(&preset, window, cx));
            self.store.presets.form = Some(Form::Token { preset: preset.id, token, address });
        } else if let Some(endpoint) = preset.url.clone() {
            self.store.presets.form = None;
            self.start_sign_in(preset, endpoint, window, cx);
        } else {
            let address = self.address_field(&preset, window, cx);
            self.store.presets.form = Some(Form::Address { preset: preset.id, address });
        }
        cx.notify();
    }

    fn address_field(&self, preset: &SourcePreset, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        let placeholder = preset.url_placeholder.clone().unwrap_or_else(|| "https://".into());
        let address = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        if let Some(default) = preset.default_url.clone() {
            address.update(cx, |field, cx| field.set_value(default, window, cx));
        }
        address
    }

    fn submit_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = self.store.presets.form.take() else { return };
        let text = |field: &Entity<InputState>, cx: &App| field.read(cx).value().trim().to_owned();
        if let Form::Client { subject, server_id, client_id, secret } = form {
            let id = text(&client_id, cx);
            if id.is_empty() {
                self.store.presets.form = Some(Form::Client { subject, server_id, client_id, secret });
                return;
            }
            let secret = Some(secret.read(cx).value().to_string()).filter(|secret| !secret.is_empty());
            self.save_client(subject, server_id, id, secret, window, cx);
            cx.notify();
            return;
        }
        let Some(preset) = self.preset(form.key()) else { return };
        match form {
            Form::Token { token, address, .. } => {
                let credential = text(&token, cx);
                let endpoint = match (&preset.url, &address) {
                    (Some(url), _) => url.clone(),
                    (None, Some(address)) => text(address, cx),
                    (None, None) => return,
                };
                if credential.is_empty() || endpoint.is_empty() {
                    self.store.presets.form = Some(Form::Token { preset: preset.id, token, address });
                    return;
                }
                self.install_token(preset, endpoint, credential, window, cx);
            }
            Form::Address { address, .. } => {
                let endpoint = text(&address, cx);
                if endpoint.is_empty() {
                    self.store.presets.form = Some(Form::Address { preset: preset.id, address });
                    return;
                }
                self.start_sign_in(preset, endpoint, window, cx);
            }
            Form::Client { .. } => {}
        }
        cx.notify();
    }

    fn install_token(
        &mut self,
        preset: SourcePreset,
        endpoint: String,
        credential: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        self.store.presets.busy = Some(preset.id.clone());
        let name = preset.name.clone();
        let id = preset.id.clone();
        let work = async move { api.install_preset(&space_id, &preset, &endpoint, credential).await };
        self.call(window, cx, work, move |this, result, window, cx| match result {
            Ok(_) => {
                this.store.presets.busy = None;
                this.notify(format!("{name} connected."), false, None, cx);
                this.load_presets(window, cx);
            }
            Err(error) => this.fail_connection(&id, api::explain(&error), cx),
        });
    }

    fn start_sign_in(&mut self, preset: SourcePreset, endpoint: String, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        self.store.presets.busy = Some(preset.id.clone());
        let work = {
            let name = preset.name.clone();
            async move { api.connect_mcp(&space_id, &name, &endpoint).await }
        };
        let subject = Subject::preset(&preset);
        self.call(window, cx, work, move |this, result, window, cx| {
            this.store.presets.busy = None;
            match result {
                Ok(connected) => this.signed_in_or_open(subject, connected.sign_in, window, cx),
                Err(error) => this.sign_in_refused(&subject, error, window, cx),
            }
        });
    }

    pub(super) fn disconnect_source(&mut self, source: Source, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else {
            self.store.settle_confirm();
            return;
        };
        let work = async move {
            match source {
                Source::Install(id) => api.remove_source(&space_id, &id).await,
                Source::Server(id) => api.remove_mcp_server(&space_id, &id).await,
            }
        };
        self.call(window, cx, work, |this, result, window, cx| {
            this.store.settle_confirm();
            this.store.presets.choosing_agents = None;
            if let Err(error) = result {
                this.notify(api::explain(&error), true, None, cx);
            }
            this.load_presets(window, cx);
        });
    }

    /// The services to connect to directly, or None while there is nothing to show. A service
    /// the managed catalog also offers shows only there, unless it is already connected here.
    pub(super) fn render_preset_section(&mut self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let sources = match &self.store.presets.sources {
            None => return None,
            Some(Err(problem)) => {
                return Some(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().section().pb_1().child("Connect directly"))
                        .child(error_line(problem.clone(), theme))
                        .into_any_element(),
                )
            }
            Some(Ok(sources)) => sources,
        };
        let managed: Vec<String> = match &self.store.services {
            Some(Ok(services)) => {
                services.catalog.iter().flat_map(|app| [plain(&app.name), plain(&app.slug)]).collect()
            }
            _ => Vec::new(),
        };
        let query = self.store.query.read(cx).value().trim().to_lowercase();
        let mut shown: Vec<(SourcePreset, bool)> = sources
            .presets
            .iter()
            .filter(|preset| query.is_empty() || preset.name.to_lowercase().contains(&query) || preset.id.contains(&query))
            .map(|preset| (preset.clone(), !matches!(link(preset, sources), Link::None)))
            .filter(|(preset, linked)| *linked || !managed.iter().any(|name| *name == plain(&preset.name) || *name == plain(&preset.id)))
            .collect();
        if shown.is_empty() {
            return None;
        }
        shown.sort_by_key(|(preset, linked)| (!linked, preset.name.to_lowercase()));
        let rows: Vec<AnyElement> = shown.into_iter().map(|(preset, _)| self.preset_row(preset, theme, cx)).collect();
        Some(
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(div().section().pb_1().child("Connect directly"))
                .children(rows)
                .into_any_element(),
        )
    }

    fn preset_row(&mut self, preset: SourcePreset, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(Ok(sources)) = &self.store.presets.sources else { return div().into_any_element() };
        let id = preset.id.clone();
        let state = &self.store.presets;
        let waiting = state.sign_in.as_ref().filter(|waiting| waiting.key == id).map(|waiting| waiting.in_browser);
        let busy = self.connection_busy(&id);
        let blocked = state.sign_in.is_some() || state.busy.is_some();
        let form_open = state.form.as_ref().is_some_and(|form| form.key() == id);
        let problem = self.connection_problem(&id).map(str::to_owned);
        let (install, server) = match link(&preset, sources) {
            Link::Token(install) => (Some(install.id.clone()), None),
            Link::Server(server) => (None, Some(server.clone())),
            Link::None => (None, None),
        };
        let server_state = server.as_ref().map(McpServer::state);
        let connected = install.is_some() || server_state == Some(ServerState::Connected);
        let choosing = connected && state.choosing_agents.as_deref() == Some(id.as_str());
        let nobody = server.as_ref().is_some_and(|server| {
            server.all_bots != Some(true) && !sources.assignments.iter().any(|row| row.server_id == server.id)
        });

        let status = if let Some(in_browser) = waiting {
            let line = if in_browser { "Finish signing in in your browser" } else { "Finish signing in in the sign-in window" };
            Some((line, theme.ink_secondary))
        } else if busy {
            Some(("Connecting…", theme.ink_secondary))
        } else if connected {
            if nobody {
                Some(("Connected, no agent can use it yet", theme.warning))
            } else {
                Some(("Connected", theme.success))
            }
        } else {
            match server_state {
                Some(ServerState::NeedsClient) => Some(("Needs an OAuth client", theme.warning)),
                Some(ServerState::NeedsSignIn) => Some(("Needs signing in again", theme.danger)),
                Some(ServerState::NotWorking) => Some(("Not working", theme.danger)),
                Some(ServerState::Disabled) => Some(("Turned off", theme.ink_secondary)),
                Some(ServerState::NotConnected) => Some(("Sign-in not finished", theme.warning)),
                Some(ServerState::Connected) | None => None,
            }
        };

        let mut actions: Vec<AnyElement> = Vec::new();
        if waiting.is_some() {
            actions.push(
                pill_button(SharedString::from(format!("preset-cancel-{id}")), "Cancel", Tone::Quiet, true, theme)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.store.presets.sign_in = None;
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        } else if connected {
            if server.is_some() {
                let preset_id = id.clone();
                actions.push(
                    pill_button(SharedString::from(format!("preset-agents-{id}")), "Agents", Tone::Quiet, !blocked, theme)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let open = this.store.presets.choosing_agents.as_deref() == Some(preset_id.as_str());
                            this.store.presets.choosing_agents = (!open).then(|| preset_id.clone());
                            cx.notify();
                        }))
                        .into_any_element(),
                );
            }
            let source = match (&install, &server) {
                (Some(install), _) => Some(Source::Install(install.clone())),
                (None, Some(server)) => Some(Source::Server(server.id.clone())),
                (None, None) => None,
            };
            if let Some(source) = source {
                actions.push(self.disconnect_button(&preset, source, !blocked, theme, cx));
            }
        } else if let (false, Some(server), Some(server_state)) = (form_open, &server, server_state) {
            let (label, server_id) = (
                if server_state == ServerState::NeedsClient { "Add client" } else { "Sign in again" },
                server.id.clone(),
            );
            let target = preset.clone();
            actions.push(
                pill_button(SharedString::from(format!("preset-retry-{id}")), label, Tone::Primary, !blocked, theme)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if this.store.presets.busy.is_some() || this.store.presets.sign_in.is_some() {
                            return;
                        }
                        let subject = Subject::preset(&target);
                        if server_state == ServerState::NeedsClient {
                            this.open_client_form(subject, server_id.clone(), window, cx);
                        } else {
                            this.sign_in_again(subject, server_id.clone(), window, cx);
                        }
                    }))
                    .into_any_element(),
            );
            actions.push(self.disconnect_button(&preset, Source::Server(server.id.clone()), !blocked, theme, cx));
        } else if !form_open {
            let target = preset.clone();
            actions.push(
                pill_button(SharedString::from(format!("preset-connect-{id}")), "Connect", Tone::Primary, !blocked, theme)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if this.store.presets.busy.is_none() && this.store.presets.sign_in.is_none() {
                            this.connect_preset(target.clone(), window, cx);
                        }
                    }))
                    .into_any_element(),
            );
        }

        let form = form_open.then(|| self.render_connection_form(&id, theme, cx)).flatten();
        let agents = (choosing && !blocked)
            .then(|| server.as_ref().map(|server| self.render_server_agents(&id, server, theme, cx)))
            .flatten();
        let key = format!("direct:{id}");
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .id(SharedString::from(format!("preset-{id}")))
                    .flex()
                    .items_center()
                    .gap_3()
                    .p_2()
                    .rounded(radius::CARD)
                    .hover({
                        let fill = theme.raised.opacity(0.4);
                        move |style| style.bg(fill)
                    })
                    .child(service_mark(&preset.name, &key, theme))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(div().item().font_weight(FontWeight::SEMIBOLD).truncate().child(preset.name.clone()))
                            .children(status.map(|(line, tone)| {
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_1()
                                    .body()
                                    .text_color(tone)
                                    .when(connected && tone == theme.success, |row| row.child(icon("check", px(13.), tone)))
                                    .child(line)
                            })),
                    )
                    .child(div().flex().items_center().gap_2().children(actions)),
            )
            .children(problem.map(|problem| div().pl(px(60.)).pr_2().pb_2().child(error_line(problem, theme))))
            .children(form.map(|form| div().pl(px(60.)).pr_2().pb_3().child(form)))
            .children(agents.map(|agents| div().pl(px(60.)).pr_2().pb_3().child(agents)))
            .into_any_element()
    }

    fn disconnect_button(
        &mut self,
        preset: &SourcePreset,
        source: Source,
        enabled: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let name = preset.name.clone();
        pill_button(SharedString::from(format!("preset-disconnect-{}", preset.id)), "Disconnect", Tone::Quiet, enabled, theme)
            .on_click(cx.listener(move |this, _, _, cx| {
                if this.store.presets.busy.is_none() && this.store.presets.sign_in.is_none() {
                    this.store.confirm = Some(Confirm::DisconnectSource { name: name.clone(), source: source.clone() });
                    cx.notify();
                }
            }))
            .into_any_element()
    }

    /// The form open under the row kept under `key`, if one is.
    pub(super) fn render_connection_form(&mut self, key: &str, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let form = self.store.presets.form.as_ref().filter(|form| form.key() == key)?;
        let field = |input: &Entity<InputState>| {
            field_box(theme).flex_1().child(Input::new(input).appearance(false).bordered(false)).into_any_element()
        };
        let (fields, submit, note): (Vec<AnyElement>, &str, Option<AnyElement>) = match form {
            Form::Token { token, address, .. } => {
                let mut fields: Vec<AnyElement> = address.iter().map(field).collect();
                fields.push(field(token));
                (fields, "Connect", None)
            }
            Form::Address { address, .. } => (vec![field(address)], "Continue", None),
            Form::Client { subject, client_id, secret, .. } => {
                let callback = self
                    .api
                    .as_ref()
                    .and_then(|api| url::Url::parse(api.client.server()).ok())
                    .and_then(|server| server.join("/mcp/oauth/callback").ok())
                    .map(String::from)
                    .unwrap_or_default();
                let setup = subject.setup.clone();
                let note = div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .body()
                    .text_color(theme.ink_secondary)
                    .child(format!("{} needs a client you register with it. Use this redirect URL:", subject.name))
                    .child(div().meta().text_color(theme.ink).child(callback))
                    .children(setup.map(|setup| {
                        div()
                            .id(SharedString::from(format!("connection-setup-{key}")))
                            .flex()
                            .items_center()
                            .gap_1()
                            .text_color(theme.ink)
                            .cursor_pointer()
                            .child("How to register a client")
                            .child(icon("external-link", px(13.), theme.ink))
                            .on_click(move |_, _, cx| cx.open_url(&setup))
                    }))
                    .into_any_element();
                (vec![field(client_id), field(secret)], "Save and sign in", Some(note))
            }
        };
        let id = key.to_owned();
        Some(
            div()
                .flex()
                .flex_col()
                .gap_2()
                .children(note)
                .children(fields.into_iter().map(|field| div().flex().child(field)))
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .child(
                            pill_button(SharedString::from(format!("preset-form-cancel-{id}")), "Cancel", Tone::Quiet, true, theme)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.store.presets.form = None;
                                    cx.notify();
                                })),
                        )
                        .child(
                            pill_button(SharedString::from(format!("preset-form-submit-{id}")), submit, Tone::Primary, true, theme)
                                .on_click(cx.listener(|this, _, window, cx| this.submit_form(window, cx))),
                        ),
                )
                .into_any_element(),
        )
    }

}

#[cfg(test)]
mod tests {
    use super::plain;

    #[test]
    fn a_service_name_matches_its_catalog_slug() {
        assert_eq!(plain("Google Calendar"), plain("google-calendar"));
        assert_eq!(plain("Notion"), plain("notion"));
        assert_ne!(plain("Google Drive"), plain("Google Calendar"));
    }
}
