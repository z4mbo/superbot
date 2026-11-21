use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::*;
use serde::Deserialize;
use serde_json::json;

use super::{Desktop, Panel};
use crate::api::{self, Target};

/// The server's bounds for a group chat's roster and name.
pub const GROUP_MEMBER_MIN: usize = 2;
const GROUP_NAME_MAX_LENGTH: usize = 80;

pub struct GroupForm {
    pub name: Entity<InputState>,
    pub department: Entity<InputState>,
    pub picked: Vec<String>,
    pub busy: bool,
    pub error: Option<String>,
    _submit: [Subscription; 2],
}

#[derive(Deserialize)]
struct Made {
    id: String,
}

/// The picked agents' names joined in pick order, cut to the server's limit, as the server's
/// own clients name an unnamed group chat.
pub fn default_group_name(names: &[String]) -> String {
    names.join(", ").trim().chars().take(GROUP_NAME_MAX_LENGTH).collect::<String>().trim().to_owned()
}

/// What the create button says for `count` picked agents.
pub fn create_group_label(count: usize) -> String {
    match count {
        0 => "Create group chat".into(),
        1 => "Create group chat · 1 bot".into(),
        _ => format!("Create group chat · {count} bots"),
    }
}

impl Desktop {
    pub fn open_group_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name =
            cx.new(|cx| InputState::new(window, cx).placeholder("Group chat name (for example, Website launch)"));
        let department =
            cx.new(|cx| InputState::new(window, cx).placeholder("Department (optional): Work, Personal, Client…"));
        let submit = [&name, &department].map(|input| {
            cx.subscribe_in(input, window, |this, _, event: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    this.create_group(window, cx);
                }
            })
        });
        self.begin_modal(window, cx);
        name.update(cx, |input, cx| input.focus(window, cx));
        self.create.panel = Some(Panel::Group(GroupForm {
            name,
            department,
            picked: Vec::new(),
            busy: false,
            error: None,
            _submit: submit,
        }));
        cx.notify();
    }

    pub fn create_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(Panel::Group(form)) = self.create.panel.as_ref() else { return };
        if form.busy || form.picked.len() < GROUP_MEMBER_MIN {
            return;
        }
        let picked = form.picked.clone();
        let typed = form.name.read(cx).value().trim().to_owned();
        let department = form.department.read(cx).value().trim().to_owned();
        let names: Vec<String> =
            picked.iter().filter_map(|id| self.agent(id).map(|agent| agent.name.clone())).collect();
        let name = if typed.is_empty() { default_group_name(&names) } else { typed };
        if let Some(Panel::Group(form)) = self.create.panel.as_mut() {
            form.busy = true;
            form.error = None;
        }
        let work = async move {
            let group: Made =
                api.client.rpc("groups/create", Some(&space_id), json!({ "name": name, "botIds": picked })).await?;
            if !department.is_empty() {
                api.client
                    .rpc::<serde_json::Value>(
                        "botSections/create",
                        Some(&space_id),
                        json!({ "groupId": group.id, "name": department }),
                    )
                    .await?;
            }
            Ok((group.id, api.navigation(Some(&space_id)).await?))
        };
        self.call(window, cx, work, |this, result, window, cx| match result {
            Ok((group_id, navigation)) => {
                this.create.panel = None;
                this.apply_navigation(navigation);
                this.open(Target::Group(group_id), window, cx);
            }
            Err(error) => {
                if let Some(Panel::Group(form)) = this.create.panel.as_mut() {
                    form.busy = false;
                    form.error = Some(api::explain(&error));
                }
            }
        });
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{create_group_label, default_group_name};

    #[test]
    fn an_unnamed_group_chat_is_named_after_its_agents_in_pick_order() {
        assert_eq!(default_group_name(&["Scout".into(), "Pixel".into()]), "Scout, Pixel");
        let long: Vec<String> = (0..20).map(|index| format!("Agent {index}")).collect();
        assert_eq!(default_group_name(&long).chars().count(), 80);
    }

    #[test]
    fn the_create_button_counts_the_picked_agents() {
        assert_eq!(create_group_label(0), "Create group chat");
        assert_eq!(create_group_label(1), "Create group chat · 1 bot");
        assert_eq!(create_group_label(3), "Create group chat · 3 bots");
    }
}
