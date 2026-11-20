use gpui_kit::*;

use crate::app::Desktop;
use crate::theme::{radius, ActiveTheme};
use crate::ui::{pill_button, Tone, Type};

/// A change that cannot be undone, waiting for the person to confirm it.
#[derive(Clone)]
pub enum Confirm {
    Uninstall { installation_id: String, name: String, has_records: bool },
    RemoveRecord { record_id: String, label: String },
    Disconnect { name: String, connection_ids: Vec<String> },
    DisconnectSource { name: String, source: super::presets::Source },
    RemovePlugin { install_id: String, name: String },
}

impl Desktop {
    /// Leaves things as they are. False when nothing was waiting or the change is on its way.
    pub fn cancel_store_confirm(&mut self) -> bool {
        if self.store.confirm.is_some() && !self.store.confirming {
            self.store.confirm = None;
            true
        } else {
            false
        }
    }

    fn confirmed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(confirm) = self.store.confirm.clone().filter(|_| !self.store.confirming) else { return };
        self.store.confirming = true;
        match confirm {
            Confirm::Uninstall { installation_id, .. } => self.uninstall(installation_id, window, cx),
            Confirm::RemoveRecord { record_id, .. } => self.remove_record(record_id, window, cx),
            Confirm::Disconnect { connection_ids, .. } => self.disconnect(connection_ids, window, cx),
            Confirm::DisconnectSource { source, .. } => self.disconnect_source(source, window, cx),
            Confirm::RemovePlugin { install_id, .. } => self.remove_plugin(install_id, window, cx),
        }
        cx.notify();
    }

    pub fn render_store_confirm(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.skin().clone();
        let confirm = self.store.confirm.as_ref()?;
        let busy = self.store.confirming;
        let (title, body, action, acting) = match confirm {
            Confirm::Uninstall { name, has_records, .. } => (
                format!("Uninstall {name}?"),
                if *has_records {
                    "Everything saved in it, in every version, is deleted for good, and agents lose access to it."
                        .to_owned()
                } else {
                    "Agents lose access to it. You can install it again later.".to_owned()
                },
                "Uninstall",
                "Removing…",
            ),
            Confirm::RemoveRecord { label, .. } => (
                "Remove this entry?".to_owned(),
                if label.is_empty() {
                    "It is deleted for good.".to_owned()
                } else {
                    format!("“{label}” is deleted for good.")
                },
                "Remove",
                "Removing…",
            ),
            Confirm::Disconnect { name, connection_ids } => (
                format!("Disconnect {name}?"),
                if connection_ids.len() > 1 {
                    format!("All {} accounts are signed out, and agents can no longer use them.", connection_ids.len())
                } else {
                    "The account is signed out, and agents can no longer use it.".to_owned()
                },
                "Disconnect",
                "Disconnecting…",
            ),
            Confirm::RemovePlugin { name, .. } => (
                format!("Remove {name}?"),
                "Its connector and skills are removed, and agents can no longer use them.".to_owned(),
                "Remove",
                "Removing…",
            ),
            Confirm::DisconnectSource { name, .. } => (
                format!("Disconnect {name}?"),
                "Agents can no longer use it.".to_owned(),
                "Disconnect",
                "Disconnecting…",
            ),
        };
        Some(
            div()
                .id("store-confirm-scrim")
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.scrim)
                .occlude()
                .on_click(cx.listener(|this, _, _, cx| {
                    this.cancel_store_confirm();
                    cx.notify();
                }))
                .child(
                    div()
                        .id("store-confirm")
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
                        .child(div().title().child(title))
                        .child(div().item().text_color(theme.ink_secondary).child(body))
                        .child(
                            div()
                                .pt_2()
                                .flex()
                                .justify_end()
                                .gap_2()
                                .child(
                                    pill_button("store-confirm-cancel", "Cancel", Tone::Quiet, !busy, &theme).on_click(
                                        cx.listener(|this, _, _, cx| {
                                            this.cancel_store_confirm();
                                            cx.notify();
                                        }),
                                    ),
                                )
                                .child(
                                    pill_button(
                                        "store-confirm-action",
                                        if busy { acting } else { action },
                                        Tone::Danger,
                                        !busy,
                                        &theme,
                                    )
                                    .on_click(cx.listener(|this, _, window, cx| this.confirmed(window, cx))),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }
}
