mod import;
mod templates;

use gpui_kit::component::input::{Input, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::AgentSummary;
use crate::app::create::{create_group_label, DepartmentForm, GroupForm, Panel, GROUP_MEMBER_MIN};
use crate::app::Desktop;
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::{bot_avatar, error_line, icon, Type};

/// The dimmed window behind a create panel; a click on it closes the panel unless it is saving.
pub(super) fn scrim(theme: &Theme, cx: &mut Context<Desktop>) -> Stateful<Div> {
    div()
        .id("create-scrim")
        .absolute()
        .inset_0()
        .p_4()
        .flex()
        .items_center()
        .justify_center()
        .bg(theme.scrim)
        .occlude()
        .on_click(cx.listener(|this, _, _, cx| this.dismiss_create_panel(cx)))
}

/// The reference's quiet field: no frame, a raised fill, the placeholder naming it.
pub(super) fn soft_field(state: &Entity<InputState>, theme: &Theme) -> Div {
    div()
        .min_h_9()
        .px_3()
        .flex()
        .items_center()
        .rounded(radius::FIELD)
        .bg(theme.raised.opacity(0.7))
        .item()
        .child(Input::new(state).appearance(false).bordered(false))
}

pub(super) fn framed_field(state: &Entity<InputState>, theme: &Theme) -> Div {
    div()
        .min_h_9()
        .px_3()
        .flex()
        .items_center()
        .rounded(radius::FIELD)
        .bg(theme.inset)
        .border_1()
        .border_color(theme.hairline.opacity(0.5))
        .item()
        .child(Input::new(state).appearance(false).bordered(false))
}

/// The reference's filled accent button.
pub(super) fn accent_button(
    id: &'static str,
    label: impl Into<SharedString>,
    enabled: bool,
    theme: &Theme,
) -> Stateful<Div> {
    let hover = theme.accent.opacity(0.9);
    div()
        .id(id)
        .h_9()
        .px_4()
        .flex()
        .items_center()
        .justify_center()
        .gap_2()
        .rounded(radius::FIELD)
        .bg(theme.accent)
        .text_color(gpui_kit::white())
        .body()
        .font_weight(FontWeight::MEDIUM)
        .when(enabled, |button| button.cursor_pointer().hover(move |style| style.bg(hover)))
        .when(!enabled, |button| button.opacity(0.4))
        .child(label.into())
}

pub(super) fn quiet_button(
    id: &'static str,
    label: impl Into<SharedString>,
    enabled: bool,
    theme: &Theme,
) -> Stateful<Div> {
    let hover = theme.raised;
    div()
        .id(id)
        .h_9()
        .px_3()
        .flex()
        .items_center()
        .gap_1p5()
        .rounded(radius::FIELD)
        .body()
        .text_color(theme.ink_secondary)
        .when(enabled, |button| button.cursor_pointer().hover(move |style| style.bg(hover)))
        .when(!enabled, |button| button.opacity(0.5))
        .child(label.into())
}

pub(super) fn icon_button(id: &'static str, glyph: &'static str, size: Pixels, theme: &Theme) -> Stateful<Div> {
    let hover = theme.raised;
    div().id(id).p_1p5().rounded(radius::FIELD).cursor_pointer().hover(move |style| style.bg(hover)).child(icon(
        glyph,
        size,
        theme.ink_secondary,
    ))
}

impl Desktop {
    pub fn render_create_panel(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.skin().clone();
        let panel = match self.create.panel.as_ref()? {
            Panel::Group(form) => self.render_group_form(form, &theme, cx),
            Panel::Department(form) => self.render_department_form(form, &theme, cx),
            Panel::Templates(templates) => self.render_templates(templates, &theme, cx),
            Panel::Import(import) => self.render_import(import, &theme, cx),
        };
        Some(scrim(&theme, cx).child(panel).into_any_element())
    }

    fn render_picker(
        &self,
        picked: &[String],
        empty: &'static str,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let agents: Vec<AgentSummary> = self.agents().to_vec();
        if agents.is_empty() {
            return div()
                .px_2()
                .py_4()
                .text_center()
                .body()
                .text_color(theme.ink_secondary)
                .child(empty)
                .into_any_element();
        }
        let hover = theme.raised.opacity(0.5);
        let rows = agents.into_iter().map(|agent| {
            let chosen = picked.contains(&agent.id);
            let id = agent.id.clone();
            let mark = div()
                .size(px(18.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .border_1()
                .map(|mark| {
                    if chosen {
                        mark.bg(theme.accent).border_color(theme.accent).child(icon(
                            "check",
                            px(12.),
                            gpui_kit::white(),
                        ))
                    } else {
                        mark.border_color(theme.hairline.opacity(0.6))
                    }
                });
            div()
                .id(SharedString::from(format!("pick-{}", agent.id)))
                .px_2()
                .py_1p5()
                .flex()
                .items_center()
                .gap_2p5()
                .rounded(radius::FIELD)
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .on_click(cx.listener(move |this, _, _, cx| this.toggle_pick(id.clone(), cx)))
                .child(bot_avatar(agent.avatar(), px(28.), false, None, theme, cx))
                .child(div().flex_1().min_w_0().truncate().item().text_color(theme.ink).child(agent.name.clone()))
                .child(mark)
        });
        div()
            .id("create-picker")
            .max_h(px(256.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_0p5()
            .children(rows)
            .into_any_element()
    }

    fn render_group_form(&self, form: &GroupForm, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let count = form.picked.len();
        let ready = count >= GROUP_MEMBER_MIN && !form.busy;
        let label = if form.busy { "Creating…".to_owned() } else { create_group_label(count) };
        div()
            .id("group-form")
            .w(px(340.))
            .p_4()
            .flex()
            .flex_col()
            .rounded(px(16.))
            .bg(theme.card)
            .border_1()
            .border_color(theme.hairline.opacity(0.5))
            .shadow(theme.float_shadow())
            .on_click(|_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .mb_3()
                    .text_size(px(15.))
                    .line_height(px(20.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("New group chat"),
            )
            .child(div().mb_3().child(soft_field(&form.name, theme)))
            .child(div().mb_3().child(soft_field(&form.department, theme)))
            .child(self.render_picker(&form.picked, "Create a bot first. Group chats are made of bots.", theme, cx))
            .when(count == 1, |panel| {
                panel.child(div().mt_2().meta().text_color(theme.ink_tertiary).child("Pick at least two bots."))
            })
            .children(form.error.clone().map(|error| div().mt_3().child(error_line(error, theme))))
            .child(
                accent_button("create-group", label, ready, theme)
                    .mt_3()
                    .w_full()
                    .on_click(cx.listener(|this, _, window, cx| this.create_group(window, cx))),
            )
            .into_any_element()
    }

    fn render_department_form(&self, form: &DepartmentForm, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let named = !form.name.read(cx).value().trim().is_empty();
        let ready = named && !form.picked.is_empty() && !form.busy;
        div()
            .id("department-form")
            .w_full()
            .max_w(px(430.))
            .p_5()
            .flex()
            .flex_col()
            .rounded(px(16.))
            .bg(theme.panel)
            .border_1()
            .border_color(theme.hairline.opacity(0.5))
            .shadow(theme.float_shadow())
            .on_click(|_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .mb_3()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .child(
                        div()
                            .text_size(px(17.))
                            .line_height(px(24.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Create department"),
                    )
                    .child(
                        icon_button("department-close", "x", px(18.), theme)
                            .on_click(cx.listener(|this, _, _, cx| this.dismiss_create_panel(cx))),
                    ),
            )
            .child(
                div()
                    .mb_3()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().body().text_color(theme.ink_secondary).child("Department name"))
                    .child(framed_field(&form.name, theme)),
            )
            .child(div().mb_3().body().text_color(theme.ink_secondary).child("Choose existing bots to move here."))
            .child(
                div()
                    .mb_1()
                    .meta()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink_secondary)
                    .child("Existing bots"),
            )
            .child(self.render_picker(&form.picked, "No bots to move yet. Create a bot first.", theme, cx))
            .children(form.error.clone().map(|error| div().mt_3().child(error_line(error, theme))))
            .child(
                div()
                    .mt_4()
                    .flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        quiet_button("department-cancel", "Cancel", !form.busy, theme)
                            .on_click(cx.listener(|this, _, _, cx| this.dismiss_create_panel(cx))),
                    )
                    .child(
                        accent_button(
                            "department-create",
                            if form.busy { "Saving…" } else { "Create department" },
                            ready,
                            theme,
                        )
                        .on_click(cx.listener(|this, _, window, cx| this.create_department(window, cx))),
                    ),
            )
            .into_any_element()
    }
}
