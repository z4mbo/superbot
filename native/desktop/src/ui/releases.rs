use gpui_kit::*;
use superbot_client::Error;

use crate::api::{self, PluginVersion};
use crate::app::Desktop;
use crate::theme::{radius, ActiveTheme};
use crate::ui::{pill_button, Tone, Type};

/// A move to another approved version, waiting for the person to confirm it.
pub struct VersionSwitch {
    pub installation_id: String,
    pub from: PluginVersion,
    pub to: PluginVersion,
    pub busy: bool,
}

impl Desktop {
    fn switch_version(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(switch) = self.store.version_switch.as_mut().filter(|switch| !switch.busy) else { return };
        switch.busy = true;
        let (installation_id, from, to) = (switch.installation_id.clone(), switch.from.id.clone(), switch.to.id.clone());
        let version = switch.to.version;
        let work = async move {
            match api.switch_plugin_version(&space_id, &installation_id, &from, &to).await {
                Ok(installation) => Ok(Ok(installation)),
                // It was moved or removed meanwhile: read it again rather than guess.
                Err(Error::Server { status: 409, .. }) => {
                    Ok(Err(tokio::try_join!(api.installations(&space_id), api.discover(&space_id, None))?))
                }
                Err(error) => Err(error),
            }
        };
        self.call(window, cx, work, move |this, result, _, cx| {
            this.store.version_switch = None;
            match result {
                Ok(Ok(installation)) => {
                    match this.store.installations.iter_mut().find(|known| known.id == installation.id) {
                        Some(known) => *known = installation,
                        None => this.store.installations.push(installation),
                    }
                    this.notify(format!("Now on version {version}. Choose again which agents can use it."), false, None, cx);
                }
                Ok(Err((installations, catalog))) => {
                    this.store.installations = installations;
                    this.store.catalog = catalog;
                    this.notify("This plugin changed somewhere else. Check its version and try again.", true, None, cx);
                }
                Err(error) => this.notify(api::explain(&error), true, None, cx),
            }
        });
        cx.notify();
    }

    pub fn render_version_switch(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.skin().clone();
        let switch = self.store.version_switch.as_ref()?;
        let granted = self
            .store
            .installations
            .iter()
            .find(|known| known.id == switch.installation_id)
            .is_some_and(|known| !known.grants.is_empty());
        let consequence = if granted {
            "Your agents lose access to this plugin when it switches. Grant it again afterwards."
        } else {
            "No agent uses this plugin yet, so nothing else changes."
        };
        Some(
            div()
                .id("version-switch-scrim")
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.scrim)
                .occlude()
                .on_click(cx.listener(|this, _, _, cx| {
                    this.store.cancel_version_switch();
                    cx.notify();
                }))
                .child(
                    div()
                        .id("version-switch")
                        .w(px(420.))
                        .p_5()
                        .flex()
                        .flex_col()
                        .gap_3()
                        .rounded(radius::DIALOG)
                        .bg(theme.menu)
                        .border_1()
                        .border_color(theme.ink_at(0.1))
                        .shadow(theme.float_shadow())
                        .on_click(|_, _, cx| cx.stop_propagation())
                        .child(div().title().child(format!("Switch to version {}?", switch.to.version)))
                        .child(div().item().text_color(theme.ink_secondary).child(format!(
                            "{} moves from version {} to version {}. {consequence}",
                            switch.from.manifest.name, switch.from.version, switch.to.version
                        )))
                        .child(
                            div()
                                .pt_2()
                                .flex()
                                .justify_end()
                                .gap_2()
                                .child(
                                    pill_button("version-switch-cancel", "Keep current version", Tone::Quiet, !switch.busy, &theme).on_click(
                                        cx.listener(|this, _, _, cx| {
                                            this.store.cancel_version_switch();
                                            cx.notify();
                                        }),
                                    ),
                                )
                                .child(
                                    pill_button("version-switch-confirm", if switch.busy { "Switching…" } else { "Switch version" }, Tone::Danger, !switch.busy, &theme)
                                        .on_click(cx.listener(|this, _, window, cx| this.switch_version(window, cx))),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }
}
