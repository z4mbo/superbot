use gpui_kit::component::input::InputState;
use gpui_kit::*;
use superbot_client::Error;

use crate::api::{self, McpServer, OAuthStatus, ServerState, SignInStart, SourcePreset, OAUTH_CLIENT_REQUIRED};
use crate::app::Desktop;
use crate::theme::Theme;
use crate::ui::{chip, Type};
use crate::web::Returned;

use super::presets::{serves, Form};

/// What a remote server's sign-in is for: the key its progress is kept under in the Connections
/// tab, the name it shows, and how its server is found again.
#[derive(Clone)]
pub struct Subject {
    pub key: String,
    pub name: String,
    pub setup: Option<String>,
    find: Find,
}

#[derive(Clone)]
enum Find {
    Preset(SourcePreset),
    Server(String),
}

impl Subject {
    pub fn preset(preset: &SourcePreset) -> Self {
        Self {
            key: preset.id.clone(),
            name: preset.name.clone(),
            setup: preset.oauth_setup_url.clone(),
            find: Find::Preset(preset.clone()),
        }
    }

    pub fn server(key: String, name: String, server_id: String) -> Self {
        Self { key, name, setup: None, find: Find::Server(server_id) }
    }

    fn matches(&self, server: &McpServer) -> bool {
        match &self.find {
            Find::Preset(preset) => serves(preset, server),
            Find::Server(id) => server.id == *id,
        }
    }
}

/// A sign-in open in the app's sign-in window or in the browser.
pub struct Waiting {
    pub key: String,
    pub attempt: u64,
    pub in_browser: bool,
}

/// How long a browser sign-in is waited on before the person is asked to check again later.
const BROWSER_CHECKS: u32 = 45;
const BROWSER_PAUSE: std::time::Duration = std::time::Duration::from_secs(2);

impl Desktop {
    /// Signs in to a server that is already saved, such as a plugin's connector, with the same
    /// window, browser and client steps as a direct connection. Its progress is kept under `key`.
    pub(super) fn sign_in_server(
        &mut self,
        key: String,
        name: String,
        server_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.store.presets.busy.is_none() && self.store.presets.sign_in.is_none() {
            self.sign_in_again(Subject::server(key, name, server_id.clone()), server_id, window, cx);
        }
    }

    /// Why the last change under `key` failed.
    pub(super) fn connection_problem(&self, key: &str) -> Option<&str> {
        self.store.presets.problem.as_ref().filter(|(owner, _)| owner == key).map(|(_, problem)| problem.as_str())
    }

    /// A request or a sign-in is on its way for `key`.
    pub(super) fn connection_busy(&self, key: &str) -> bool {
        self.store.presets.busy.as_deref() == Some(key)
            || self.store.presets.sign_in.as_ref().is_some_and(|waiting| waiting.key == key)
    }

    pub(super) fn fail_connection(&mut self, key: &str, problem: String, cx: &mut Context<Self>) {
        self.store.presets.busy = None;
        self.store.presets.problem = Some((key.to_owned(), problem));
        cx.notify();
    }

    pub(super) fn sign_in_again(
        &mut self,
        subject: Subject,
        server_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        self.store.presets.problem = None;
        self.store.presets.busy = Some(subject.key.clone());
        let work = async move { api.begin_mcp_sign_in(&space_id, &server_id).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            this.store.presets.busy = None;
            match result {
                Ok(start) => this.signed_in_or_open(subject, start, window, cx),
                Err(error) => this.sign_in_refused(&subject, error, window, cx),
            }
        });
    }

    pub(super) fn sign_in_refused(
        &mut self,
        subject: &Subject,
        error: Error,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let needs_client = matches!(&error, Error::Server { code: Some(code), .. } if code == OAUTH_CLIENT_REQUIRED);
        if !needs_client {
            self.fail_connection(&subject.key, api::explain(&error), cx);
        }
        // The server was saved before the authorization server refused to register a client,
        // so it reads as needing one.
        self.load_presets(window, cx);
    }

    pub(super) fn signed_in_or_open(
        &mut self,
        subject: Subject,
        start: SignInStart,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match start {
            SignInStart::Open { session_id, authorization_url } => {
                self.open_sign_in(subject, session_id, authorization_url, window, cx)
            }
            SignInStart::Connected => self.recheck(subject, window, cx),
            SignInStart::NotRequested => {
                self.fail_connection(&subject.key, format!("{} didn't ask for a sign-in.", subject.name), cx);
                self.load_presets(window, cx);
            }
        }
    }

    /// Shows the provider's page in a sign-in window. The code it sends back is given to the
    /// server with this app's own session; the window holds none of it.
    fn open_sign_in(
        &mut self,
        subject: Subject,
        session_id: String,
        authorization_url: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(me)) = (self.api.as_ref(), self.me.as_ref()) else { return };
        let (server, account) = (api.client.server().to_owned(), me.user_id.clone());
        self.store.presets.attempts += 1;
        let attempt = self.store.presets.attempts;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let opened = crate::web::sign_in(
            &server,
            &account,
            &authorization_url,
            move |returned, _| {
                let _ = sender.send(returned);
            },
            cx,
        );
        if !opened {
            self.sign_in_in_browser(subject, authorization_url, attempt, window, cx);
            return;
        }
        self.store.presets.sign_in = Some(Waiting { key: subject.key.clone(), attempt, in_browser: false });
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let returned = receiver.await.unwrap_or(Returned::Closed);
            this.update_in(cx, |this, window, cx| {
                if !this.store.presets.signing_in(attempt) {
                    return;
                }
                this.store.presets.sign_in = None;
                match returned {
                    Returned::Code(code) => this.finish_sign_in(subject, session_id, code, window, cx),
                    Returned::Refused(reason) => {
                        let reason = reason.unwrap_or_else(|| format!("{} didn't finish the sign-in.", subject.name));
                        this.fail_connection(&subject.key, reason, cx);
                        this.load_presets(window, cx);
                    }
                    Returned::Browser => this.sign_in_in_browser(subject, authorization_url, attempt, window, cx),
                    Returned::Closed => {
                        cx.notify();
                        this.load_presets(window, cx);
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// Opens the same sign-in in the browser. The server's web callback finishes it with the
    /// person's web session there, so this only watches for the server to read as signed in.
    fn sign_in_in_browser(
        &mut self,
        subject: Subject,
        authorization_url: String,
        attempt: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        cx.open_url(&authorization_url);
        self.store.presets.sign_in = Some(Waiting { key: subject.key.clone(), attempt, in_browser: true });
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            for _ in 0..BROWSER_CHECKS {
                cx.background_executor().timer(BROWSER_PAUSE).await;
                if !this.read_with(cx, |this, _| this.store.presets.signing_in(attempt)).unwrap_or(false) {
                    return;
                }
                let (api, space_id) = (api.clone(), space_id.clone());
                let servers = crate::runtime::network(async move { api.mcp_servers(&space_id).await }).await;
                let signed_in = servers.is_ok_and(|servers| {
                    servers
                        .iter()
                        .any(|server| server.oauth_status == OAuthStatus::Connected && subject.matches(server))
                });
                if signed_in {
                    this.update_in(cx, |this, window, cx| {
                        if this.store.presets.signing_in(attempt) {
                            this.store.presets.sign_in = None;
                            this.connected_now(&subject, window, cx);
                        }
                    })
                    .ok();
                    return;
                }
            }
            this.update_in(cx, |this, window, cx| {
                if this.store.presets.signing_in(attempt) {
                    this.store.presets.sign_in = None;
                    let line =
                        format!("Still waiting for {}. Finish signing in, then open Connections again.", subject.name);
                    this.fail_connection(&subject.key, line, cx);
                    this.load_presets(window, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn connected_now(&mut self, subject: &Subject, window: &mut Window, cx: &mut Context<Self>) {
        self.store.presets.choosing_agents = Some(subject.key.clone());
        self.notify(format!("{} connected.", subject.name), false, None, cx);
        self.load_presets(window, cx);
    }

    /// Already signed in: checks the server again so its state is current.
    fn recheck(&mut self, subject: Subject, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(Ok(sources)) = &self.store.presets.sources else { return };
        let Some(server_id) =
            sources.servers.iter().find(|server| subject.matches(server)).map(|server| server.id.clone())
        else {
            self.load_presets(window, cx);
            return;
        };
        self.store.presets.busy = Some(subject.key.clone());
        let work = async move { api.check_mcp_server(&space_id, &server_id).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            this.store.presets.busy = None;
            match result {
                Ok(server) if server.state() == ServerState::Connected => this.connected_now(&subject, window, cx),
                Ok(server) => {
                    let problem =
                        server.health.message.unwrap_or_else(|| format!("{} isn't answering yet.", subject.name));
                    this.fail_connection(&subject.key, problem, cx);
                    this.load_presets(window, cx);
                }
                Err(error) => {
                    this.fail_connection(&subject.key, api::explain(&error), cx);
                    this.load_presets(window, cx);
                }
            }
        });
    }

    fn finish_sign_in(
        &mut self,
        subject: Subject,
        session_id: String,
        code: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        self.store.presets.busy = Some(subject.key.clone());
        let work = async move { api.complete_mcp_sign_in(&space_id, &session_id, &code).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            this.store.presets.busy = None;
            match result {
                Ok(()) => this.connected_now(&subject, window, cx),
                Err(error) => {
                    this.fail_connection(&subject.key, api::explain(&error), cx);
                    this.load_presets(window, cx);
                }
            }
        });
    }

    /// Asks for the client the person registered with the server's authorization server.
    pub(super) fn open_client_form(
        &mut self,
        subject: Subject,
        server_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let client_id = cx.new(|cx| InputState::new(window, cx).placeholder("Client ID"));
        let secret = cx.new(|cx| InputState::new(window, cx).masked(true).placeholder("Client secret (optional)"));
        self.store.presets.problem = None;
        self.store.presets.form = Some(Form::Client { subject, server_id, client_id, secret });
        cx.notify();
    }

    pub(super) fn save_client(
        &mut self,
        subject: Subject,
        server_id: String,
        client_id: String,
        secret: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(Ok(sources)) = &self.store.presets.sources else { return };
        let Some(server) = sources.servers.iter().find(|server| server.id == server_id).cloned() else { return };
        let Some(endpoint) = server.endpoint.clone() else { return };
        self.store.presets.busy = Some(subject.key.clone());
        let work = async move {
            api.set_mcp_oauth_client(&space_id, &server, &endpoint, client_id, secret).await?;
            api.begin_mcp_sign_in(&space_id, &server.id).await
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            this.store.presets.busy = None;
            match result {
                Ok(start) => this.signed_in_or_open(subject, start, window, cx),
                Err(error) => this.sign_in_refused(&subject, error, window, cx),
            }
        });
    }

    fn set_agents(
        &mut self,
        key: String,
        server_id: String,
        all: bool,
        bot_ids: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        self.store.presets.busy = Some(key.clone());
        let work = async move { api.set_mcp_agents(&space_id, &server_id, all, &bot_ids).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            this.store.presets.busy = None;
            if let Err(error) = result {
                this.fail_connection(&key, api::explain(&error), cx);
            }
            this.load_presets(window, cx);
        });
    }

    /// Which agents may use `server`: every one, or those chosen. Changes are kept under `key`.
    pub(super) fn render_server_agents(
        &mut self,
        key: &str,
        server: &McpServer,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let everyone = server.all_bots == Some(true);
        let assigned: Vec<String> = match &self.store.presets.sources {
            Some(Ok(sources)) => sources
                .assignments
                .iter()
                .filter(|row| row.server_id == server.id)
                .map(|row| row.bot_id.clone())
                .collect(),
            _ => Vec::new(),
        };
        let agents = self.agents().to_vec();
        let all = {
            let (key, server_id) = (key.to_owned(), server.id.clone());
            chip(SharedString::from(format!("agents-all-{key}")), "All agents", everyone, theme).on_click(cx.listener(
                move |this, _, window, cx| {
                    if !everyone {
                        this.set_agents(key.clone(), server_id.clone(), true, Vec::new(), window, cx);
                    }
                },
            ))
        };
        let chips = agents.into_iter().map(|agent| {
            let chosen = !everyone && assigned.contains(&agent.id);
            let (key, server_id) = (key.to_owned(), server.id.clone());
            let current = if everyone { Vec::new() } else { assigned.clone() };
            chip(SharedString::from(format!("agents-{key}-{}", agent.id)), agent.name.clone(), chosen, theme).on_click(
                cx.listener(move |this, _, window, cx| {
                    let mut bot_ids = current.clone();
                    if chosen {
                        bot_ids.retain(|id| *id != agent.id);
                    } else {
                        bot_ids.push(agent.id.clone());
                    }
                    this.set_agents(key.clone(), server_id.clone(), false, bot_ids, window, cx);
                }),
            )
        });
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().body().text_color(theme.ink_secondary).child("Agents that can use it"))
            .child(div().flex().flex_wrap().gap_1p5().child(all).children(chips))
            .into_any_element()
    }
}
