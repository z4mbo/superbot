use chrono::{Duration, Local, NaiveDate};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Map, Value};
use superbot_client::Error;

use crate::api::{self, AppField, AppFieldKind, AppRecord, Installation, ManifestPart, RecordQuery};
use crate::app::Desktop;
use crate::theme::{radius, Theme};
use crate::ui::{chip, empty_line, error_line, field_box, icon, pill_button, Tone, Type};

use super::confirm::Confirm;
use super::{back_button, plugin_mark};

const DAY: &str = "%Y-%m-%d";

/// An installed app part, open for reading and adding records.
pub struct OpenApp {
    pub installation_id: String,
    /// The version whose records are shown. Each version keeps its own.
    pub version_id: String,
    pub part_id: String,
    fields: Vec<AppField>,
    summary_field: Option<String>,
    inputs: Vec<Entity<InputState>>,
    /// The day the list shows, or every day. Only an app with a date field filters by day.
    day: Option<NaiveDate>,
    /// The day the day buttons step from, kept while every day is shown.
    anchor: NaiveDate,
    listing: Option<Result<Listing, String>>,
    reads: u64,
    loading_more: bool,
    saving: bool,
    form_error: Option<String>,
    /// An add whose answer never arrived, so a retry of the same values reuses its operation.
    unanswered: Option<(String, Map<String, Value>)>,
    _submit: Vec<Subscription>,
}

struct Listing {
    records: Vec<AppRecord>,
    next_after: Option<String>,
    total: Option<f64>,
}

/// The app parts a plugin version declares, in manifest order.
pub fn app_parts(parts: &[ManifestPart]) -> impl Iterator<Item = &ManifestPart> {
    parts.iter().filter(|part| matches!(part, ManifestPart::App { .. }))
}

fn today() -> NaiveDate {
    Local::now().date_naive()
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

/// A number as people write it: whole numbers without decimals, others to two places.
pub fn number_text(value: f64) -> String {
    let rounded = (value * 100.).round() / 100.;
    let whole = rounded.trunc();
    let mut digits = format!("{}", whole.abs() as i64).chars().rev().collect::<Vec<_>>();
    let mut grouped = String::new();
    for (index, digit) in digits.drain(..).enumerate() {
        if index > 0 && index % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    let mut text: String = grouped.chars().rev().collect();
    if rounded < 0. {
        text.insert(0, '-');
    }
    let fraction = ((rounded - whole).abs() * 100.).round() as i64;
    if fraction != 0 {
        let cents = format!("{fraction:02}");
        text.push('.');
        text.push_str(cents.trim_end_matches('0'));
    }
    text
}

fn value_text(value: &Value) -> String {
    match value {
        Value::Number(number) => number.as_f64().map(number_text).unwrap_or_else(|| number.to_string()),
        Value::String(text) => match NaiveDate::parse_from_str(text, DAY) {
            Ok(day) => day_name(day),
            Err(_) => text.clone(),
        },
        other => other.to_string(),
    }
}

/// What the person typed, as the values the server takes, or what to fix first.
pub fn record_values(fields: &[AppField], typed: &[String]) -> Result<Map<String, Value>, String> {
    let mut values = Map::new();
    for (field, raw) in fields.iter().zip(typed) {
        let raw = raw.trim();
        if raw.is_empty() {
            if field.required {
                return Err(format!("Fill in {}.", field.label));
            }
            continue;
        }
        let value = match field.kind {
            AppFieldKind::Text if raw.chars().count() > 2000 => {
                return Err(format!("{} can be at most 2,000 characters.", field.label))
            }
            AppFieldKind::Text => Value::String(raw.to_owned()),
            AppFieldKind::Number => {
                let number = raw.replace(',', ".").parse::<f64>().ok().filter(|number| number.abs() <= 1e12);
                match number.and_then(serde_json::Number::from_f64) {
                    Some(number) => Value::Number(number),
                    None => return Err(format!("{} needs a number.", field.label)),
                }
            }
            AppFieldKind::Date => match NaiveDate::parse_from_str(raw, DAY) {
                Ok(day) => Value::String(day.format(DAY).to_string()),
                Err(_) => return Err(format!("{} needs a date like {}.", field.label, today().format(DAY))),
            },
        };
        values.insert(field.id.clone(), value);
    }
    Ok(values)
}

impl OpenApp {
    fn date_field(&self) -> Option<&AppField> {
        self.fields.iter().find(|field| field.kind == AppFieldKind::Date)
    }

    /// The field a record is known by: its first text field, else its first field.
    fn title_field(&self) -> Option<&AppField> {
        self.fields.iter().find(|field| field.kind == AppFieldKind::Text).or(self.fields.first())
    }
}

impl Desktop {
    pub(super) fn open_app(
        &mut self,
        installation: &Installation,
        part_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(ManifestPart::App { fields, summary_field, .. }) =
            installation.plugin.manifest.parts.iter().find(|part| part.id() == part_id)
        else {
            return;
        };
        let day = fields.iter().any(|field| field.kind == AppFieldKind::Date).then(today);
        let inputs: Vec<Entity<InputState>> = fields
            .iter()
            .map(|field| {
                let start = match field.kind {
                    AppFieldKind::Date => day.unwrap_or_else(today).format(DAY).to_string(),
                    _ => String::new(),
                };
                let hint = match field.kind {
                    AppFieldKind::Date => "YYYY-MM-DD",
                    AppFieldKind::Number | AppFieldKind::Text => "",
                };
                cx.new(|cx| InputState::new(window, cx).placeholder(hint).default_value(start))
            })
            .collect();
        let submit = inputs
            .iter()
            .map(|input| {
                cx.subscribe_in(input, window, |this, _, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { .. } = event {
                        this.add_record(window, cx);
                    }
                })
            })
            .collect();
        if let Some(first) = first_typed(fields, &inputs) {
            first.update(cx, |input, cx| input.focus(window, cx));
        }
        self.store.app = Some(OpenApp {
            installation_id: installation.id.clone(),
            version_id: installation.plugin.id.clone(),
            part_id: part_id.to_owned(),
            fields: fields.clone(),
            summary_field: summary_field.clone(),
            inputs,
            day,
            anchor: today(),
            listing: None,
            reads: 0,
            loading_more: false,
            saving: false,
            form_error: None,
            unanswered: None,
            _submit: submit,
        });
        self.load_records(false, window, cx);
        cx.notify();
    }

    /// Reads the first page again, or the next one after what is shown.
    pub(super) fn load_records(&mut self, more: bool, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(app) = self.store.app.as_mut() else { return };
        let after = match (&app.listing, more) {
            (Some(Ok(listing)), true) => match &listing.next_after {
                Some(after) => Some(after.clone()),
                None => return,
            },
            _ => None,
        };
        app.reads += 1;
        app.loading_more = more;
        let read = app.reads;
        let (installation_id, part_id) = (app.installation_id.clone(), app.part_id.clone());
        let query = RecordQuery { after, date: app.day.map(|day| day.format(DAY).to_string()) };
        let work = async move { api.app_records(&space_id, &installation_id, &part_id, &query).await };
        self.call(window, cx, work, move |this, result, _, _| {
            let Some(app) = this.store.app.as_mut().filter(|app| app.reads == read) else { return };
            app.loading_more = false;
            app.listing = Some(match (result, app.listing.take()) {
                (Ok(page), Some(Ok(mut shown))) if more => {
                    shown.records.extend(page.items);
                    shown.next_after = page.next_after;
                    shown.total = page.total;
                    Ok(shown)
                }
                (Ok(page), _) => Ok(Listing { records: page.items, next_after: page.next_after, total: page.total }),
                (Err(error), _) => Err(api::explain(&error)),
            });
        });
        cx.notify();
    }

    fn show_day(&mut self, day: Option<NaiveDate>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(app) = self.store.app.as_mut() else { return };
        app.day = day;
        if let Some(day) = day {
            app.anchor = day;
        }
        app.listing = None;
        if let (Some(day), Some(index)) = (day, app.fields.iter().position(|field| field.kind == AppFieldKind::Date)) {
            app.inputs[index].update(cx, |input, cx| input.set_value(day.format(DAY).to_string(), window, cx));
        }
        self.load_records(false, window, cx);
    }

    fn add_record(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(app) = self.store.app.as_mut().filter(|app| !app.saving) else { return };
        let typed: Vec<String> = app.inputs.iter().map(|input| input.read(cx).value().to_string()).collect();
        let values = match record_values(&app.fields, &typed) {
            Ok(values) => values,
            Err(problem) => {
                app.form_error = Some(problem);
                cx.notify();
                return;
            }
        };
        let operation_id = match &app.unanswered {
            Some((operation_id, sent)) if *sent == values => operation_id.clone(),
            _ => uuid::Uuid::new_v4().to_string(),
        };
        app.unanswered = Some((operation_id.clone(), values.clone()));
        app.saving = true;
        app.form_error = None;
        let (installation_id, part_id) = (app.installation_id.clone(), app.part_id.clone());
        let work =
            async move { api.add_app_record(&space_id, &installation_id, &part_id, &operation_id, &values).await };
        self.call(window, cx, work, |this, result, window, cx| {
            let Some(app) = this.store.app.as_mut() else { return };
            app.saving = false;
            match result {
                Ok(_) => {
                    app.unanswered = None;
                    for (field, input) in app.fields.iter().zip(&app.inputs) {
                        if field.kind != AppFieldKind::Date {
                            input.update(cx, |input, cx| input.set_value("", window, cx));
                        }
                    }
                    if let Some(first) = first_typed(&app.fields, &app.inputs) {
                        first.update(cx, |input, cx| input.focus(window, cx));
                    }
                    this.load_records(false, window, cx);
                }
                Err(error) => {
                    if !matches!(error, Error::Transport(_)) {
                        app.unanswered = None;
                    }
                    app.form_error = Some(api::explain(&error));
                }
            }
        });
        cx.notify();
    }

    pub(super) fn remove_record(&mut self, record_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id), Some(app)) = (self.api.clone(), self.space_id(), self.store.app.as_ref())
        else {
            self.store.settle_confirm();
            return;
        };
        let (installation_id, part_id) = (app.installation_id.clone(), app.part_id.clone());
        let work = async move { api.remove_app_record(&space_id, &installation_id, &part_id, &record_id).await };
        self.call(window, cx, work, |this, result, window, cx| {
            this.store.settle_confirm();
            match result {
                Ok(()) => this.load_records(false, window, cx),
                Err(error) => this.notify(api::explain(&error), true, None, cx),
            }
        });
    }

    pub(super) fn render_app(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let app = self.store.app.as_ref().expect("an open app");
        let installation = self
            .store
            .installations
            .iter()
            .find(|known| known.id == app.installation_id && known.plugin.id == app.version_id)
            .cloned();
        let back = back_button(theme).on_click(cx.listener(|this, _, _, cx| {
            this.store.app = None;
            cx.notify();
        }));
        let Some(installation) = installation else {
            return div()
                .flex()
                .flex_col()
                .gap_3()
                .child(back)
                .child(empty_line("This app was uninstalled or moved to another version.", theme))
                .into_any_element();
        };
        let version = &installation.plugin;
        let several = app_parts(&version.manifest.parts).count() > 1;
        let subtitle = if several { Some(humanize(&app.part_id)) } else { None };

        let header = div().flex().items_center().gap_3().child(back).child(plugin_mark(version, px(40.), theme)).child(
            div()
                .flex_1()
                .min_w_0()
                .child(div().title().truncate().child(version.manifest.name.clone()))
                .children(subtitle.map(|line| div().meta().text_color(theme.ink_tertiary).child(line))),
        );

        div()
            .id("app-page")
            .size_full()
            .overflow_y_scroll()
            .pb_8()
            .flex()
            .flex_col()
            .gap_6()
            .child(header)
            .child(self.render_record_form(theme, cx))
            .child(self.render_records(theme, cx))
            .into_any_element()
    }

    fn render_record_form(&mut self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let app = self.store.app.as_ref().expect("an open app");
        let saving = app.saving;
        let fields = app.fields.iter().zip(&app.inputs).map(|(field, input)| {
            let label = if field.required { field.label.clone() } else { format!("{} (optional)", field.label) };
            let width = match field.kind {
                AppFieldKind::Text => px(260.),
                AppFieldKind::Number | AppFieldKind::Date => px(140.),
            };
            div()
                .w(width)
                .flex()
                .flex_col()
                .gap_1p5()
                .child(div().meta().font_weight(FontWeight::MEDIUM).text_color(theme.ink_tertiary).child(label))
                .child(field_box(theme).child(Input::new(input).appearance(false).bordered(false)))
        });
        div()
            .flex()
            .flex_col()
            .gap_3()
            .p_4()
            .rounded(radius::CARD)
            .bg(theme.ink_at(0.03))
            .border_1()
            .border_color(theme.hairline.opacity(0.5))
            .child(
                div().flex().flex_wrap().items_end().gap_3().children(fields).child(
                    pill_button("add-record", if saving { "Adding…" } else { "Add" }, Tone::Primary, !saving, theme)
                        .mb(px(2.))
                        .on_click(cx.listener(|this, _, window, cx| this.add_record(window, cx))),
                ),
            )
            .children(app.form_error.clone().map(|problem| error_line(problem, theme)))
    }

    fn render_records(&mut self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let app = self.store.app.as_ref().expect("an open app");
        let has_dates = app.date_field().is_some();
        let summary =
            app.summary_field.as_ref().and_then(|id| app.fields.iter().find(|field| &field.id == id)).cloned();
        let title = app.title_field().cloned();
        let filtered = app.day.and(app.date_field()).cloned();
        let day = app.day;

        let filter = has_dates.then(|| {
            let shown = app.anchor;
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(day_step("previous-day", "chevron-left", theme).on_click(
                    cx.listener(move |this, _, window, cx| this.show_day(Some(shown - Duration::days(1)), window, cx)),
                ))
                .child(
                    chip("shown-day", day_name(shown), day.is_some(), theme)
                        .on_click(cx.listener(move |this, _, window, cx| this.show_day(Some(shown), window, cx))),
                )
                .child(day_step("next-day", "chevron-right", theme).on_click(
                    cx.listener(move |this, _, window, cx| this.show_day(Some(shown + Duration::days(1)), window, cx)),
                ))
                .child(
                    chip("all-days", "All days", day.is_none(), theme)
                        .on_click(cx.listener(|this, _, window, cx| this.show_day(None, window, cx))),
                )
        });

        let body = match &app.listing {
            None => empty_line("Loading…", theme).into_any_element(),
            Some(Err(problem)) => div()
                .flex()
                .flex_col()
                .items_start()
                .gap_3()
                .child(error_line(problem.clone(), theme))
                .child(
                    pill_button("records-retry", "Try again", Tone::Quiet, true, theme)
                        .on_click(cx.listener(|this, _, window, cx| this.load_records(false, window, cx))),
                )
                .into_any_element(),
            Some(Ok(listing)) => {
                let total =
                    listing.total.zip(summary.as_ref()).map(|(total, field)| {
                        let scope = match day {
                            Some(day) => day_name(day),
                            None => "All days".into(),
                        };
                        div().flex().items_baseline().gap_2().child(div().page_title().child(number_text(total))).child(
                            div().body().text_color(theme.ink_secondary).child(format!("{} · {scope}", field.label)),
                        )
                    });
                let rows: Vec<AnyElement> = listing
                    .records
                    .iter()
                    .map(|record| {
                        record_row(
                            record,
                            &app.fields,
                            [title.as_ref(), summary.as_ref(), filtered.as_ref()],
                            theme,
                            cx,
                        )
                    })
                    .collect();
                let empty = rows.is_empty();
                let more = listing.next_after.is_some();
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .children(total)
                    .when(empty, |list| {
                        list.child(empty_line(
                            if day.is_some() { "Nothing added on this day." } else { "Nothing added yet." },
                            theme,
                        ))
                    })
                    .child(div().flex().flex_col().children(rows))
                    .when(more, |list| {
                        let loading = app.loading_more;
                        list.child(
                            div().flex().child(
                                pill_button(
                                    "more-records",
                                    if loading { "Loading…" } else { "Show more" },
                                    Tone::Quiet,
                                    !loading,
                                    theme,
                                )
                                .on_click(cx.listener(|this, _, window, cx| this.load_records(true, window, cx))),
                            ),
                        )
                    })
                    .into_any_element()
            }
        };

        div().flex().flex_col().gap_3().children(filter).child(body)
    }
}

pub(super) fn humanize(slug: &str) -> String {
    let words = slug.replace('-', " ");
    let mut letters = words.chars();
    letters.next().map(|first| first.to_uppercase().chain(letters).collect()).unwrap_or_default()
}

/// The first field a person types into: the date is already filled in.
fn first_typed<'a>(fields: &[AppField], inputs: &'a [Entity<InputState>]) -> Option<&'a Entity<InputState>> {
    fields
        .iter()
        .position(|field| field.kind != AppFieldKind::Date)
        .and_then(|index| inputs.get(index))
        .or(inputs.first())
}

fn day_step(id: &'static str, glyph: &str, theme: &Theme) -> Stateful<Div> {
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

/// One record: its title, the fields not already on screen, and its summary amount.
fn record_row(
    record: &AppRecord,
    fields: &[AppField],
    [title, summary, filtered]: [Option<&AppField>; 3],
    theme: &Theme,
    cx: &mut Context<Desktop>,
) -> AnyElement {
    let shown = |field: &AppField| record.values.get(&field.id).map(value_text);
    let name = title.and_then(shown).unwrap_or_default();
    let details: Vec<String> = fields
        .iter()
        .filter(|field| [title, summary, filtered].iter().flatten().all(|shown| shown.id != field.id))
        .filter_map(|field| shown(field).map(|value| format!("{} {value}", field.label)))
        .collect();
    let amount = summary.and_then(shown);
    let hover = theme.raised.opacity(0.4);
    let (record_id, label) = (record.id.clone(), name.clone());
    div()
        .id(SharedString::from(format!("record-{}", record.id)))
        .flex()
        .items_center()
        .gap_3()
        .px_2()
        .py_2()
        .rounded(radius::CARD)
        .hover(move |style| style.bg(hover))
        .child(div().flex_1().min_w_0().child(div().item().truncate().child(name)).when(!details.is_empty(), |cell| {
            cell.child(div().meta().text_color(theme.ink_tertiary).truncate().child(details.join(" · ")))
        }))
        .children(amount.map(|amount| div().name().child(amount)))
        .child(
            div()
                .id(SharedString::from(format!("remove-{}", record.id)))
                .size_7()
                .flex_shrink_0()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover({
                    let fill = theme.raised_hover;
                    move |style| style.bg(fill)
                })
                .child(icon("trash", px(14.), theme.ink_tertiary))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.store.confirm =
                        Some(Confirm::RemoveRecord { record_id: record_id.clone(), label: label.clone() });
                    cx.notify();
                })),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{number_text, record_values};
    use crate::api::{AppField, AppFieldKind};

    fn field(id: &str, kind: AppFieldKind, required: bool) -> AppField {
        AppField { id: id.into(), label: id.to_uppercase(), kind, required }
    }

    #[test]
    fn typed_values_become_the_record_the_server_takes() {
        let fields = [
            field("food", AppFieldKind::Text, true),
            field("kcal", AppFieldKind::Number, true),
            field("day", AppFieldKind::Date, true),
            field("note", AppFieldKind::Text, false),
        ];
        let typed = ["  Oatmeal ", "320,5", "2026-11-20", " "].map(String::from);
        let values = record_values(&fields, &typed).unwrap();
        assert_eq!(json!(values), json!({ "food": "Oatmeal", "kcal": 320.5, "day": "2026-11-20" }));
    }

    #[test]
    fn a_missing_or_malformed_value_names_its_field() {
        let fields = [field("food", AppFieldKind::Text, true), field("kcal", AppFieldKind::Number, false)];
        assert_eq!(record_values(&fields, &["".into(), "".into()]), Err("Fill in FOOD.".into()));
        assert_eq!(record_values(&fields, &["Tea".into(), "lots".into()]), Err("KCAL needs a number.".into()));
        let day = [field("day", AppFieldKind::Date, true)];
        assert!(record_values(&day, &["20/11/2026".into()]).unwrap_err().starts_with("DAY needs a date like"));
    }

    #[test]
    fn totals_read_as_people_write_them() {
        assert_eq!(number_text(1240.0), "1,240");
        assert_eq!(number_text(320.5), "320.5");
        assert_eq!(number_text(-12.25), "-12.25");
        assert_eq!(number_text(0.0), "0");
    }
}
