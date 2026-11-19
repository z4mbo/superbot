use gpui_kit::prelude::*;
use gpui_kit::{div, px, Div, SharedString, Window};
use superbot_features::{
    model_options, Bot, BotSettings, ConnectionAuth, MainModel, ModelCatalogEntry, ModelConnection,
    ModelOption, ModelSelection,
};

use crate::icons::{icon, Glyph};
use crate::panel::{detail_header, placeholder, section_header, Loaded, WorkspacePanel};
use crate::sections::model_connect::ConnectForm;
use crate::theme::{tokens, Tokens, RADIUS_FULL};
use crate::ui::{self, Action, Row, Tone};

/// Where the Models section is: what is connected and used, the providers to
/// connect, or one provider's connection form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Page {
    Overview,
    Providers,
    Connect {
        provider: String,
        preset: Option<String>,
    },
}

/// Whose model a picker is choosing.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Picking {
    Main,
    Agent(String),
}

pub(crate) struct ModelsView {
    pub(crate) catalog: Loaded<Vec<ModelCatalogEntry>>,
    pub(crate) connections: Loaded<Vec<ModelConnection>>,
    pub(crate) main: Loaded<MainModel>,
    pub(crate) page: Page,
    pub(crate) form: ConnectForm,
    picking: Option<Picking>,
    saving: Option<Picking>,
    confirm_disconnect: Option<String>,
    disconnecting: Option<String>,
    problem: Option<SharedString>,
}

impl ModelsView {
    pub(crate) fn new(window: &mut Window, cx: &mut gpui_kit::App) -> Self {
        Self {
            catalog: Loaded::default(),
            connections: Loaded::default(),
            main: Loaded::default(),
            page: Page::Overview,
            form: ConnectForm::new(window, cx),
            picking: None,
            saving: None,
            confirm_disconnect: None,
            disconnecting: None,
            problem: None,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.catalog = Loaded::default();
        self.connections = Loaded::default();
        self.main = Loaded::default();
        self.close();
    }

    pub(crate) fn close(&mut self) {
        self.page = Page::Overview;
        self.picking = None;
        self.saving = None;
        self.confirm_disconnect = None;
        self.problem = None;
        self.form.leave();
    }

    /// Nothing can answer an agent yet: no connection and no deployment model.
    pub(crate) fn needs_setup(&self) -> bool {
        let unconnected = self.connections.value.as_ref().is_some_and(Vec::is_empty);
        let nothing_runs = self
            .main
            .value
            .as_ref()
            .is_some_and(|main| main.running().is_none());
        unconnected && nothing_runs
    }

    pub(crate) fn options(&self) -> Vec<ModelOption> {
        match (&self.connections.value, &self.catalog.value) {
            (Some(connections), Some(catalog)) => model_options(connections, catalog),
            _ => Vec::new(),
        }
    }

    /// The name a model is shown by: its option, its catalog entry, else its id.
    fn model_name(&self, options: &[ModelOption], provider: &str, model_id: &str) -> String {
        options
            .iter()
            .find(|option| option.is(provider, model_id))
            .map(|option| option.label.clone())
            .or_else(|| {
                self.catalog
                    .value
                    .iter()
                    .flatten()
                    .find(|entry| entry.provider == provider && entry.id == model_id)
                    .map(|entry| entry.label.clone())
            })
            .unwrap_or_else(|| model_id.to_owned())
    }
}

/// The web app's model settings for `space_id`, where account sign-ins finish.
/// The address carries no session; the browser signs in by itself.
pub(crate) fn web_models_url(server: &str, space_id: &str) -> String {
    format!(
        "{}/app?settings=models&space={space_id}",
        server.trim_end_matches('/')
    )
}

pub(crate) fn glyph_plate(glyph: Glyph, t: &Tokens) -> Div {
    div()
        .size(px(32.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(RADIUS_FULL)
        .bg(t.raised)
        .child(icon(glyph, 16., t.ink_secondary))
}

impl WorkspacePanel {
    pub(crate) fn load_models(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.models.catalog.loading {
            self.models.catalog.begin();
            let remote = self.remote.clone();
            self.request(
                window,
                cx,
                async move { remote.space().model_catalog().await },
                |panel, catalog, _, _| panel.models.catalog.finish(catalog),
            );
        }
        if !self.models.connections.loading {
            self.models.connections.begin();
            let remote = self.remote.clone();
            self.request(
                window,
                cx,
                async move { remote.space().model_connections().await },
                |panel, connections, _, _| panel.models.connections.finish(connections),
            );
        }
        if !self.models.main.loading {
            self.models.main.begin();
            let remote = self.remote.clone();
            self.request(
                window,
                cx,
                async move { remote.space().main_model().await },
                |panel, main, _, _| panel.models.main.finish(main),
            );
        }
    }

    pub(crate) fn open_web_models(&self, cx: &mut Context<Self>) {
        cx.open_url(&web_models_url(
            self.remote.client().server(),
            self.remote.space_id(),
        ));
    }

    fn toggle_picker(&mut self, picking: Picking, cx: &mut Context<Self>) {
        let view = &mut self.models;
        view.picking = (view.picking.as_ref() != Some(&picking)).then_some(picking);
        view.problem = None;
        view.confirm_disconnect = None;
        cx.notify();
    }

    fn choose_main(&mut self, option: ModelOption, window: &mut Window, cx: &mut Context<Self>) {
        if self.models.saving.is_some() {
            return;
        }
        self.models.saving = Some(Picking::Main);
        self.models.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().set_main_model(&option).await },
            move |panel, main, _, cx| {
                panel.models.saving = None;
                match main {
                    Ok(main) => {
                        panel.models.main.value = Some(main);
                        panel.models.picking = None;
                        panel.toast("Main model changed.", None, cx);
                    }
                    Err(failure) => {
                        panel.models.problem =
                            Some(failure.sentence("change the main model").into());
                    }
                }
            },
        );
    }

    fn choose_agent_model(
        &mut self,
        bot_id: String,
        option: Option<ModelOption>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.models.saving.is_some() {
            return;
        }
        self.models.saving = Some(Picking::Agent(bot_id.clone()));
        self.models.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let model = match &option {
                    Some(option) => ModelSelection::set(&option.provider, &option.model_id),
                    None => ModelSelection::clear(),
                };
                let settings = BotSettings {
                    model: Some(model),
                    ..Default::default()
                };
                remote.space().update_bot(&bot_id, &settings).await
            },
            |panel, bot, _, _| {
                panel.models.saving = None;
                match bot {
                    Ok(bot) => {
                        panel.replace_bot(bot);
                        panel.models.picking = None;
                    }
                    Err(failure) => {
                        panel.models.problem =
                            Some(failure.sentence("change this agent's model").into());
                    }
                }
            },
        );
    }

    fn disconnect(
        &mut self,
        connection: ModelConnection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.models.confirm_disconnect = None;
        self.models.disconnecting = Some(connection.id.clone());
        self.models.problem = None;
        let remote = self.remote.clone();
        let (provider, id) = (connection.provider.clone(), connection.id.clone());
        self.request(
            window,
            cx,
            async move { remote.space().disconnect_model(&provider, &id).await },
            move |panel, removed, window, cx| {
                panel.models.disconnecting = None;
                match removed {
                    Ok(()) => {
                        panel.toast(format!("Disconnected {}.", connection.label), None, cx);
                        panel.load_models(window, cx);
                        panel.load_bots(window, cx);
                    }
                    Err(failure) => {
                        panel.models.problem = Some(failure.sentence("disconnect it").into());
                    }
                }
            },
        );
    }

    pub(crate) fn render_models(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let t = tokens(cx);
        match self.models.page.clone() {
            Page::Providers => {
                let back = Action::icon("models-back", Glyph::ChevronLeft, "Back").on_click(
                    cx.listener(|panel, _, _, cx| {
                        panel.models.close();
                        cx.notify();
                    }),
                );
                return div()
                    .flex()
                    .flex_col()
                    .child(detail_header("Connect a model", back, [], &t))
                    .child(self.render_providers(&t, window, cx));
            }
            Page::Connect { provider, preset } => {
                return self.render_connect(&provider, preset.as_deref(), &t, window, cx);
            }
            Page::Overview => {}
        }

        let retry = Action::new("retry-models", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_models(window, cx)));
        let waiting = [
            placeholder(
                &self.models.connections,
                "see your model connections",
                retry,
                &t,
            ),
            self.models
                .main
                .value
                .is_none()
                .then(|| ui::loading_line(&t)),
            self.models
                .catalog
                .value
                .is_none()
                .then(|| ui::loading_line(&t)),
        ]
        .into_iter()
        .flatten()
        .next();
        if let Some(waiting) = waiting {
            return div()
                .flex()
                .flex_col()
                .child(section_header("Models", [], &t))
                .child(waiting);
        }

        if self.models.needs_setup() {
            return div()
                .flex()
                .flex_col()
                .child(section_header("Models", [], &t))
                .child(div().pb_3().child(ui::body(
                    "Agents need a model before they can reply. Connect one to start.",
                    t.ink_secondary,
                )))
                .child(self.render_providers(&t, window, cx));
        }

        let connect = Action::new("connect-model", "Connect a model")
            .tone(Tone::Primary)
            .glyph(Glyph::Plus)
            .on_click(cx.listener(|panel, _, window, cx| {
                panel.models.close();
                panel.models.page = Page::Providers;
                panel.models.form.clear_filter(window, cx);
                cx.notify();
            }));
        let options = self.models.options();
        div()
            .flex()
            .flex_col()
            .gap_6()
            .child(section_header("Models", [connect], &t).pb_0())
            .when_some(self.models.problem.clone(), |this, problem| {
                this.child(ui::problem_line(problem, &t))
            })
            .child(self.render_main(&options, &t, cx))
            .children(self.render_agents(&options, &t, cx))
            .child(self.render_connections(&t, cx))
    }

    fn option_rows(
        &self,
        id: &'static str,
        options: &[ModelOption],
        current: Option<(&str, &str)>,
        t: &Tokens,
        choose: impl Fn(&mut Self, ModelOption, &mut Window, &mut Context<Self>) + Clone + 'static,
        cx: &mut Context<Self>,
    ) -> Vec<Row> {
        options
            .iter()
            .enumerate()
            .map(|(index, option)| {
                let chosen = current.is_some_and(|(p, m)| option.is(p, m));
                let picked = option.clone();
                let choose = choose.clone();
                Row::new(
                    SharedString::from(format!("{id}-{index}")),
                    option.label.clone(),
                )
                .detail(option.source.clone())
                .when(chosen, |row| row.trailing(icon(Glyph::Check, 16., t.ink)))
                .on_click(cx.listener(move |panel, _, window, cx| {
                    choose(panel, picked.clone(), window, cx)
                }))
            })
            .collect()
    }

    fn render_main(&self, options: &[ModelOption], t: &Tokens, cx: &mut Context<Self>) -> Div {
        let view = &self.models;
        let running = view.main.value.as_ref().and_then(MainModel::running);
        let (title, detail) = match running {
            Some(choice) => {
                let pinned = choice.credential_id.as_deref().and_then(|id| {
                    view.connections
                        .value
                        .iter()
                        .flatten()
                        .find(|connection| connection.id == id)
                        .map(|connection| connection.label.clone())
                });
                let source = pinned.or_else(|| {
                    options
                        .iter()
                        .find(|option| option.is(&choice.provider, &choice.model_id))
                        .map(|option| option.source.clone())
                });
                (
                    view.model_name(options, &choice.provider, &choice.model_id),
                    source.unwrap_or_default(),
                )
            }
            None => ("Not chosen".to_owned(), String::new()),
        };
        let open = view.picking == Some(Picking::Main);
        let row = Row::new("main-model", title)
            .leading(glyph_plate(Glyph::Cpu, t))
            .detail(detail)
            .trailing(
                Action::new("change-main-model", if open { "Done" } else { "Change" })
                    .small()
                    .disabled(options.is_empty())
                    .on_click(
                        cx.listener(|panel, _, _, cx| panel.toggle_picker(Picking::Main, cx)),
                    ),
            );
        let current = running.map(|choice| (choice.provider.as_str(), choice.model_id.as_str()));
        let picker = open.then(|| {
            div().flex().flex_col().children(self.option_rows(
                "main-option",
                options,
                current,
                t,
                |panel, option, window, cx| panel.choose_main(option, window, cx),
                cx,
            ))
        });
        div()
            .flex()
            .flex_col()
            .gap_1p5()
            .child(ui::group_label("Main model", t))
            .child(
                ui::card(t)
                    .p_2()
                    .gap_0()
                    .child(row)
                    .when_some(picker, |this, picker| {
                        this.child(div().px_2().child(ui::divider(t))).child(picker)
                    }),
            )
            .child(ui::meta("Agents use it unless they have their own.", t))
    }

    fn render_agents(
        &self,
        options: &[ModelOption],
        t: &Tokens,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        let bots = self.bots.value.as_ref().filter(|bots| !bots.is_empty())?;
        let rows = bots
            .iter()
            .map(|bot| self.render_agent(bot, options, t, cx));
        Some(
            div()
                .flex()
                .flex_col()
                .gap_1p5()
                .child(ui::group_label("Agents", t))
                .children(rows),
        )
    }

    fn render_agent(
        &self,
        bot: &Bot,
        options: &[ModelOption],
        t: &Tokens,
        cx: &mut Context<Self>,
    ) -> Div {
        let view = &self.models;
        let own = bot.model_provider.as_deref().zip(bot.model_id.as_deref());
        let detail = match own {
            Some((provider, model_id)) => view.model_name(options, provider, model_id),
            None => "Main model".to_owned(),
        };
        let picking = Picking::Agent(bot.id.clone());
        let open = view.picking.as_ref() == Some(&picking);
        let saving = view.saving.as_ref() == Some(&picking);
        let toggle = picking.clone();
        let row = Row::new(
            SharedString::from(format!("agent-model-{}", bot.id)),
            bot.name.clone(),
        )
        .leading(ui::bot_face(t.identity_for(&bot.color), 32.))
        .detail(detail)
        .trailing(
            Action::new(
                SharedString::from(format!("change-agent-model-{}", bot.id)),
                if open { "Done" } else { "Change" },
            )
            .small()
            .busy(saving)
            .disabled(options.is_empty())
            .on_click(cx.listener(move |panel, _, _, cx| panel.toggle_picker(toggle.clone(), cx))),
        );
        let picker = open.then(|| {
            let bot_id = bot.id.clone();
            let follow = Row::new(
                SharedString::from(format!("agent-main-{}", bot.id)),
                "Main model",
            )
            .when(own.is_none(), |row| {
                row.trailing(icon(Glyph::Check, 16., t.ink))
            })
            .on_click(cx.listener(move |panel, _, window, cx| {
                panel.choose_agent_model(bot_id.clone(), None, window, cx)
            }));
            let bot_id = bot.id.clone();
            let rows = self.option_rows(
                "agent-option",
                options,
                own,
                t,
                move |panel, option, window, cx| {
                    panel.choose_agent_model(bot_id.clone(), Some(option), window, cx)
                },
                cx,
            );
            ui::card(t)
                .p_2()
                .gap_0()
                .ml(px(42.))
                .child(follow)
                .children(rows)
        });
        div().flex().flex_col().gap_1().child(row).children(picker)
    }

    fn render_connections(&self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let view = &self.models;
        let connections = view.connections.value.as_deref().unwrap_or_default();
        let rows = connections.iter().map(|connection| {
            let server = connection.auth_kind == Some(ConnectionAuth::OpenaiCompatible)
                || connection.base_url.is_some();
            let detail = match (&connection.base_url, connection.auth_kind) {
                (Some(url), _) => connection
                    .endpoint_name
                    .clone()
                    .unwrap_or_else(|| url.clone()),
                (None, Some(ConnectionAuth::Oauth)) => "Account sign-in".to_owned(),
                (None, _) => "API key".to_owned(),
            };
            let row = Row::new(
                SharedString::from(format!("connection-{}", connection.id)),
                connection.label.clone(),
            )
            .leading(glyph_plate(
                if server {
                    Glyph::Server
                } else {
                    Glyph::KeyRound
                },
                t,
            ))
            .detail(detail);
            let row = if connection.reconnect_required {
                row.trailing(
                    Action::new(
                        SharedString::from(format!("reconnect-{}", connection.id)),
                        "Sign in again",
                    )
                    .tone(Tone::Link)
                    .small()
                    .glyph(Glyph::ExternalLink)
                    .on_click(cx.listener(|panel, _, _, cx| panel.open_web_models(cx))),
                )
            } else {
                row
            };
            if view.confirm_disconnect.as_deref() == Some(connection.id.as_str()) {
                let removing = connection.clone();
                return row
                    .trailing(
                        Action::new("confirm-disconnect", "Disconnect")
                            .tone(Tone::Danger)
                            .small()
                            .on_click(cx.listener(move |panel, _, window, cx| {
                                panel.disconnect(removing.clone(), window, cx)
                            })),
                    )
                    .trailing(Action::new("keep-connection", "Keep").small().on_click(
                        cx.listener(|panel, _, _, cx| {
                            panel.models.confirm_disconnect = None;
                            cx.notify();
                        }),
                    ));
            }
            let id = connection.id.clone();
            row.trailing(
                Action::icon(
                    SharedString::from(format!("disconnect-{}", connection.id)),
                    Glyph::Trash,
                    format!("Disconnect {}", connection.label),
                )
                .small()
                .busy(view.disconnecting.as_deref() == Some(connection.id.as_str()))
                .on_click(cx.listener(move |panel, _, _, cx| {
                    panel.models.confirm_disconnect = Some(id.clone());
                    panel.models.picking = None;
                    cx.notify();
                })),
            )
        });
        div()
            .flex()
            .flex_col()
            .gap_1p5()
            .child(ui::group_label("Connections", t))
            .children(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_ins_finish_in_the_same_space_of_the_web_app() {
        assert_eq!(
            web_models_url("http://127.0.0.1:5173/", "space-1"),
            "http://127.0.0.1:5173/app?settings=models&space=space-1"
        );
    }
}
