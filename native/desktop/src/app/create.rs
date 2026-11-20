mod department;
pub mod folder;
mod group;
mod import;
mod templates;

use gpui_kit::*;

pub use department::DepartmentForm;
pub use group::{create_group_label, GroupForm, GROUP_MEMBER_MIN};
pub use import::{Busy as ImportBusy, Import, ImportStep, PlanItem};
pub use templates::{Template, Templates};

use super::{Desktop, MenuKind};
use crate::api::AgentSummary;

/// What the sidebar's plus button makes, in the reference's Simple order.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CreateRow {
    NewBot,
    NewGroupChat,
    AddDepartment,
    Templates,
    Import,
}

impl CreateRow {
    pub const ALL: [CreateRow; 5] =
        [CreateRow::NewBot, CreateRow::NewGroupChat, CreateRow::AddDepartment, CreateRow::Templates, CreateRow::Import];

    pub fn label(self) -> &'static str {
        match self {
            CreateRow::NewBot => "New bot",
            CreateRow::NewGroupChat => "New group chat",
            CreateRow::AddDepartment => "Add department",
            CreateRow::Templates => "Templates",
            CreateRow::Import => "Import…",
        }
    }

    pub fn glyph(self) -> &'static str {
        match self {
            CreateRow::NewBot => "bot",
            CreateRow::NewGroupChat => "users",
            CreateRow::AddDepartment => "folder-plus",
            CreateRow::Templates => "layout-template",
            CreateRow::Import => "folder-input",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            CreateRow::NewBot => "new-bot",
            CreateRow::NewGroupChat => "new-group-chat",
            CreateRow::AddDepartment => "add-department",
            CreateRow::Templates => "templates",
            CreateRow::Import => "import",
        }
    }
}

/// The row the arrow keys land on from `from`, wrapping like the reference menu.
pub fn step_highlight(from: Option<usize>, key: &str, rows: usize) -> Option<usize> {
    if rows == 0 {
        return None;
    }
    match key {
        "down" => Some(from.map_or(0, |index| (index + 1) % rows)),
        "up" => Some(from.map_or(rows - 1, |index| (index + rows - 1) % rows)),
        "home" => Some(0),
        "end" => Some(rows - 1),
        _ => from,
    }
}

pub enum Panel {
    Group(GroupForm),
    Department(DepartmentForm),
    Templates(Templates),
    Import(Import),
}

impl Panel {
    fn busy(&self) -> bool {
        match self {
            Panel::Group(form) => form.busy,
            Panel::Department(form) => form.busy,
            Panel::Templates(templates) => templates.busy,
            Panel::Import(import) => import.busy.is_some(),
        }
    }
}

#[derive(Default)]
pub struct Create {
    pub panel: Option<Panel>,
    /// The plus menu row the arrow keys are on.
    pub highlight: Option<usize>,
    pub menu_focus: Option<FocusHandle>,
    /// Agents made from this window, newest first, with their Space. The list shows them on top
    /// as the reference does; the server's order returns when the app starts again.
    arrivals: Vec<(String, String)>,
}

/// Puts `arrivals` (newest first) at the top; every other agent keeps the server's order.
pub fn arrivals_first(bots: &mut Vec<AgentSummary>, arrivals: &[&str]) {
    let mut front = Vec::with_capacity(bots.len());
    for id in arrivals {
        if let Some(index) = bots.iter().position(|bot| bot.id == *id) {
            front.push(bots.remove(index));
        }
    }
    front.append(bots);
    *bots = front;
}

impl Desktop {
    pub fn open_new_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.create.highlight = None;
        self.open_menu(MenuKind::New, Point::default(), cx);
        if self.menu.as_ref().is_some_and(|menu| menu.kind == MenuKind::New) {
            let focus = self.create.menu_focus.get_or_insert_with(|| cx.focus_handle()).clone();
            focus.focus(window, cx);
        }
    }

    pub fn create_rows(&self) -> &'static [CreateRow] {
        &CreateRow::ALL
    }

    pub fn choose_create_row(&mut self, row: CreateRow, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        self.create.highlight = None;
        match row {
            CreateRow::NewBot => self.new_agent(window, cx),
            CreateRow::NewGroupChat => self.open_group_form(window, cx),
            CreateRow::AddDepartment => self.open_department_form(window, cx),
            CreateRow::Templates => self.open_templates(window, cx),
            CreateRow::Import => self.open_import(cx),
        }
        cx.notify();
    }

    /// Arrow keys, Home and End move through the plus menu; Enter or Space chooses the row.
    pub fn new_menu_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let rows = self.create_rows();
        if matches!(key, "enter" | "space") {
            if let Some(row) = self.create.highlight.and_then(|index| rows.get(index).copied()) {
                self.choose_create_row(row, window, cx);
            }
            return;
        }
        let next = step_highlight(self.create.highlight, key, rows.len());
        if next != self.create.highlight {
            self.create.highlight = next;
            cx.notify();
        }
    }

    /// Records an agent made here so the list shows it first, and reorders the list at once.
    pub fn arrived(&mut self, space_id: &str, agent_id: &str) {
        self.create.arrivals.retain(|(_, id)| id != agent_id);
        self.create.arrivals.insert(0, (space_id.to_owned(), agent_id.to_owned()));
        self.place_arrivals();
    }

    pub fn place_arrivals(&mut self) {
        let Some(space) = self.space.as_mut() else { return };
        let here: Vec<&str> = self
            .create
            .arrivals
            .iter()
            .filter(|(space_id, _)| *space_id == space.id)
            .map(|(_, id)| id.as_str())
            .collect();
        if !here.is_empty() {
            arrivals_first(&mut space.bots, &here);
        }
    }

    /// Closes the open create panel unless it is saving. Escape uses this.
    pub fn close_create_panel(&mut self) -> bool {
        match &mut self.create.panel {
            Some(Panel::Templates(templates)) if !templates.busy && templates.review.is_some() => {
                templates.review = None;
                templates.error = None;
                true
            }
            Some(panel) if !panel.busy() => {
                self.create.panel = None;
                true
            }
            _ => false,
        }
    }

    pub fn dismiss_create_panel(&mut self, cx: &mut Context<Self>) {
        if self.close_create_panel() {
            cx.notify();
        }
    }

    /// Ticks or unticks an agent in the open group chat or department form.
    pub fn toggle_pick(&mut self, agent_id: String, cx: &mut Context<Self>) {
        let picked = match self.create.panel.as_mut() {
            Some(Panel::Group(form)) if !form.busy => &mut form.picked,
            Some(Panel::Department(form)) if !form.busy => &mut form.picked,
            _ => return,
        };
        match picked.iter().position(|id| *id == agent_id) {
            Some(index) => {
                picked.remove(index);
            }
            None => picked.push(agent_id),
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{arrivals_first, step_highlight, CreateRow};
    use crate::api::AgentSummary;

    fn agent(id: &str) -> AgentSummary {
        serde_json::from_value(serde_json::json!({ "id": id, "name": id })).unwrap()
    }

    #[test]
    fn the_menu_lists_the_reference_rows_in_order() {
        let labels: Vec<&str> = CreateRow::ALL.iter().map(|row| row.label()).collect();
        assert_eq!(labels, ["New bot", "New group chat", "Add department", "Templates", "Import…"]);
    }

    #[test]
    fn arrow_keys_wrap_around_the_menu() {
        assert_eq!(step_highlight(None, "down", 5), Some(0));
        assert_eq!(step_highlight(None, "up", 5), Some(4));
        assert_eq!(step_highlight(Some(4), "down", 5), Some(0));
        assert_eq!(step_highlight(Some(0), "up", 5), Some(4));
        assert_eq!(step_highlight(Some(2), "home", 5), Some(0));
        assert_eq!(step_highlight(Some(2), "end", 5), Some(4));
        assert_eq!(step_highlight(Some(2), "a", 5), Some(2));
    }

    #[test]
    fn agents_made_here_come_first_newest_first_and_the_rest_keep_their_order() {
        let mut bots: Vec<AgentSummary> = ["a", "b", "new1", "c", "new2"].into_iter().map(agent).collect();
        arrivals_first(&mut bots, &["new2", "new1", "gone"]);
        let ids: Vec<&str> = bots.iter().map(|bot| bot.id.as_str()).collect();
        assert_eq!(ids, ["new2", "new1", "a", "b", "c"]);
    }
}
