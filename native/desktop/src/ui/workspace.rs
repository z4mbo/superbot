use gpui_kit::*;
use superbot_workspace_panel::{PanelEvent, Section, WorkspacePanel};

use crate::api::Target;
use crate::app::{Desktop, View};

#[derive(Default)]
pub struct Workspace {
    panel: Option<Entity<WorkspacePanel>>,
    _events: Option<Subscription>,
}

impl Desktop {
    pub fn load_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.workspace.panel.is_some() {
            return;
        }
        let (Some(api), Some(space)) = (&self.api, self.space_id()) else {
            return;
        };
        let panel = WorkspacePanel::build(api.client.clone(), space, Some(Section::People), window, cx);
        let local = self.local_cli();
        panel.update(cx, |panel, _| panel.set_local_cli(local));
        #[cfg(not(target_os = "macos"))]
        panel.update(cx, |panel, _| panel.set_caption_width(crate::theme::CAPTION_WIDTH));
        let events = cx.subscribe_in(&panel, window, |this, _, event: &PanelEvent, window, cx| match event {
            PanelEvent::OpenBot { bot_id } => this.open(Target::Agent(bot_id.clone()), window, cx),
            PanelEvent::OpenGroup { group_id } => this.open(Target::Group(group_id.clone()), window, cx),
            PanelEvent::BotsChanged | PanelEvent::GroupsChanged => this.reload_space(cx),
            PanelEvent::SpaceLeft { active_space_id } => this.switch_space(active_space_id.clone(), window, cx),
            PanelEvent::SpaceJoined { space_id } => this.switch_space(space_id.clone(), window, cx),
            PanelEvent::SessionExpired => this.session_ended(window, cx),
            PanelEvent::OpenWeb { path } => this.open_web_page(path, cx),
        });
        self.workspace = Workspace { panel: Some(panel), _events: Some(events) };
        cx.notify();
    }

    pub fn show_workspace_section(&mut self, section: Section, window: &mut Window, cx: &mut Context<Self>) {
        self.show(View::Workspace, window, cx);
        if let Some(panel) = &self.workspace.panel {
            panel.update(cx, |panel, cx| panel.show(section, window, cx));
        }
    }

    pub fn render_workspace(&self, _: &mut Window, _: &mut Context<Self>) -> AnyElement {
        div().size_full().children(self.workspace.panel.clone()).into_any_element()
    }

    pub(crate) fn set_workspace_visible(&mut self, visible: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = &self.workspace.panel {
            panel.update(cx, |panel, cx| panel.set_visible(visible, window, cx));
        }
    }
}
