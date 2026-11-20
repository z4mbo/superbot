use std::collections::HashSet;

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{accent_button, framed_field, quiet_button};
use crate::app::create::{Import, ImportStep};
use crate::app::Desktop;
use crate::theme::{radius, Theme};
use crate::ui::{error_line, icon, Type};

fn items_section<'a>(
    title: &'static str,
    items: impl IntoIterator<Item = (&'a str, &'a str)>,
    left_out: &HashSet<String>,
    theme: &Theme,
) -> Option<Div> {
    let rows: Vec<Div> = items
        .into_iter()
        .map(|(id, label)| {
            let out = left_out.contains(id);
            div()
                .flex()
                .items_center()
                .gap_2()
                .body()
                .text_color(if out { theme.ink_tertiary } else { theme.ink })
                .child(icon(if out { "minus" } else { "check" }, px(14.), theme.ink_secondary))
                .child(div().flex_1().min_w_0().truncate().child(label.to_owned()))
                .when(out, |row| row.child(div().meta().text_color(theme.ink_tertiary).child("Left out")))
        })
        .collect();
    (!rows.is_empty()).then(|| {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(div().meta().font_weight(FontWeight::MEDIUM).text_color(theme.ink_tertiary).child(title))
            .children(rows)
    })
}

impl Desktop {
    pub(super) fn render_import(&self, import: &Import, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let idle = import.busy.is_none();
        let (title, body, footer) = match &import.step {
            ImportStep::Choose => {
                let label = if idle { "Choose folder…" } else { "Reading…" };
                let hover = theme.raised_hover;
                let choose = div()
                    .id("import-folder")
                    .h_8()
                    .px_3()
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .rounded(radius::FIELD)
                    .bg(theme.raised)
                    .body()
                    .text_color(theme.ink)
                    .when(idle, |button| button.cursor_pointer().hover(move |style| style.bg(hover)))
                    .when(!idle, |button| button.opacity(0.6))
                    .child(icon(if idle { "folder-open" } else { "loader-circle" }, px(14.), theme.ink_secondary))
                    .child(label)
                    .on_click(cx.listener(|this, _, window, cx| this.choose_import_folder(window, cx)));
                let body = div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .body()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.ink)
                            .child("An OpenClaw or Hermes folder"),
                    )
                    .child(div().flex().child(choose))
                    .into_any_element();
                let footer = quiet_button("import-cancel", "Cancel", idle, theme)
                    .on_click(cx.listener(|this, _, _, cx| this.dismiss_create_panel(cx)))
                    .into_any_element();
                ("Import".to_owned(), body, footer)
            }
            ImportStep::Review(review) => {
                let plan = &review.plan;
                let pairs = |items: &'_ [crate::app::create::PlanItem]| -> Vec<(String, String)> {
                    items.iter().map(|item| (item.id.clone(), item.title.clone())).collect()
                };
                let sections: Vec<(&'static str, Vec<(String, String)>)> = vec![
                    ("Instructions", pairs(&plan.instructions)),
                    ("Memory", pairs(&plan.memory)),
                    ("Skills", pairs(&plan.skills)),
                    ("Routines, paused", pairs(&plan.routines)),
                    ("Servers", pairs(&plan.mcp_servers)),
                    ("The bot will ask you to set up", pairs(&plan.leftovers)),
                ];
                let mut list = div().flex().flex_col().gap_4();
                for (heading, items) in &sections {
                    let shown = items.iter().map(|(id, title)| (id.as_str(), title.as_str()));
                    list = list.children(items_section(heading, shown, &review.left_out, theme));
                }
                if let Some(model) = &plan.model {
                    let usable = model.status == "ready";
                    list = list.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .meta()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.ink_tertiary)
                                    .child("Model"),
                            )
                            .child(div().body().text_color(if usable { theme.ink } else { theme.ink_tertiary }).child(
                                if usable {
                                    model.title.clone()
                                } else {
                                    format!("{} · not connected here", model.title)
                                },
                            )),
                    );
                }
                if !plan.skipped.is_empty() {
                    let count = plan.skipped.len();
                    list = list.child(div().meta().text_color(theme.ink_tertiary).child(if count == 1 {
                        "1 file isn't imported.".to_owned()
                    } else {
                        format!("{count} files aren't imported.")
                    }));
                }
                let body = div()
                    .flex()
                    .flex_col()
                    .gap_4()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(div().body().text_color(theme.ink_secondary).child("Name"))
                            .child(framed_field(&review.name, theme)),
                    )
                    .when(!plan.suggested_description.trim().is_empty(), |body| {
                        body.child(
                            div().body().text_color(theme.ink_secondary).child(plan.suggested_description.clone()),
                        )
                    })
                    .child(list)
                    .into_any_element();
                let adding = matches!(import.busy, Some(crate::app::create::ImportBusy::Adding));
                let footer = div()
                    .flex()
                    .gap_2()
                    .child(
                        quiet_button("import-back", "Back", idle, theme)
                            .on_click(cx.listener(|this, _, _, cx| this.back_to_import(cx))),
                    )
                    .child(
                        accent_button("import-add", if adding { "Adding…" } else { "Add" }, idle, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.add_import(window, cx))),
                    )
                    .into_any_element();
                (plan.suggested_name.clone(), body, footer)
            }
        };
        div()
            .id("import")
            .w_full()
            .max_w(px(480.))
            .max_h_full()
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
                    .px_5()
                    .pt_4()
                    .pb_2()
                    .text_size(px(17.))
                    .line_height(px(24.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .truncate()
                    .child(title),
            )
            .child(
                div()
                    .id("import-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_5()
                    .pb_4()
                    .child(body)
                    .children(import.error.clone().map(|error| div().mt_3().child(error_line(error, theme)))),
            )
            .child(div().px_5().pb_4().flex().justify_end().child(footer))
            .into_any_element()
    }
}
