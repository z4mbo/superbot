use gpui_kit::*;

use crate::app::{Desktop, Session, View};
use crate::theme::ActiveTheme;
#[cfg(not(target_os = "macos"))]
use crate::ui::overlays::caption_buttons;

impl Render for Desktop {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.skin().clone();
        let content = match self.session {
            Session::Restoring => self.render_restoring(cx),
            Session::SignedOut => self.render_sign_in(cx),
            Session::SignedIn => {
                let main = match self.view {
                    View::Chat => self.render_chat(window, cx),
                    View::Store => self.render_store(window, cx),
                    View::Workspace => self.render_workspace(window, cx),
                };
                self.sync_inbox(window, cx);
                let side = match self.render_inbox_panel(window, cx) {
                    Some(inbox) => Some(inbox),
                    None if self.view == View::Chat => self.render_agent_panel(window, cx),
                    None => None,
                };
                div()
                    .size_full()
                    .flex()
                    .child(self.render_sidebar(window, cx))
                    .child(div().flex_1().min_w_0().h_full().child(main))
                    .children(side)
                    .into_any_element()
            }
        };
        let frame = div()
            .id("desktop")
            .relative()
            .size_full()
            .bg(theme.app)
            .text_color(theme.ink)
            .font_family(theme.font.clone())
            .text_size(px(13.))
            .line_height(px(18.))
            .child(content);
        #[cfg(not(target_os = "macos"))]
        let frame = frame.child(caption_buttons(window, &theme));
        frame
            .children(self.render_menu(window, cx))
            .children(self.render_dialog(cx))
            .children(self.render_create_panel(cx))
            .children(self.render_version_switch(cx))
            .children(self.render_store_confirm(cx))
            .children(self.render_notice(cx))
    }
}
