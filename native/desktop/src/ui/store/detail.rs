use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api;
use crate::app::Desktop;
use crate::theme::Theme;
use crate::ui::chrome::labelled_switch;
use crate::ui::releases::VersionSwitch;
use crate::ui::{chip, empty_line, pill_button, Tone, Type};

use super::app_view::{app_parts, humanize};
use super::confirm::Confirm;
use super::{back_button, count, part_card, plugin_mark};

impl Desktop {
    pub(super) fn uninstall(&mut self, installation_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else {
            self.store.settle_confirm();
            return;
        };
        let removed = installation_id.clone();
        let work = async move { api.uninstall_plugin(&space_id, &installation_id).await };
        self.call(window, cx, work, move |this, result, _, cx| {
            this.store.settle_confirm();
            match result {
                Ok(()) => {
                    this.store.installations.retain(|known| known.id != removed);
                    if this.store.app.as_ref().is_some_and(|app| app.installation_id == removed) {
                        this.store.app = None;
                    }
                }
                Err(error) => this.notify(api::explain(&error), true, None, cx),
            }
        });
        cx.notify();
    }

    fn toggle_grant(
        &mut self,
        installation_id: String,
        agent_id: String,
        part_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else {
            return;
        };
        let Some(installation) = self.store.installations.iter().find(|known| known.id == installation_id) else {
            return;
        };
        let mut parts: Vec<String> = installation
            .grants
            .iter()
            .filter(|grant| grant.bot_id == agent_id)
            .map(|grant| grant.part_id.clone())
            .collect();
        match parts.iter().position(|granted| granted == &part_id) {
            Some(index) => {
                parts.remove(index);
            }
            None => parts.push(part_id),
        }
        self.store.busy = Some(agent_id.clone());
        let work = async move { api.set_grants(&space_id, &installation_id, &agent_id, &parts).await };
        self.call(window, cx, work, |this, result, _, cx| {
            this.store.busy = None;
            match result {
                Ok(installation) => {
                    if let Some(known) = this.store.installations.iter_mut().find(|known| known.id == installation.id) {
                        *known = installation;
                    }
                }
                Err(error) => this.notify(api::explain(&error), true, None, cx),
            }
        });
        cx.notify();
    }

    pub(super) fn render_plugin_page(&mut self, slug: &str, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let installation = self.store.installation(slug).cloned();
        let version = installation.as_ref().map(|known| known.plugin.clone()).or_else(|| {
            let query = self.store.query.read(cx).value().trim().to_lowercase();
            self.store.latest(&query).into_iter().find(|version| version.slug == slug).cloned()
        });
        let back = back_button(theme).on_click(cx.listener(|this, _, _, cx| {
            this.store.detail = None;
            cx.notify();
        }));
        let Some(version) = version else {
            return div()
                .flex()
                .flex_col()
                .gap_3()
                .child(back)
                .child(empty_line("This plugin is no longer available.", theme))
                .into_any_element();
        };
        let busy = self.store.busy.clone();
        let mut opens: Vec<AnyElement> = Vec::new();
        if let Some(installation) = &installation {
            let parts: Vec<String> =
                app_parts(&installation.plugin.manifest.parts).map(|part| part.id().to_owned()).collect();
            let several = parts.len() > 1;
            for part_id in parts {
                let label = if several { format!("Open {}", humanize(&part_id)) } else { "Open".to_owned() };
                let installation = installation.clone();
                let id = SharedString::from(format!("open-app-{part_id}"));
                opens.push(
                    pill_button(id, label, Tone::Primary, true, theme)
                        .on_click(
                            cx.listener(move |this, _, window, cx| this.open_app(&installation, &part_id, window, cx)),
                        )
                        .into_any_element(),
                );
            }
        }
        let action = match &installation {
            Some(installation) => {
                let (id, name) = (installation.id.clone(), installation.plugin.manifest.name.clone());
                let has_records = app_parts(&installation.plugin.manifest.parts).next().is_some();
                pill_button("uninstall", "Uninstall", Tone::Danger, true, theme).on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.store.confirm =
                            Some(Confirm::Uninstall { installation_id: id.clone(), name: name.clone(), has_records });
                        cx.notify();
                    },
                ))
            }
            None => {
                let waiting = busy.as_deref() == Some(version.id.as_str());
                let version = version.clone();
                pill_button("install", if waiting { "Installing…" } else { "Install" }, Tone::Primary, !waiting, theme)
                    .on_click(cx.listener(move |this, _, window, cx| this.install(&version, window, cx)))
            }
        };

        let parts =
            div().flex().flex_col().gap_2().children(version.manifest.parts.iter().map(|part| part_card(part, theme)));

        let releases = self.store.releases(slug);
        let pin = installation
            .as_ref()
            .filter(|pinned| releases.iter().any(|release| release.id != pinned.plugin.id))
            .map(|pinned| {
                let installation_id = pinned.id.clone();
                let current = pinned.plugin.clone();
                div().flex().flex_col().gap_2().child(div().section().child("Version")).child(
                    div().flex().flex_wrap().gap_2().children(releases.iter().map(|release| {
                        let chosen = release.id == current.id;
                        let (installation_id, from, to) = (installation_id.clone(), current.clone(), release.clone());
                        chip(
                            SharedString::from(format!("release-{}", release.id)),
                            format!("Version {}", release.version),
                            chosen,
                            theme,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !chosen {
                                this.store.version_switch = Some(VersionSwitch {
                                    installation_id: installation_id.clone(),
                                    from: from.clone(),
                                    to: to.clone(),
                                    busy: false,
                                });
                                cx.notify();
                            }
                        }))
                    })),
                )
            });

        let access = installation.map(|installation| {
            let agents = self.agents().to_vec();
            let rows: Vec<AnyElement> = agents
                .into_iter()
                .map(|agent| {
                    let waiting = busy.as_deref() == Some(agent.id.as_str());
                    div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .py_1p5()
                        .when(waiting, |row| row.opacity(0.6))
                        .child(self.roster_avatar(&agent, px(28.), theme, cx))
                        .child(div().w(px(180.)).flex_shrink_0().name().truncate().child(agent.name.clone()))
                        .child(div().flex_1().flex().flex_wrap().gap_1p5().children(
                            installation.plugin.manifest.parts.iter().map(|part| {
                                let part_id = part.id().to_owned();
                                let granted = installation
                                    .grants
                                    .iter()
                                    .any(|grant| grant.bot_id == agent.id && grant.part_id == part_id);
                                let (installation_id, agent_id) = (installation.id.clone(), agent.id.clone());
                                let label = humanize(&part_id);
                                let button = div().id(SharedString::from(format!("grant-{agent_id}-{part_id}")));
                                let button = button.when(!waiting, |button| {
                                    button.on_click(cx.listener(move |this, _, window, cx| {
                                        this.toggle_grant(
                                            installation_id.clone(),
                                            agent_id.clone(),
                                            part_id.clone(),
                                            window,
                                            cx,
                                        )
                                    }))
                                });
                                labelled_switch(button, label, granted, !waiting, theme)
                            }),
                        ))
                        .into_any_element()
                })
                .collect();
            div().flex().flex_col().gap_2().child(div().section().child("Agent access")).map(|section| {
                if rows.is_empty() {
                    section.child(empty_line("Create an agent, then choose what it can use here.", theme))
                } else {
                    section.child(div().flex().flex_col().children(rows))
                }
            })
        });

        div()
            .id("plugin-page")
            .size_full()
            .overflow_y_scroll()
            .pb_8()
            .flex()
            .flex_col()
            .gap_6()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(back)
                    .child(plugin_mark(&version, px(48.), theme))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(div().title().truncate().child(version.manifest.name.clone()))
                            .child(div().meta().text_color(theme.ink_tertiary).child(format!(
                                "{} · Version {} · {}",
                                version.slug,
                                version.version,
                                count(version.manifest.parts.len(), "part")
                            ))),
                    )
                    .child(action)
                    .children(opens),
            )
            .child(div().item().text_color(theme.ink_secondary).child(version.manifest.description.clone()))
            .children(pin)
            .children(access)
            .child(div().flex().flex_col().gap_2().child(div().section().child("What it adds")).child(parts))
            .into_any_element()
    }
}
