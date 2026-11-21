use gpui_kit::*;

use crate::app::create::CreateRow;
use crate::app::Desktop;
use crate::theme::{radius, ActiveTheme, Theme, SIDEBAR_WIDTH};
use crate::ui::focus;
use crate::ui::motion::{Colors, Pointer};
use crate::ui::overlays::menu_enter;
use crate::ui::{icon, Type};

/// Where the sheet hangs: right-aligned with the sidebar's plus button, 6px under it.
fn anchor() -> Point<Pixels> {
    point(SIDEBAR_WIDTH - px(17.), px(54.))
}

pub fn menu_shadow(theme: &Theme) -> Vec<BoxShadow> {
    let shadow = |alpha: f32, y: f32, blur: f32, spread: f32| BoxShadow {
        color: hsla(0., 0., if theme.is_dark() { 0. } else { 0.11 }, alpha),
        offset: point(px(0.), px(y)),
        blur_radius: px(blur),
        spread_radius: px(spread),
        inset: false,
    };
    if theme.is_dark() {
        vec![shadow(0.7, 14., 32., -10.), shadow(0.35, 2., 8., 0.)]
    } else {
        vec![shadow(0.1, 10., 20., -3.), shadow(0.1, 4., 6., -4.)]
    }
}

impl Desktop {
    /// The plus button's menu: what can be made from here.
    pub fn render_new_menu(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let fills = Colors::ink(&theme, 0., 0.06, 0.08);
        let highlight = self.create.highlight;
        let agent = self.chat.as_ref().and_then(|chat| chat.target.agent()).and_then(|id| self.agent(id)).map(|agent| agent.name.clone());
        let rows = self.create_rows().into_iter().enumerate().flat_map(|(index, row)| {
            let label = match (row, &agent) {
                (CreateRow::NewConversation, Some(name)) => format!("New conversation with {name}"),
                _ => row.label().to_owned(),
            };
            let item = div()
                .id(row.id())
                .h(px(30.))
                .px_2()
                .flex()
                .items_center()
                .gap_2()
                .rounded(radius::MENU_ROW)
                .item()
                .line_height(px(18.))
                .text_color(theme.ink)
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, window, cx| this.choose_create_row(row, window, cx)))
                .child(icon(row.glyph(), px(16.), theme.ink_secondary))
                .child(div().flex_1().min_w_0().truncate().child(label));
            let item = focus::decorate(item).fill(Pointer::MENU.held(highlight == Some(index)), fills).into_any_element();
            let separator = (row == CreateRow::NewConversation)
                .then(|| div().my_0p5().mx_1().h(px(1.)).bg(theme.hairline.opacity(0.5)).into_any_element());
            std::iter::once(item).chain(separator)
        });
        let mut sheet = div()
            .id("new-menu")
            .min_w(px(200.))
            .p(px(6.))
            .flex()
            .flex_col()
            .gap_1()
            .rounded(radius::CARD)
            .bg(theme.menu)
            .border_1()
            .border_color(theme.hairline.opacity(0.5))
            .shadow(menu_shadow(&theme))
            .occlude()
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.new_menu_key(&event.keystroke.key, window, cx);
            }))
            .children(rows);
        if let Some(focus) = self.create.menu_focus.as_ref() {
            sheet = sheet.track_focus(focus);
        }
        let sheet = menu_enter("new-menu-enter", sheet, cx, |sheet, remaining| {
            sheet.relative().top(px(-4. * remaining))
        });
        div()
            .id("menu-backdrop")
            .absolute()
            .inset_0()
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.close_menu(window, cx);
                    cx.notify();
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, _, window, cx| {
                    this.close_menu(window, cx);
                    cx.notify();
                }),
            )
            .child(
                deferred(
                    anchored()
                        .position(anchor())
                        .anchor(Anchor::TopRight)
                        .snap_to_window_with_margin(px(8.))
                        .child(sheet),
                )
                .with_priority(1),
            )
            .into_any_element()
    }
}
