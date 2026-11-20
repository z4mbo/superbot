use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::*;
use serde::Deserialize;
use serde_json::json;

use super::{Desktop, Panel};
use crate::api;

const DEPARTMENT_NAME_MAX_LENGTH: usize = 60;

pub struct DepartmentForm {
    pub name: Entity<InputState>,
    pub picked: Vec<String>,
    pub busy: bool,
    pub error: Option<String>,
    _submit: Subscription,
}

#[derive(Deserialize)]
struct Section {
    name: String,
}

enum Saved {
    Done(api::Navigation, usize),
    Duplicate,
}

impl Desktop {
    pub fn open_department_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = cx.new(|cx| InputState::new(window, cx));
        let submit = cx.subscribe_in(&name, window, |this, _, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { .. } => this.create_department(window, cx),
            InputEvent::Change => cx.notify(),
            _ => {}
        });
        name.update(cx, |input, cx| input.focus(window, cx));
        self.create.panel = Some(Panel::Department(DepartmentForm {
            name,
            picked: Vec::new(),
            busy: false,
            error: None,
            _submit: submit,
        }));
        cx.notify();
    }

    /// A Superbot department is named by the agents filed under it, so it needs at least one.
    pub fn create_department(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(Panel::Department(form)) = self.create.panel.as_mut() else { return };
        let name: String = form.name.read(cx).value().trim().chars().take(DEPARTMENT_NAME_MAX_LENGTH).collect();
        if form.busy || name.is_empty() || form.picked.is_empty() {
            return;
        }
        let picked = form.picked.clone();
        form.busy = true;
        form.error = None;
        let department = name.clone();
        let work = async move {
            let sections: Vec<Section> = api.client.rpc("botSections/list", Some(&space_id), json!({})).await?;
            if sections.iter().any(|section| section.name == department) {
                return Ok(Saved::Duplicate);
            }
            for bot_id in &picked {
                api.client
                    .rpc::<serde_json::Value>(
                        "botSections/create",
                        Some(&space_id),
                        json!({ "botId": bot_id, "name": department }),
                    )
                    .await?;
            }
            Ok(Saved::Done(api.navigation(Some(&space_id)).await?, picked.len()))
        };
        self.call(window, cx, work, move |this, result, _, cx| {
            let failure = match result {
                Ok(Saved::Done(navigation, moved)) => {
                    this.create.panel = None;
                    this.apply_navigation(navigation);
                    let bots = if moved == 1 { "1 bot".to_owned() } else { format!("{moved} bots") };
                    this.notify(format!("Created {name} with {bots}"), false, None, cx);
                    return;
                }
                Ok(Saved::Duplicate) => "A department with that name already exists.".to_owned(),
                Err(error) => api::explain(&error),
            };
            if let Some(Panel::Department(form)) = this.create.panel.as_mut() {
                form.busy = false;
                form.error = Some(failure);
            }
        });
        cx.notify();
    }
}
