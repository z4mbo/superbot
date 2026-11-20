use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use superbot_client::Error;

use crate::api::{self, next_account_label, CatalogApp, Connection, ConnectionStatus};
use crate::app::Desktop;
use crate::theme::{radius, Theme};
use crate::ui::{empty_line, error_line, icon, pill_button, Tone, Type};

use super::confirm::Confirm;
use super::count;

/// The apps the server can connect, and the accounts the person connected to them.
pub struct Services {
    pub catalog: Vec<CatalogApp>,
    pub connections: Vec<Connection>,
}

/// A sign-in open in the browser, waited on while the person finishes it.
pub struct SignIn {
    pub app: String,
    attempt: u64,
}

/// How long a sign-in is waited on before the person is asked to check again later.
const SIGN_IN_CHECKS: u32 = 45;
const SIGN_IN_PAUSE: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Connected,
    Waiting,
    Broken,
    Available,
}

fn accounts<'a>(app: &CatalogApp, connections: &'a [Connection]) -> Vec<&'a Connection> {
    connections
        .iter()
        .filter(|row| {
            row.belongs_to(app) && matches!(row.status, ConnectionStatus::Connected | ConnectionStatus::Pending)
        })
        .collect()
}

fn state(app: &CatalogApp, connections: &[Connection]) -> State {
    let rows: Vec<&Connection> = connections.iter().filter(|row| row.belongs_to(app)).collect();
    if app.connected || rows.iter().any(|row| row.status == ConnectionStatus::Connected) {
        State::Connected
    } else if rows.iter().any(|row| row.status == ConnectionStatus::Error) {
        State::Broken
    } else if rows.iter().any(|row| row.status == ConnectionStatus::Pending) {
        State::Waiting
    } else {
        State::Available
    }
}

impl Desktop {
    pub(super) fn load_services(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        self.load_presets(window, cx);
        self.store.services_loading = true;
        let work = async move {
            // Reading the catalog settles finished sign-ins, so the accounts are listed after it.
            let catalog = api.connection_catalog(&space_id).await?;
            let connections = api.connections(&space_id).await?;
            Ok(Services { catalog, connections })
        };
        self.call(window, cx, work, |this, result, _, _| {
            this.store.services_loading = false;
            this.store.services = Some(result.map_err(|error| api::explain(&error)));
        });
        cx.notify();
    }

    fn connect_app(&mut self, app: CatalogApp, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(Ok(services)) = &self.store.services else { return };
        let label = next_account_label(&app, &services.connections);
        self.store.sign_ins += 1;
        let attempt = self.store.sign_ins;
        self.store.sign_in = Some(SignIn { app: app.key(), attempt });
        let begin = {
            let app = app.clone();
            async move { api.begin_connection(&space_id, &app, &label).await }
        };
        self.call(window, cx, begin, move |this, result, window, cx| {
            if !this.store.signing_in(attempt) {
                return;
            }
            match result {
                Ok(begun) => {
                    match begun.authorization_url {
                        Some(url) => cx.open_url(&url),
                        None if app.no_auth => {
                            this.store.sign_in = None;
                            this.connected(&app.name, window, cx);
                            return;
                        }
                        None => {}
                    }
                    this.wait_for_sign_in(app, begun.connection_id, attempt, window, cx);
                }
                Err(error) => {
                    this.store.sign_in = None;
                    this.notify(api::explain(&error), true, None, cx);
                }
            }
        });
        cx.notify();
    }

    /// Asks every few seconds whether the browser sign-in finished, while the person is on it.
    fn wait_for_sign_in(
        &mut self,
        app: CatalogApp,
        connection_id: String,
        attempt: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        cx.spawn_in(window, async move |this, cx| {
            for _ in 0..SIGN_IN_CHECKS {
                cx.background_executor().timer(SIGN_IN_PAUSE).await;
                let current = this.read_with(cx, |this, _| this.store.signing_in(attempt)).unwrap_or(false);
                if !current {
                    return;
                }
                let (api, space_id, connection_id) = (api.clone(), space_id.clone(), connection_id.clone());
                let answer =
                    crate::runtime::network(async move { api.complete_connection(&space_id, &connection_id).await })
                        .await;
                let finished = match answer {
                    Ok(row) if row.status == ConnectionStatus::Connected => Some(true),
                    Ok(row) if row.status == ConnectionStatus::Revoked => Some(false),
                    // A newer attempt or a removal replaced this one.
                    Err(Error::Server { code: Some(code), .. }) if code == "NOT_FOUND" => Some(false),
                    _ => None,
                };
                if let Some(connected) = finished {
                    this.update_in(cx, |this, window, cx| {
                        if this.store.signing_in(attempt) {
                            this.store.sign_in = None;
                            if connected {
                                this.connected(&app.name, window, cx);
                            } else {
                                this.load_services(window, cx);
                            }
                        }
                    })
                    .ok();
                    return;
                }
            }
            this.update_in(cx, |this, window, cx| {
                if this.store.signing_in(attempt) {
                    this.store.sign_in = None;
                    this.notify(
                        format!("Still waiting for {}. Finish signing in, then open Connections again.", app.name),
                        true,
                        None,
                        cx,
                    );
                    this.load_services(window, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn connected(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.notify(format!("{name} connected."), false, None, cx);
        self.load_services(window, cx);
    }

    pub(super) fn disconnect(&mut self, connection_ids: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else {
            self.store.settle_confirm();
            return;
        };
        let work = async move {
            for connection_id in &connection_ids {
                api.revoke_connection(&space_id, connection_id).await?;
            }
            Ok(())
        };
        self.call(window, cx, work, |this, result, window, cx| {
            this.store.settle_confirm();
            if let Err(error) = result {
                this.notify(api::explain(&error), true, None, cx);
            }
            this.load_services(window, cx);
        });
    }

    pub(super) fn render_services(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let presets = self.render_preset_section(theme, cx);
        let services = match &self.store.services {
            None => {
                let line = if self.store.services_loading { "Loading apps…" } else { "" };
                return div()
                    .flex()
                    .flex_col()
                    .gap_6()
                    .child(empty_line(line, theme).pt_2())
                    .children(presets)
                    .into_any_element();
            }
            Some(Err(problem)) => {
                let problem = div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap_3()
                    .child(error_line(problem.clone(), theme))
                    .child(
                        pill_button("services-retry", "Try again", Tone::Quiet, true, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.load_services(window, cx))),
                    );
                return div().flex().flex_col().gap_6().child(problem).children(presets).into_any_element();
            }
            Some(Ok(services)) => services,
        };
        if services.catalog.is_empty() {
            return presets.unwrap_or_else(|| {
                empty_line("This server has no apps to connect yet. Its admin can add an integration provider.", theme)
                    .pt_2()
                    .into_any_element()
            });
        }
        let query = self.store.query.read(cx).value().trim().to_lowercase();
        let mut shown: Vec<(CatalogApp, State, Vec<Connection>)> = services
            .catalog
            .iter()
            .filter(|app| query.is_empty() || app.name.to_lowercase().contains(&query) || app.slug.contains(&query))
            .map(|app| {
                let rows = accounts(app, &services.connections).into_iter().cloned().collect();
                (app.clone(), state(app, &services.connections), rows)
            })
            .collect();
        if shown.is_empty() {
            return presets
                .unwrap_or_else(|| empty_line("No app matches that search.", theme).pt_2().into_any_element());
        }
        shown.sort_by_key(|(app, state, _)| (*state == State::Available, app.name.to_lowercase()));
        let (mine, available): (Vec<_>, Vec<_>) =
            shown.into_iter().partition(|(_, state, _)| *state != State::Available);
        let section = |title: &'static str, rows: Vec<AnyElement>| {
            div().flex().flex_col().gap_1().child(div().section().pb_1().child(title)).children(rows)
        };
        let mine: Vec<AnyElement> =
            mine.into_iter().map(|(app, state, rows)| self.service_row(app, state, rows, theme, cx)).collect();
        let available: Vec<AnyElement> =
            available.into_iter().map(|(app, state, rows)| self.service_row(app, state, rows, theme, cx)).collect();
        div()
            .flex()
            .flex_col()
            .gap_6()
            .when(!mine.is_empty(), |list| list.child(section("Yours", mine)))
            .when(!available.is_empty(), |list| list.child(section("Available", available)))
            .children(presets)
            .into_any_element()
    }

    fn service_row(
        &mut self,
        app: CatalogApp,
        state: State,
        rows: Vec<Connection>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = app.key();
        let name = app.name.clone();
        let waiting_here = self.store.sign_in.as_ref().is_some_and(|sign_in| sign_in.app == key);
        let busy_elsewhere = self.store.sign_in.is_some() && !waiting_here;
        let connected = rows.iter().filter(|row| row.status == ConnectionStatus::Connected).count();
        let status = if waiting_here {
            Some(("Finish signing in in your browser", theme.ink_secondary))
        } else {
            match state {
                State::Connected if connected > 1 => None,
                State::Connected => Some(("Connected", theme.success)),
                State::Waiting => Some(("Sign-in not finished", theme.warning)),
                State::Broken => Some(("Needs signing in again", theme.danger)),
                State::Available => None,
            }
        };
        let accounts_line = (connected > 1).then(|| count(connected, "account"));
        let action = if waiting_here {
            pill_button(SharedString::from(format!("cancel-{key}")), "Cancel", Tone::Quiet, true, theme).on_click(
                cx.listener(|this, _, _, cx| {
                    this.store.sign_in = None;
                    cx.notify();
                }),
            )
        } else if state == State::Connected {
            let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
            let name = app.name.clone();
            pill_button(
                SharedString::from(format!("disconnect-{key}")),
                "Disconnect",
                Tone::Quiet,
                !ids.is_empty(),
                theme,
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if !ids.is_empty() {
                    this.store.confirm = Some(Confirm::Disconnect { name: name.clone(), connection_ids: ids.clone() });
                    cx.notify();
                }
            }))
        } else {
            let label = match state {
                State::Broken | State::Waiting => "Sign in again",
                _ => "Connect",
            };
            pill_button(SharedString::from(format!("connect-{key}")), label, Tone::Primary, !busy_elsewhere, theme)
                .on_click(cx.listener(move |this, _, window, cx| {
                    if this.store.sign_in.is_none() {
                        this.connect_app(app.clone(), window, cx);
                    }
                }))
        };
        div()
            .id(SharedString::from(format!("service-{key}")))
            .flex()
            .items_center()
            .gap_3()
            .p_2()
            .rounded(radius::CARD)
            .hover({
                let fill = theme.raised.opacity(0.4);
                move |style| style.bg(fill)
            })
            .child(service_mark(&name, &key, theme))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().item().font_weight(FontWeight::SEMIBOLD).truncate().child(name))
                    .children(status.map(|(line, tone)| {
                        div()
                            .flex()
                            .items_center()
                            .gap_1()
                            .body()
                            .text_color(tone)
                            .when(state == State::Connected && !waiting_here, |row| {
                                row.child(icon("check", px(13.), tone))
                            })
                            .child(line)
                    }))
                    .children(accounts_line.map(|line| div().body().text_color(theme.ink_secondary).child(line))),
            )
            .child(action)
            .into_any_element()
    }
}

impl super::Store {
    fn signing_in(&self, attempt: u64) -> bool {
        self.sign_in.as_ref().is_some_and(|sign_in| sign_in.attempt == attempt)
    }
}

/// An app's mark: its initial on its own colour, as plugins have.
pub(super) fn service_mark(name: &str, key: &str, theme: &Theme) -> Div {
    let initial: String =
        name.chars().find(|letter| letter.is_alphanumeric()).into_iter().flat_map(char::to_uppercase).collect();
    div()
        .size(px(40.))
        .flex_shrink_0()
        .rounded(radius::FIELD)
        .bg(theme.identity_for(key))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(18.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(gpui_kit::white())
        .child(initial)
}
