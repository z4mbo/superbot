use gpui_kit::prelude::*;
use gpui_kit::{div, Div, SharedString, Window};
use superbot_features::local_acp;
use superbot_features::local_cli::{InstalledModel, LocalCli, Provider, Status};

use crate::icons::{icon, Glyph};
use crate::panel::WorkspacePanel;
use crate::theme::Tokens;
use crate::ui::{self, Action, Row, Toggle, Tone};

pub(super) fn local_sign_in(connection: &str) -> Option<&'static str> {
    match connection {
        "openai-codex" => Some("codex"),
        "anthropic" => Some("claude"),
        "github-copilot" => Some("githubCopilot"),
        "xai" => Some("grok"),
        _ => None,
    }
}

#[derive(Default)]
pub(crate) struct LocalConnection {
    pub(crate) cli: Option<LocalCli>,
    checked: std::collections::HashMap<&'static str, LocalProbe>,
    busy: Option<&'static str>,
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
    problem: Option<String>,
}

#[derive(Default)]
struct LocalProbe {
    status: Option<Status>,
    detail: Option<&'static str>,
    models: Vec<InstalledModel>,
    runnable: bool,
}

#[derive(Clone, Copy)]
enum LocalAction {
    Check,
    SignIn,
    SignOut,
}

#[derive(Clone, Copy)]
enum LocalProvider {
    Direct(Provider),
    Acp(&'static local_acp::Provider),
}

impl LocalProvider {
    fn id(self) -> &'static str {
        match self {
            Self::Direct(provider) => provider.id(),
            Self::Acp(provider) => provider.id,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Direct(provider) => provider.name(),
            Self::Acp(provider) => provider.label,
        }
    }

    fn sign_in_label(self) -> Option<&'static str> {
        match self {
            Self::Direct(provider) => Some(provider.sign_in_label()),
            Self::Acp(provider) => provider.interactive_sign_in.then_some("Sign in"),
        }
    }

    async fn check(self, cli: LocalCli, action: LocalAction) -> Result<LocalProbe, String> {
        Ok(match self {
            Self::Direct(provider) => {
                let status = match action {
                    LocalAction::Check => cli.status(provider).await,
                    LocalAction::SignIn => cli.sign_in(provider).await?,
                    LocalAction::SignOut => cli.sign_out(provider).await?,
                };
                let mut probe = LocalProbe {
                    status: Some(status),
                    ..LocalProbe::default()
                };
                if status == Status::Ready {
                    match cli.catalog(provider).await {
                        Ok(models) => {
                            probe.runnable = !models.is_empty();
                            probe.models = models;
                            if !probe.runnable {
                                probe.detail = Some("The installed CLI returned no models.");
                            }
                        }
                        Err(_) => probe.detail = Some("Couldn't read the installed model catalog."),
                    }
                }
                probe
            }
            Self::Acp(provider) => {
                let engine =
                    if provider.disposition == local_acp::Disposition::LocalConfiguration {
                        local_acp::load_custom(
                            &LocalCli::config_dir().ok_or("Local configuration is unavailable.")?,
                        )
                    } else {
                        local_acp::discover(provider.id)
                    }
                    .map_err(|_| "Couldn't read the local CLI configuration.")?;
                let Some(engine) = engine else {
                    return Ok(LocalProbe {
                        status: Some(Status::Missing),
                        detail: (provider.disposition
                            == local_acp::Disposition::LocalConfiguration)
                            .then_some("Local ACP configuration missing."),
                        ..LocalProbe::default()
                    });
                };
                if matches!(action, LocalAction::SignIn) {
                    engine
                        .sign_in()
                        .await
                        .map_err(|_| "Provider sign-in didn't finish.")?;
                }
                let probe = engine
                    .probe()
                    .await
                    .map_err(|_| "Couldn't verify the installed CLI.")?;
                let runnable = !probe.needs_auth && engine.safe_to_run().await.unwrap_or(false);
                LocalProbe {
                    status: Some(if probe.needs_auth {
                        Status::SignedOut
                    } else {
                        Status::Ready
                    }),
                    detail: if probe.needs_auth {
                        provider.sign_in
                    } else if !runnable {
                        Some("Catalog available. Restricted local turns are unavailable.")
                    } else if probe.models.is_empty() {
                        Some("The installed CLI returned no models.")
                    } else {
                        None
                    },
                    models: probe
                        .models
                        .into_iter()
                        .map(|model| InstalledModel {
                            provider: provider.id.to_owned(),
                            id: model.id,
                            label: model.label,
                        })
                        .collect(),
                    runnable,
                }
            }
        })
    }
}

impl WorkspacePanel {
    fn check_local_cli(
        &mut self,
        provider: LocalProvider,
        action: LocalAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let local = &mut self.models.local;
        if local.busy.is_some() {
            return;
        }
        let Some(cli) = local.cli.clone() else { return };
        local.busy = Some(provider.id());
        local.problem = None;
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        local.cancel = Some(cancel);
        self.request(
            window,
            cx,
            async move {
                Ok(tokio::select! {
                    result = provider.check(cli, action) => Some(result),
                    _ = cancelled => None,
                })
            },
            move |panel, result, _, _| {
                let local = &mut panel.models.local;
                local.busy = None;
                local.cancel = None;
                match result {
                    Ok(Some(Ok(probe))) => {
                        local.checked.insert(provider.id(), probe);
                    }
                    Ok(Some(Err(problem))) => {
                        local.checked.remove(provider.id());
                        local.problem = Some(problem);
                    }
                    Ok(None) => {}
                    Err(_) => local.problem = Some("Couldn't check the local CLI.".into()),
                }
            },
        );
        cx.notify();
    }

    pub(crate) fn choose_local_model(
        &mut self,
        bot: &str,
        model: Option<&InstalledModel>,
        cx: &mut Context<Self>,
    ) {
        let local = &mut self.models.local;
        let Some(cli) = &local.cli else { return };
        local.problem = cli.save_selection(bot, model).err().map(str::to_owned);
        cx.notify();
    }

    pub(crate) fn local_choice(&self, bot: &str) -> Option<InstalledModel> {
        self.models
            .local
            .cli
            .as_ref()?
            .selection(bot)
            .ok()
            .flatten()
    }

    pub(crate) fn render_local_options(
        &self,
        bot: &str,
        t: &Tokens,
        cx: &mut Context<Self>,
    ) -> Div {
        let current = self.local_choice(bot);
        let mut providers: Vec<_> = self.models.local.checked.iter().collect();
        providers.sort_unstable_by_key(|(id, _)| **id);
        let rows = providers
            .into_iter()
            .flat_map(|(_, probe)| {
                probe
                    .models
                    .iter()
                    .map(move |model| (model, probe.runnable))
            })
            .map(|(model, runnable)| {
                let selected = current.as_ref() == Some(model);
                let bot = bot.to_owned();
                let pick = model.clone();
                Row::new(
                    SharedString::from(format!("local-{}-{}", model.provider, model.id)),
                    model.label.clone(),
                )
                .detail("On this computer")
                .when(selected, |row| row.trailing(icon(Glyph::Check, 16., t.ink)))
                .when(runnable, |row| {
                    row.on_click(cx.listener(move |panel, _, _, cx| {
                        panel.choose_local_model(&bot, Some(&pick), cx)
                    }))
                })
            });
        let clear = current.as_ref().map(|_| {
            let bot = bot.to_owned();
            Action::new("clear-local-agent-model", "Use workspace model")
                .small()
                .on_click(
                    cx.listener(move |panel, _, _, cx| panel.choose_local_model(&bot, None, cx)),
                )
        });
        div().flex().flex_col().children(rows).children(clear)
    }

    pub(crate) fn render_local_connection(&self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let local = &self.models.local;
        if local.cli.is_none() {
            return div();
        }
        let direct = Provider::ALL.into_iter().map(LocalProvider::Direct);
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
            .map(LocalProvider::Acp);
        ui::card(t)
            .child(ui::group_label("On this computer", t))
            .children(
                direct
                    .chain(acp)
                    .map(|provider| self.render_local_provider(provider, t, cx)),
            )
            .when_some(local.problem.clone(), |card, problem| {
                card.child(ui::problem_line(problem, t))
            })
    }

    fn render_local_provider(
        &self,
        provider: LocalProvider,
        t: &Tokens,
        cx: &mut Context<Self>,
    ) -> Div {
        let local = &self.models.local;
        let probe = local.checked.get(provider.id());
        let status = probe.and_then(|probe| probe.status);
        let codex = matches!(provider, LocalProvider::Direct(Provider::Codex));
        let account = local
            .cli
            .as_ref()
            .filter(|_| codex)
            .map(LocalCli::uses_installed_codex);
        let manage_sign_in = account.as_ref().is_none_or(|mode| *mode == Ok(false));
        let sign_in = provider
            .sign_in_label()
            .filter(|_| manage_sign_in && status == Some(Status::SignedOut));
        let sign_out = manage_sign_in
            && matches!(provider, LocalProvider::Direct(_))
            && status == Some(Status::Ready);
        let busy = local.busy == Some(provider.id());
        let disabled = local.busy.is_some();
        let detail = probe
            .and_then(|probe| probe.detail)
            .or_else(|| status.map(Status::label));
        let id = |action| SharedString::from(format!("local-{action}-{}", provider.id()));
        let row = ui::setting_row(
            provider.label(),
            detail.map(Into::into),
            div()
                .flex()
                .gap_2()
                .when_some(sign_in, |actions, label| {
                    actions.child(
                        Action::new(id("sign-in"), label)
                            .tone(Tone::Primary)
                            .disabled(disabled)
                            .on_click(cx.listener(move |panel, _, window, cx| {
                                panel.check_local_cli(provider, LocalAction::SignIn, window, cx)
                            })),
                    )
                })
                .when(sign_out, |actions| {
                    actions.child(
                        Action::new(id("sign-out"), "Sign out")
                            .disabled(disabled)
                            .on_click(cx.listener(move |panel, _, window, cx| {
                                panel.check_local_cli(provider, LocalAction::SignOut, window, cx)
                            })),
                    )
                })
                .when(busy, |actions| {
                    actions.child(Action::new(id("cancel"), "Cancel").on_click(cx.listener(
                        |panel, _, _, _| {
                            if let Some(cancel) = panel.models.local.cancel.take() {
                                let _ = cancel.send(());
                            }
                        },
                    )))
                })
                .child(
                    Action::new(id("check"), "Check")
                        .busy(busy)
                        .disabled(disabled)
                        .on_click(cx.listener(move |panel, _, window, cx| {
                            panel.check_local_cli(provider, LocalAction::Check, window, cx)
                        })),
                ),
            t,
        );
        div().child(row).when_some(account, |rows, mode| {
            let label = "Use installed Codex sign-in";
            rows.child(ui::setting_row(
                label,
                mode.err().map(Into::into),
                Toggle::new("local-codex-account", label, mode == Ok(true))
                    .disabled(disabled)
                    .on_change(cx.listener(move |panel, installed: &bool, window, cx| {
                        let local = &mut panel.models.local;
                        let Some(cli) = &local.cli else { return };
                        match cli.choose_installed_codex(*installed) {
                            Ok(()) => {
                                local.checked.remove(provider.id());
                                panel.check_local_cli(provider, LocalAction::Check, window, cx);
                            }
                            Err(problem) => {
                                local.problem = Some(problem.into());
                                cx.notify();
                            }
                        }
                    })),
                t,
            ))
        })
    }
}
