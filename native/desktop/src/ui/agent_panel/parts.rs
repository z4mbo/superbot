use super::*;

pub(crate) fn round_button(id: &'static str, glyph: &'static str, active: bool, theme: &Theme) -> Stateful<Div> {
    let hover = theme.elevated_hover();
    div()
        .id(id)
        .size_9()
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .bg(if active { hover } else { theme.composer })
        .border_1()
        .border_color(theme.ink_at(0.06))
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .child(icon(glyph, px(16.), theme.ink))
}

pub(super) fn tabs(current: PanelTab, theme: &Theme, cx: &mut Context<Desktop>) -> Div {
    let tab = |id: &'static str, label: &'static str, tab: PanelTab, cx: &mut Context<Desktop>| {
        let chosen = tab == current;
        let ink = theme.ink;
        div()
            .id(id)
            .h(px(26.))
            .px_3()
            .flex()
            .items_center()
            .rounded_full()
            .body()
            .cursor_pointer()
            .map(|button| {
                if chosen {
                    button.bg(theme.ink_at(0.1)).font_weight(FontWeight::MEDIUM).text_color(theme.ink)
                } else {
                    button.text_color(theme.ink_secondary).hover(move |style| style.text_color(ink))
                }
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                if let Some(panel) = this.agent_panel.as_mut() {
                    panel.tab = tab;
                    panel.page = None;
                    panel.editing = None;
                    panel.screen = None;
                }
                this.sync_agent_info(window, cx);
                cx.notify();
            }))
            .child(label)
    };
    div().mt(px(15.)).pt_1().pb(px(10.)).flex().justify_center().child(
        div()
            .flex()
            .gap(px(2.))
            .p(px(3.))
            .rounded_full()
            .bg(theme.ink_at(0.05))
            .child(tab("agent-tab-details", "Details", PanelTab::Details, cx))
            .child(tab("agent-tab-library", "Library", PanelTab::Library, cx))
            .child(tab("agent-tab-computer", "Computer", PanelTab::Computer, cx))
            .child(tab("agent-tab-inbox", "Inbox", PanelTab::Inbox, cx)),
    )
}

pub(super) fn segmented(
    options: [(&'static str, ComputerMode); 2],
    current: ComputerMode,
    theme: &Theme,
    cx: &mut Context<Desktop>,
) -> Div {
    div().flex().p(px(3.)).rounded_full().bg(theme.ink_at(0.05)).children(options.into_iter().map(|(label, mode)| {
        let chosen = mode == current;
        let ink = theme.ink;
        div()
            .id(label)
            .flex_1()
            .h_8()
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .body()
            .map(|button| {
                if chosen {
                    button.bg(theme.control).font_weight(FontWeight::MEDIUM).text_color(theme.ink)
                } else {
                    button
                        .text_color(theme.ink_secondary)
                        .cursor_pointer()
                        .hover(move |style| style.text_color(ink))
                        .on_click(cx.listener(move |this, _, window, cx| this.set_computer_mode(mode, window, cx)))
                }
            })
            .child(label)
    }))
}

pub(super) fn card(theme: &Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(radius::CARD)
        .bg(theme.composer)
        .border_1()
        .border_color(theme.ink_at(0.06))
}

pub(super) fn card_label(text: &'static str, theme: &Theme) -> Div {
    div().mx(px(14.)).mt_5().mb_2().body().font_weight(FontWeight::SEMIBOLD).text_color(theme.ink_secondary).child(text)
}

pub(super) fn switch(on: bool, color: Hsla, theme: &Theme) -> Div {
    div()
        .w(px(44.))
        .h(px(24.))
        .flex_shrink_0()
        .p(px(2.))
        .flex()
        .when(on, |track| track.justify_end())
        .rounded_full()
        .bg(if on { color } else { theme.ink_at(0.15) })
        .child(div().size(px(20.)).rounded_full().bg(gpui_kit::white()))
}

pub(super) fn inline_field(state: &Entity<InputState>, width: Pixels, theme: &Theme) -> Div {
    div()
        .w(width)
        .max_w_full()
        .px_2()
        .rounded(radius::FIELD)
        .border_1()
        .border_color(theme.focus)
        .bg(theme.inset)
        .child(Input::new(state).appearance(false).bordered(false).small())
}

/// The design's docked width (DESKTOP-DESIGN §4); resizing is To build.
pub(super) fn panel_width(_window: Pixels) -> Pixels {
    PANEL_WIDTH
}
