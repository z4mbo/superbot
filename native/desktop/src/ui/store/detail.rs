use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api;
use crate::app::Desktop;
use crate::theme::Theme;
use crate::ui::releases::VersionSwitch;
use crate::ui::{agent_face, chip, empty_line, icon, pill_button, Tone, Type};

use super::{back_button, count, part_card, plugin_mark};

impl Desktop {
    fn uninstall(&mut self, installation_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else {
            return;
        };
        self.store.busy = Some(installation_id.clone());
        let removed = installation_id.clone();
        let work = async move { api.uninstall_plugin(&space_id, &installation_id).await };
        self.call(window, cx, work, move |this, result, _, cx| {
            this.store.busy = None;
            match result {
                Ok(()) => this.store.installations.retain(|known| known.id != removed),
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
        let action = match &installation {
            Some(installation) => {
                let waiting = busy.as_deref() == Some(installation.id.as_str());
                let id = installation.id.clone();
                pill_button("uninstall", if waiting { "Removing…" } else { "Uninstall" }, Tone::Danger, !waiting, theme)
                    .on_click(cx.listener(move |this, _, window, cx| this.uninstall(id.clone(), window, cx)))
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
                        .child(agent_face(theme.identity_for(&agent.color), px(28.)))
                        .child(div().w(px(180.)).flex_shrink_0().name().truncate().child(agent.name.clone()))
                        .child(div().flex_1().flex().flex_wrap().gap_1p5().children(
                            installation.plugin.manifest.parts.iter().map(|part| {
                                let part_id = part.id().to_owned();
                                let granted = installation
                                    .grants
                                    .iter()
                                    .any(|grant| grant.bot_id == agent.id && grant.part_id == part_id);
                                let (installation_id, agent_id) = (installation.id.clone(), agent.id.clone());
                                grant_toggle(&agent.id, &part_id, granted, theme).on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.toggle_grant(
                                            installation_id.clone(),
                                            agent_id.clone(),
                                            part_id.clone(),
                                            window,
                                            cx,
                                        )
                                    },
                                ))
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
                    .child(action),
            )
            .child(div().item().text_color(theme.ink_secondary).child(version.manifest.description.clone()))
            .children(pin)
            .children(access)
            .child(div().flex().flex_col().gap_2().child(div().section().child("What it adds")).child(parts))
            .into_any_element()
    }
}

fn grant_toggle(agent_id: &str, part_id: &str, granted: bool, theme: &Theme) -> Stateful<Div> {
    let hover = theme.raised_hover;
    div()
        .id(SharedString::from(format!("grant-{agent_id}-{part_id}")))
        .h_7()
        .px_2p5()
        .flex()
        .items_center()
        .gap_1p5()
        .rounded_full()
        .body()
        .cursor_pointer()
        .map(|toggle| {
            if granted {
                toggle.bg(theme.ink).text_color(theme.app).font_weight(FontWeight::MEDIUM).child(icon(
                    "check",
                    px(13.),
                    theme.app,
                ))
            } else {
                toggle
                    .bg(theme.control.opacity(0.7))
                    .text_color(theme.ink_secondary)
                    .hover(move |style| style.bg(hover))
            }
        })
        .child(part_id.to_owned())
}
