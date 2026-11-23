use super::*;
use crate::ui::chrome::switch;
use crate::ui::focus::{self, Ring};

impl Desktop {
    pub(super) fn render_agent_settings(&self, bot: &Bot, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let panel = self.agent_panel.as_ref().expect("rendered with a panel");
        let name = bot.name.clone();
        let hover = theme.ink_at(0.03);
        let editing = panel.editing.as_ref();
        let instructions = match editing {
            Some((Field::Instructions, Editor::Text(state))) => div()
                .flex()
                .flex_col()
                .gap_2p5()
                .px(px(14.))
                .py(px(11.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(icon("file-text", px(16.), theme.ink_secondary))
                        .child(div().name().text_color(theme.ink).child("Instructions")),
                )
                .child(
                    crate::ui::field_box(theme)
                        .items_start()
                        .py_1()
                        .child(Textarea::new(state).appearance(false).bordered(false).aria_label("Instructions")),
                )
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .child(
                            crate::ui::pill_button(
                                "instructions-cancel",
                                "Cancel",
                                crate::ui::Tone::Quiet,
                                true,
                                theme,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.agent_panel_back(cx);
                            })),
                        )
                        .child(
                            crate::ui::pill_button(
                                "instructions-save",
                                if panel.saving { "Saving…" } else { "Save" },
                                crate::ui::Tone::Primary,
                                !panel.saving,
                                theme,
                            )
                            .on_click(cx.listener(|this, _, window, cx| this.commit_edit(window, cx))),
                        ),
                )
                .into_any_element(),
            _ => {
                let first = bot.instructions.lines().map(str::trim).find(|line| !line.is_empty()).map(str::to_owned);
                div()
                    .id("instructions-edit")
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(14.))
                    .py(px(11.))
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(|this, _, window, cx| this.edit(Field::Instructions, window, cx)))
                    .child(icon("file-text", px(16.), theme.ink_secondary))
                    .child(
                        div().flex_1().min_w_0().child(div().name().text_color(theme.ink).child("Instructions")).child(
                            div()
                                .mt(px(1.))
                                .body()
                                .text_color(theme.ink_secondary)
                                .truncate()
                                .child(first.unwrap_or_else(|| format!("Tell {name} how to work for you"))),
                        ),
                    )
                    .child(icon("chevron-right", px(15.), theme.ink_tertiary))
                    .into_any_element()
            }
        };

        let notify = bot.notify_on_finish;
        let enabled = !panel.saving;
        let notifications =
            div()
                .id("agent-notifications")
                .role(Role::Switch)
                .aria_toggled(notify.into())
                .flex()
                .items_center()
                .gap(px(10.))
                .min_h(px(46.))
                .px(px(14.))
                .when(enabled, |row| {
                    row.cursor_pointer().on_click(
                        cx.listener(move |this, _, window, cx| this.change_agent(Change::Notify(!notify), window, cx)),
                    )
                })
                .child(icon("bell", px(16.), theme.ink_secondary))
                .child(div().flex_1().child(div().name().text_color(theme.ink).child("Notifications")).child(
                    div().mt(px(1.)).body().text_color(theme.ink_secondary).child(format!("When {name} finishes")),
                ))
                .child(switch(notify, enabled, theme));
        let notifications = if enabled {
            focus::control(notifications, Ring::TrailingSwitch, theme)
        } else {
            focus::decorate(notifications)
        };

        let job_editor = match editing {
            Some((Field::Description, Editor::Line(state))) => Some(state.clone()),
            _ => None,
        };
        let description = bot.description.trim().to_owned();
        let job = div()
            .id("agent-job-row")
            .flex()
            .items_center()
            .gap(px(10.))
            .min_h(px(46.))
            .px(px(14.))
            .border_t_1()
            .border_color(theme.ink_at(0.05))
            .when(job_editor.is_none(), |row| {
                row.cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(|this, _, window, cx| this.edit(Field::Description, window, cx)))
            })
            .child(icon("tag", px(16.), theme.ink_secondary))
            .child(div().flex_shrink_0().name().text_color(theme.ink).child("Job"))
            .child(match job_editor {
                Some(state) => div()
                    .flex_1()
                    .min_w_0()
                    .child(Input::new(&state).appearance(false).bordered(false).small())
                    .into_any_element(),
                None => div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .justify_end()
                    .body()
                    .truncate()
                    .text_color(if description.is_empty() { theme.ink_tertiary } else { theme.ink_secondary })
                    .child(if description.is_empty() { "What it does".to_owned() } else { description })
                    .into_any_element(),
            });

        let archive_id = bot.id.clone();
        let danger_hover = theme.danger.opacity(0.08);
        let archive = div()
            .id("agent-archive")
            .flex()
            .items_center()
            .gap(px(10.))
            .min_h(px(46.))
            .px(px(14.))
            .cursor_pointer()
            .hover(move |style| style.bg(danger_hover))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.agent_panel = None;
                this.archive_agent(archive_id.clone(), window, cx);
            }))
            .child(icon("archive", px(16.), theme.danger))
            .child(div().name().text_color(theme.danger).child(format!("Archive {name}")));

        let back_hover = theme.ink_at(0.04);
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .id("agent-settings-back")
                    .mt(px(2.))
                    .h_7()
                    .w_auto()
                    .self_start()
                    .flex()
                    .items_center()
                    .gap_1()
                    .px_1()
                    .rounded(radius::FIELD)
                    .body()
                    .text_color(theme.ink_secondary)
                    .cursor_pointer()
                    .hover(move |style| style.bg(back_hover))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(panel) = this.agent_panel.as_mut() {
                            panel.settings = false;
                            panel.editing = None;
                        }
                        cx.notify();
                    }))
                    .child(icon("chevron-left", px(14.), theme.ink_secondary))
                    .child("Details"),
            )
            .child(div().mt_1p5().px_1().section().text_color(theme.ink).child("Agent settings"))
            .child(div().mt(px(14.)).child(card(theme).child(instructions)))
            .child(div().mt(px(14.)).child(card(theme).child(notifications).child(job)))
            .child(div().mt(px(14.)).child(card(theme).child(archive)))
    }
}
