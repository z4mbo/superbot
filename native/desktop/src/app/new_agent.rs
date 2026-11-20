use gpui_kit::*;

use super::Desktop;
use crate::api::{self, Target};

// The name list is adapted from OpenMausBot server/names.ts (fork z4mbo/bot, branch simple-only),
// Copyright 2026 Milind Soni and OpenMausBot contributors, Apache License 2.0.
const NAMES: &[&str] = &[
    "Scout", "Pixel", "Atlas", "Nova", "Juno", "Koda", "Miso", "Mochi", "Biscuit", "Pepper", "Clover", "Ember",
    "Willow", "Comet", "Orbit", "Echo", "Indigo", "Sage", "Zephyr", "Poppy", "Maple", "Cosmo", "Luna", "Otto", "Ivy",
    "Finch", "Wren", "Basil", "Hazel", "Nimbus", "Onyx", "Pearl", "Quill", "Rocket", "Sunny", "Tango", "Vega",
    "Waffle", "Ziggy", "Noodle", "Pickle", "Churro", "Panko", "Dumpling", "Pesto", "Olive", "Cocoa", "Taffy",
    "Bramble", "Fig", "Juniper", "Moss", "Pebble", "Rio", "Skye", "Tuli", "Ursa", "Yuki", "Zuko", "Momo", "Kiwi",
    "Plum", "Sprout", "Turnip",
];

/// A name from the list that no agent in the Space has, or "Name 2", "Name 3"… once all are taken.
/// `roll` picks among the candidates, so tests can fix it.
pub fn free_name<'a>(taken: impl IntoIterator<Item = &'a str>, roll: u64) -> String {
    let taken: Vec<String> = taken.into_iter().map(|name| name.trim().to_lowercase()).collect();
    let used = |name: &str| taken.iter().any(|other| *other == name.to_lowercase());
    let free: Vec<&str> = NAMES.iter().copied().filter(|name| !used(name)).collect();
    if !free.is_empty() {
        return free[(roll % free.len() as u64) as usize].to_owned();
    }
    let base = NAMES[(roll % NAMES.len() as u64) as usize];
    (2..).map(|count| format!("{base} {count}")).find(|name| !used(name)).expect("an unused number exists")
}

/// Ctrl+N on Windows and Linux, Cmd+N on macOS.
pub fn is_new_agent_shortcut(keystroke: &Keystroke) -> bool {
    let modifiers = &keystroke.modifiers;
    let command = if cfg!(target_os = "macos") { modifiers.platform } else { modifiers.control };
    keystroke.key == "n" && command && !modifiers.shift && !modifiers.alt
}

impl Desktop {
    pub fn creating_agent(&self) -> bool {
        self.creating_agent == Some(self.space_selection)
    }

    /// Makes an agent at once under a free name and opens its conversation, as New bot does in
    /// the reference; the server gives it its colour and its first message.
    pub fn new_agent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        if self.creating_agent() {
            cx.notify();
            return;
        }
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let name =
            free_name(self.agents().iter().map(|agent| agent.name.as_str()), uuid::Uuid::new_v4().as_u128() as u64);
        self.creating_agent = Some(self.space_selection);
        let space = space_id.clone();
        let work = async move {
            let agent = api.create_agent(&space, &name).await?;
            let navigation = api.navigation(Some(&space)).await?;
            Ok((agent, navigation))
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            this.creating_agent = None;
            match result {
                Ok((agent, navigation)) => {
                    this.apply_navigation(navigation);
                    this.arrived(&space_id, &agent.id);
                    this.open(Target::Agent(agent.id), window, cx);
                }
                Err(error) => this.notify(format!("Couldn't make a new bot: {}", api::explain(&error)), true, None, cx),
            }
        });
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{free_name, NAMES};

    #[test]
    fn a_new_agent_takes_a_name_nobody_in_the_space_has() {
        let taken: Vec<&str> = NAMES.iter().copied().filter(|name| *name != "Zuko").collect();
        assert_eq!(free_name(taken.iter().copied(), 7), "Zuko");
        assert_eq!(free_name([" zuko "].into_iter().chain(taken.iter().copied()), 0), "Scout 2");
    }

    #[test]
    fn numbered_names_skip_the_ones_already_used() {
        let mut taken: Vec<String> = NAMES.iter().map(|name| name.to_string()).collect();
        taken.push("Scout 2".into());
        assert_eq!(free_name(taken.iter().map(String::as_str), 0), "Scout 3");
    }
}
