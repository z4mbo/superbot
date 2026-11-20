use chrono::{Duration, NaiveDate};
use gpui_kit::component::input::Input;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use superbot_features::local_app_records::{AppField, AppValue, AppValues, GrantedApp};

use crate::app::Desktop;
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::agent_panel::round_button;
use crate::ui::{chip, empty_line, error_line, field_box, icon, pill_button, Tone, Type};

use super::{has_dates, today, Addition, Chosen, Save};

const PANEL_MIN: Pixels = px(320.);
const PANEL_MAX: Pixels = px(569.);

fn panel_width(window: Pixels) -> Pixels {
    let width = window * 0.45;
    if width > PANEL_MAX {
        PANEL_MAX
    } else if width < PANEL_MIN {
        PANEL_MIN
    } else {
        width
    }
}

fn day_name(day: NaiveDate) -> String {
    let today = today();
    if day == today {
        "Today".into()
    } else if day + Duration::days(1) == today {
        "Yesterday".into()
    } else if day == today + Duration::days(1) {
        "Tomorrow".into()
    } else {
        day.format("%a, %b %-d").to_string()
    }
}

fn number_text(value: f64) -> String {
    if value.fract() == 0. && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{}", (value * 100.).round() / 100.)
    }
}

fn value_text(value: &AppValue) -> String {
    match value {
        AppValue::Text(text) => text.clone(),
        AppValue::Number(number) => number.as_f64().map(number_text).unwrap_or_else(|| number.to_string()),
    }
}

/// Each field that holds a value, as "Label value", in the app's field order.
fn value_line(fields: &[AppField], values: &AppValues) -> String {
    fields
        .iter()
        .filter_map(|field| values.get(&field.id).map(|value| format!("{} {}", field.label, value_text(value))))
        .collect::<Vec<_>>()
        .join(" · ")
}

fn part_name(slug: &str) -> String {
    let words = slug.replace(['-', '_'], " ");
    let mut letters = words.chars();
    letters.next().map(|first| first.to_uppercase().chain(letters).collect()).unwrap_or_default()
}

/// What an app is called in the panel. A plugin with several apps names the part too.
fn app_title(app: &GrantedApp, apps: &[GrantedApp]) -> (String, Option<String>) {
    let siblings = apps.iter().filter(|other| other.pin.installation_id == app.pin.installation_id).count();
    (app.plugin_name.clone(), (siblings > 1).then(|| part_name(&app.part.id)))
}

fn day_step(id: &'static str, glyph: &'static str, theme: &Theme) -> Stateful<Div> {
    let hover = theme.raised_hover;
    div()
        .id(id)
        .size_8()
        .flex_shrink_0()
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .bg(theme.control.opacity(0.7))
        .hover(move |style| style.bg(hover))
        .child(icon(glyph, px(16.), theme.ink_secondary))
}

fn caption(text: impl Into<SharedString>, theme: &Theme) -> Div {
    div().meta().font_weight(FontWeight::MEDIUM).text_color(theme.ink_tertiary).child(text.into())
}

impl Desktop {
    /// The composer's way in, beside the text field while the local model can help with apps.
    pub(crate) fn app_assist_button(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<Stateful<Div>> {
        let assist = &self.chat.as_ref()?.app_assist;
        if !assist.offered() || self.app_assist_bot().is_none() {
            return None;
        }
        let open = assist.is_open();
        let hover = theme.ink_at(0.08);
        Some(
            div()
                .id("app-assist")
                .size_7()
                .flex_shrink_0()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(if open { hover } else { theme.ink_at(0.04) })
                .border_1()
                .border_color(theme.ink_at(0.04))
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .tooltip(|window, cx| Tooltip::new("Apps").build(window, cx))
                .on_click(cx.listener(move |this, _, window, cx| {
                    if open {
                        this.close_app_assist(cx)
                    } else {
                        this.open_app_assist(None, window, cx)
                    }
                }))
                .child(icon("apps", px(16.), theme.ink_tertiary)),
        )
    }

    pub fn render_app_assist(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.app_assist_bot()?;
        let assist = &self.chat.as_ref()?.app_assist;
        let panel = assist.panel.as_ref()?;
        let theme = cx.skin().clone();
        let width = panel_width(window.viewport_size().width);
        let model = self.selected_local_model().map(|model| model.label).unwrap_or_default();

        let header = div()
            .h(px(56.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(10.))
            .pl_4()
            .pr(px(13.))
            .window_control_area(WindowControlArea::Drag)
            .child(div().flex_1().min_w_0().section().child("Apps"))
            .child(
                round_button("app-assist-close", "x", false, &theme, |button| {
                    button.tooltip(|window, cx| Tooltip::new("Close").build(window, cx))
                    .on_click(cx.listener(|this, _, _, cx| this.close_app_assist(cx)))
                }),
            )
            .when(cfg!(not(target_os = "macos")), |header| header.mr(crate::theme::CAPTION_WIDTH));

        let problem = panel.problem.clone();
        let body = match &panel.chosen {
            Some(chosen) => self.render_chosen_app(chosen, &model, &theme, cx),
            None => self.render_granted_apps(&theme, cx),
        };

        Some(
            div()
                .id("app-assist-panel")
                .w(width)
                .h_full()
                .flex_shrink_0()
                .flex()
                .flex_col()
                .bg(theme.app)
                .border_l_1()
                .border_color(theme.ink_at(0.06))
                .occlude()
                .child(header)
                .child(
                    div()
                        .id("app-assist-body")
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scroll()
                        .px_4()
                        .pb(px(28.))
                        .flex()
                        .flex_col()
                        .gap_4()
                        .children(problem.map(|problem| error_line(problem, &theme)))
                        .child(body),
                )
                .into_any_element(),
        )
    }

    fn render_granted_apps(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(assist) = self.chat.as_ref().map(|chat| &chat.app_assist) else { return div().into_any_element() };
        let apps = match &assist.apps {
            None => return empty_line("Loading…", theme).into_any_element(),
            Some(Err(problem)) => {
                return div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap_3()
                    .child(error_line(problem.clone(), theme))
                    .child(
                        pill_button("app-assist-retry", "Try again", Tone::Quiet, true, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.read_granted_apps(false, window, cx))),
                    )
                    .into_any_element()
            }
            Some(Ok(apps)) => apps,
        };
        if apps.items.is_empty() {
            return empty_line("This bot has no apps to help with.", theme).into_any_element();
        }
        let hover = theme.raised.opacity(0.4);
        let rows = apps.items.iter().enumerate().map(|(index, app)| {
            let (name, part) = app_title(app, &apps.items);
            let fields = app.part.fields.iter().map(|field| field.label.as_str()).collect::<Vec<_>>().join(", ");
            let chosen = app.clone();
            div()
                .id(("assist-app", index))
                .flex()
                .items_center()
                .gap_3()
                .px_2()
                .py_2()
                .rounded(radius::CARD)
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .on_click(cx.listener(move |this, _, window, cx| this.choose_app(chosen.clone(), window, cx)))
                .child(icon("apps", px(16.), theme.ink_secondary))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(div().item().truncate().child(match part {
                            Some(part) => format!("{name} · {part}"),
                            None => name,
                        }))
                        .child(div().meta().text_color(theme.ink_tertiary).truncate().child(fields)),
                )
                .child(icon("chevron-right", px(16.), theme.ink_tertiary))
        });
        let more = apps.next_after.is_some();
        let loading = assist.reading_more;
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().flex().flex_col().children(rows))
            .when(more, |list| {
                list.child(
                    pill_button("assist-more-apps", if loading { "Loading…" } else { "Show more" }, Tone::Quiet, !loading, theme)
                        .on_click(cx.listener(|this, _, window, cx| this.read_granted_apps(true, window, cx))),
                )
            })
            .into_any_element()
    }

    fn render_chosen_app(&self, chosen: &Chosen, model: &str, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let apps = match self.chat.as_ref().map(|chat| &chat.app_assist.apps) {
            Some(Some(Ok(apps))) => apps.items.as_slice(),
            _ => std::slice::from_ref(&chosen.app),
        };
        let (name, part) = app_title(&chosen.app, apps);
        let asking = chosen.asking.is_some();
        let fields = &chosen.app.part.fields;

        let title = div()
            .flex()
            .items_center()
            .gap_3()
            .child(
                round_button("assist-back", "chevron-left", false, theme, |button| {
                    button.tooltip(|window, cx| Tooltip::new("All apps").build(window, cx))
                    .on_click(cx.listener(|this, _, _, cx| this.leave_app(cx)))
                }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().name().truncate().child(name.clone()))
                    .children(part.map(|part| div().meta().text_color(theme.ink_tertiary).child(part))),
            );

        let days = has_dates(&chosen.app).then(|| {
            let day = chosen.day;
            let shown = day.unwrap_or_else(today);
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(day_step("assist-previous-day", "chevron-left", theme).on_click(
                    cx.listener(move |this, _, window, cx| this.show_app_day(Some(shown - Duration::days(1)), window, cx)),
                ))
                .child(chip("assist-day", day_name(shown), day.is_some(), theme).on_click(
                    cx.listener(move |this, _, window, cx| this.show_app_day(Some(shown), window, cx)),
                ))
                .child(day_step("assist-next-day", "chevron-right", theme).on_click(
                    cx.listener(move |this, _, window, cx| this.show_app_day(Some(shown + Duration::days(1)), window, cx)),
                ))
                .child(chip("assist-all-days", "All days", day.is_none(), theme).on_click(
                    cx.listener(|this, _, window, cx| this.show_app_day(None, window, cx)),
                ))
        });

        let request = self.chat.as_ref().and_then(|chat| chat.app_assist.panel.as_ref()).map(|panel| panel.request.clone());
        let ask = div()
            .flex()
            .items_center()
            .gap_2()
            .children(request.map(|request| {
                field_box(theme).flex_1().min_w_0().child(Input::new(&request).appearance(false).bordered(false))
            }))
            .child(if asking {
                pill_button("assist-stop", "Stop", Tone::Quiet, true, theme)
                    .child(Spinner::new().with_size(px(12.)).color(theme.ink_secondary))
                    .on_click(cx.listener(|this, _, _, cx| this.stop_local_assist(cx)))
            } else {
                pill_button("assist-ask", "Ask", Tone::Primary, true, theme)
                    .on_click(cx.listener(|this, _, window, cx| this.ask_app(window, cx)))
            });

        let asked = chosen.asked.as_ref().map(|asked| {
            div()
                .flex()
                .flex_col()
                .gap_3()
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .p_3()
                        .rounded(radius::CARD)
                        .bg(theme.card)
                        .child(caption(asked.model.clone(), theme))
                        .child(div().body().child(asked.answer.clone())),
                )
                .children(asked.addition.as_ref().map(|addition| self.render_addition(addition, fields, &name, theme, cx)))
        });

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(title)
            .children(days)
            .child(ask)
            .children(chosen.problem.clone().map(|problem| error_line(problem, theme)))
            .children(asked)
            .child(self.render_shared_records(chosen, model, theme, cx))
            .into_any_element()
    }

    /// The record the model suggested, with every value it would save, waiting for the person.
    fn render_addition(&self, addition: &Addition, fields: &[AppField], app: &str, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let rows = fields.iter().filter_map(|field| {
            let value = addition.values.get(&field.id)?;
            Some(
                div()
                    .flex()
                    .items_baseline()
                    .gap_3()
                    .child(div().w(px(112.)).flex_shrink_0().body().text_color(theme.ink_secondary).truncate().child(field.label.clone()))
                    .child(div().flex_1().min_w_0().item().child(value_text(value))),
            )
        });
        let actions = match &addition.save {
            Save::Proposed | Save::Failed(_) => {
                let retry = matches!(addition.save, Save::Failed(_));
                div()
                    .flex()
                    .gap_2()
                    .child(
                        pill_button("assist-add", if retry { "Try again" } else { "Add" }, Tone::Primary, true, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.add_suggested(window, cx))),
                    )
                    .child(
                        pill_button("assist-skip", "Skip", Tone::Quiet, true, theme)
                            .on_click(cx.listener(|this, _, _, cx| this.skip_suggested(cx))),
                    )
            }
            Save::Saving => div().child(pill_button("assist-adding", "Adding…", Tone::Primary, false, theme)),
            Save::Added => div()
                .flex()
                .items_center()
                .gap_1p5()
                .body()
                .text_color(theme.ink_secondary)
                .child(icon("check", px(14.), theme.ink_secondary))
                .child("Added"),
            Save::Skipped => div().body().text_color(theme.ink_tertiary).child("Skipped"),
        };
        let failure = match &addition.save {
            Save::Failed(problem) => Some(error_line(problem.clone(), theme)),
            _ => None,
        };
        div()
            .flex()
            .flex_col()
            .gap_3()
            .p_3()
            .rounded(radius::CARD)
            .border_1()
            .border_color(theme.hairline.opacity(0.5))
            .child(caption(format!("Add to {app}?"), theme))
            .child(div().flex().flex_col().gap_1p5().children(rows))
            .children(failure)
            .child(actions)
    }

    /// Exactly the records the request is sent with.
    fn render_shared_records(&self, chosen: &Chosen, model: &str, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let fields = &chosen.app.part.fields;
        let body = match &chosen.context {
            None => empty_line("Loading…", theme).into_any_element(),
            Some(Err(problem)) => div()
                .flex()
                .flex_col()
                .items_start()
                .gap_3()
                .child(error_line(problem.clone(), theme))
                .child(
                    pill_button("assist-context-retry", "Try again", Tone::Quiet, true, theme)
                        .on_click(cx.listener(|this, _, window, cx| this.load_app_context(false, window, cx))),
                )
                .into_any_element(),
            Some(Ok(context)) => {
                let summary = context.app.part.summary_field.as_ref().and_then(|id| fields.iter().find(|field| &field.id == id));
                let empty = context.items.is_empty();
                let total = context.total.zip(summary).filter(|_| !empty).map(|(total, field)| {
                    div().body().text_color(theme.ink_secondary).child(format!("{} total {}", field.label, number_text(total)))
                });
                div()
                    .flex()
                    .flex_col()
                    .gap_1p5()
                    .when(empty, |list| {
                        list.child(empty_line(if chosen.day.is_some() { "Nothing added on this day." } else { "Nothing added yet." }, theme))
                    })
                    .children(context.items.iter().map(|record| {
                        div().body().truncate().child(value_line(fields, &record.values))
                    }))
                    .children(total)
                    .when(context.has_more, |list| list.child(empty_line("Older records aren't sent.", theme)))
                    .into_any_element()
            }
        };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .pt_3()
            .border_t_1()
            .border_color(theme.ink_at(0.06))
            .child(caption(format!("Sent to {model} with your request"), theme))
            .child(body)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use superbot_features::local_app_records::{AppField, AppValue, FieldType};

    use super::{number_text, part_name, value_line};

    #[test]
    fn totals_drop_a_needless_decimal() {
        assert_eq!(number_text(0.0), "0");
        assert_eq!(number_text(860.0), "860");
        assert_eq!(number_text(320.456), "320.46");
    }

    fn field(id: &str, label: &str, kind: FieldType) -> AppField {
        AppField { id: id.into(), label: label.into(), kind, required: false }
    }

    #[test]
    fn a_record_reads_in_the_apps_field_order() {
        let fields = [field("food", "Food", FieldType::Text), field("kcal", "Kcal", FieldType::Number), field("day", "Day", FieldType::Date)];
        let values = BTreeMap::from([
            ("kcal".to_owned(), AppValue::Number(320.into())),
            ("food".to_owned(), AppValue::Text("Oatmeal".into())),
        ]);
        assert_eq!(value_line(&fields, &values), "Food Oatmeal · Kcal 320");
    }

    #[test]
    fn a_part_slug_reads_as_words() {
        assert_eq!(part_name("daily-log"), "Daily log");
        assert_eq!(part_name("meals_eaten"), "Meals eaten");
    }
}
