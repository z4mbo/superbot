use std::collections::HashMap;

use superbot_features::local_cli::{InstalledModel, LocalCli};

use super::Desktop;

type Selection = Result<Option<InstalledModel>, &'static str>;

#[derive(Default)]
pub(super) struct LocalModels {
    by_bot: HashMap<String, Selection>,
}

impl LocalModels {
    pub(super) fn read_if_unknown(&mut self, bot: &str, cli: &LocalCli) {
        self.by_bot.entry(bot.to_owned()).or_insert_with(|| cli.selection(bot));
    }

    pub(super) fn selection(&self, bot: &str) -> Result<Option<&InstalledModel>, &'static str> {
        self.by_bot.get(bot).map_or(Ok(None), |model| model.as_ref().map(Option::as_ref).map_err(|err| *err))
    }

    fn asleep(&self, bot: &str, needs_model: bool) -> bool {
        needs_model && self.selection(bot).ok().flatten().is_none()
    }
}

impl Desktop {
    pub(super) fn read_roster_models(&mut self) {
        if let (Some(space), Some(cli)) = (self.space.as_ref(), self.local_cli()) {
            for agent in &space.bots {
                self.local_models.read_if_unknown(&agent.id, &cli);
            }
        }
    }

    // Read on explicit conversation switches and before sending, so a selection
    // saved by another instance is picked up without doing file I/O in render.
    pub(super) fn refresh_local_model(&mut self, bot: &str) {
        if let Some(cli) = self.local_cli() {
            self.local_models.by_bot.insert(bot.to_owned(), cli.selection(bot));
        }
    }

    pub(crate) fn remember_local_model(&mut self, bot: &str, selection: Option<InstalledModel>) {
        self.local_models.by_bot.insert(bot.to_owned(), Ok(selection));
    }

    pub(crate) fn local_model_for(&self, bot: &str) -> Option<&InstalledModel> {
        self.local_models.selection(bot).ok().flatten()
    }

    pub(crate) fn avatar_asleep(&self, bot: &str) -> bool {
        self.local_models.asleep(bot, self.me.as_ref().is_some_and(|me| me.needs_model))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use gpui_kit::{AppContext, WindowOptions};
    use serde_json::json;
    use superbot_avatars::face::FaceState;

    use super::*;
    use crate::api::{AgentSummary, Me, Target};
    use crate::app::Chat;
    use crate::fonts::Fonts;
    use crate::theme::{Skin, Theme};
    use crate::ui::face_state;

    #[test]
    fn each_roster_face_uses_its_own_bots_model_whichever_chat_is_open() {
        crate::test_support::headless(|cx| {
            gpui_kit::init(cx);
            Theme::of(Skin::Midnight, &Fonts { sans: "sans-serif".into(), mono: "monospace".into() }).install(cx);
            let window = cx
                .open_window(WindowOptions::default(), |window, cx| {
                    cx.new(|cx| Desktop::initial("http://127.0.0.1:1".into(), window, cx))
                })
                .unwrap();
            window
                .update(cx, |desktop, _, _| {
                    desktop.me = Some(
                        serde_json::from_value::<Me>(json!({
                            "email": "fixture@example.com", "name": "Fixture", "needsModel": true
                        }))
                        .unwrap(),
                    );
                    desktop.remember_local_model(
                        "a",
                        Some(InstalledModel {
                            provider: "fixture".into(),
                            id: "model".into(),
                            label: "Fixture model".into(),
                        }),
                    );
                    let agents = ["a", "b"].map(|id| {
                        serde_json::from_value::<AgentSummary>(json!({
                            "id": id, "name": id, "status": "idle"
                        }))
                        .unwrap()
                    });
                    for open in &agents {
                        desktop.chat = Some(Chat::new(Target::Agent(open.id.clone()), false));
                        let faces =
                            agents.each_ref().map(|bot| face_state(Some(bot), desktop.avatar_asleep(&bot.id), false));
                        assert_eq!(faces, [FaceState::Rest, FaceState::Asleep], "open chat: {}", open.id);
                    }
                })
                .unwrap();
        });
    }
}
