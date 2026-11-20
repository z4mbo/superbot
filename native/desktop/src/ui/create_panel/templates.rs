use gpui_kit::component::input::Input;
use gpui_kit::component::text::TextView;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{framed_field, icon_button};
use crate::app::create::{Template, Templates};
use crate::app::Desktop;
use crate::theme::{radius, Theme};
use crate::ui::{bot_avatar, error_line, icon, Type};

fn round_button(id: impl Into<ElementId>, theme: &Theme) -> Stateful<Div> {
    let hover = theme.raised_hover;
    div()
        .id(id)
        .h_8()
        .px_3()
        .flex_shrink_0()
        .flex()
        .items_center()
        .gap_1()
        .rounded_full()
        .bg(theme.raised)
        .body()
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.ink)
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
}

fn heading(text: &'static str, theme: &Theme) -> Div {
    div().meta().font_weight(FontWeight::MEDIUM).text_color(theme.ink_tertiary).child(text)
}

impl Desktop {
    pub(super) fn render_templates(&self, templates: &Templates, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let reviewing = templates.review.as_ref();
        let title = reviewing.map_or("Templates".to_owned(), |review| review.template.name.clone());
        let header = div()
            .px_8()
            .pt_7()
            .pb_3()
            .flex()
            .items_start()
            .justify_between()
            .gap_4()
            .child(
                div()
                    .min_w_0()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .when(reviewing.is_some(), |row| {
                                row.child(
                                    icon_button("templates-back", "arrow-left", px(18.), theme)
                                        .on_click(cx.listener(|this, _, _, cx| this.back_to_templates(cx))),
                                )
                            })
                            .child(div().title().truncate().child(title)),
                    )
                    .when(reviewing.is_none(), |left| {
                        left.child(
                            div()
                                .mt_1()
                                .body()
                                .text_color(theme.ink_secondary)
                                .child("Start with a complete playbook or bring your own."),
                        )
                    }),
            )
            .child(
                icon_button("templates-close", "x", px(21.), theme)
                    .on_click(cx.listener(|this, _, _, cx| this.dismiss_create_panel(cx))),
            );
        let body = match reviewing {
            Some(review) => self.render_template_review(&review.template, templates, theme, cx),
            None => self.render_template_gallery(templates, theme, cx),
        };
        div()
            .id("templates")
            .w_full()
            .max_w(px(1040.))
            .h(px(780.))
            .max_h_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(16.))
            .border_1()
            .border_color(theme.hairline.opacity(0.5))
            .bg(theme.panel)
            .shadow(theme.float_shadow())
            .on_click(|_, _, cx| cx.stop_propagation())
            .child(header)
            .child(body)
            .into_any_element()
    }

    fn render_template_gallery(&self, templates: &Templates, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let query = templates.search.read(cx).value().to_string();
        let search = div().px_8().pt_3().pb_2().child(
            div()
                .h_9()
                .w(px(320.))
                .px_3()
                .flex()
                .items_center()
                .gap_2p5()
                .rounded(radius::FIELD)
                .bg(theme.inset)
                .child(icon("search", px(16.), theme.ink_secondary))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .body()
                        .child(Input::new(&templates.search).appearance(false).bordered(false)),
                ),
        );
        let content = match &templates.listing {
            None => div()
                .py_24()
                .flex()
                .items_center()
                .justify_center()
                .gap_2()
                .body()
                .text_color(theme.ink_secondary)
                .child(icon("loader-circle", px(16.), theme.ink_secondary))
                .child("Loading templates…")
                .into_any_element(),
            Some(Err(error)) => div()
                .p_4()
                .rounded(radius::CARD)
                .bg(theme.danger.opacity(0.1))
                .body()
                .text_color(theme.danger)
                .child(error.clone())
                .child(
                    round_button("templates-retry", theme)
                        .mt_3()
                        .w_auto()
                        .child("Try again")
                        .on_click(cx.listener(|this, _, window, cx| this.load_templates(window, cx))),
                )
                .into_any_element(),
            Some(Ok(list)) => {
                let visible: Vec<&Template> = list.iter().filter(|template| template.matches(&query)).collect();
                if visible.is_empty() {
                    div()
                        .min_h(px(224.))
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .body()
                        .child(div().font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("No templates found"))
                        .child(div().mt_1().text_color(theme.ink_secondary).child("Try a different search."))
                        .into_any_element()
                } else {
                    div()
                        .child(
                            div()
                                .mb_1()
                                .flex()
                                .flex_wrap()
                                .items_baseline()
                                .justify_between()
                                .gap_2()
                                .child(
                                    div()
                                        .meta()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.ink_secondary)
                                        .child("Ready-made bots"),
                                )
                                .child(
                                    div().meta().text_color(theme.ink_tertiary).child(
                                        "Add one and start chatting. You review everything before it's created.",
                                    ),
                                ),
                        )
                        .child(div().mt_3().grid().grid_cols(3).gap_3().children(
                            visible.into_iter().map(|template| self.render_template_card(template, theme, cx)),
                        ))
                        .into_any_element()
                }
            }
        };
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(search)
            .child(
                div().id("template-gallery").flex_1().min_h_0().overflow_y_scroll().px_8().pt_4().pb_7().child(content),
            )
            .into_any_element()
    }

    fn render_template_card(&self, template: &Template, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let made = template.bot_id.as_ref().is_some_and(|id| self.agent(id).is_some());
        let picked = template.clone();
        let avatar = superbot_avatars::Bot { id: &template.id, name: &template.name, color: "", picked: Default::default() };
        let button = round_button(SharedString::from(format!("template-{}", template.id)), theme)
            .when(!made, |button| button.child(icon("plus", px(14.), theme.ink)))
            .child(if made { "Open" } else { "Add" })
            .on_click(cx.listener(move |this, _, window, cx| this.pick_template(picked.clone(), window, cx)));
        div()
            .flex()
            .flex_col()
            .p_4()
            .rounded(px(16.))
            .border_1()
            .border_color(theme.hairline.opacity(0.4))
            .bg(theme.card)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(bot_avatar(avatar, px(40.), false, None, theme, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(div().name().truncate().text_color(theme.ink).child(template.name.clone()))
                            .child(
                                div().meta().truncate().text_color(theme.ink_secondary).child(template.summary.clone()),
                            ),
                    )
                    .child(button),
            )
            .when(!template.description.is_empty(), |card| {
                card.child(div().mt_3().body().text_color(theme.ink_secondary).child(template.description.clone()))
            })
            .children(template.footnote().map(|line| div().mt_2().meta().text_color(theme.ink_tertiary).child(line)))
            .into_any_element()
    }

    fn render_template_review(
        &self,
        template: &Template,
        templates: &Templates,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(review) = templates.review.as_ref() else { return div().into_any_element() };
        let line = |text: String| div().body().text_color(theme.ink_secondary).child(text);
        let skills = template.skills.iter().map(|skill| {
            div()
                .body()
                .child(div().font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(skill.name.clone()))
                .child(div().text_color(theme.ink_secondary).child(skill.description.clone()))
        });
        let routines = template.routines.iter().map(|routine| line(format!("{} · paused", routine.name)));
        let body = div()
            .max_w(px(672.))
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
            .child(div().item().text_color(theme.ink).child(template.summary.clone()))
            .when(!template.description.is_empty(), |body| body.child(line(template.description.clone())))
            .when(!template.sample.is_empty(), |body| {
                body.child(div().flex().flex_col().gap_1p5().child(heading("What it sends", theme)).child(
                    div().p_3().rounded(radius::CARD).bg(theme.inset).body().text_color(theme.ink).child(
                        TextView::markdown(
                            SharedString::from(format!("sample-{}", template.id)),
                            template.sample.clone(),
                        ),
                    ),
                ))
            })
            .when(!template.skills.is_empty(), |body| {
                body.child(div().flex().flex_col().gap_2().child(heading("Skills", theme)).children(skills))
            })
            .when(!template.routines.is_empty(), |body| {
                body.child(div().flex().flex_col().gap_1().child(heading("Routines", theme)).children(routines))
            })
            .when(!template.app_names.is_empty(), |body| {
                body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(heading("Works with", theme))
                        .child(line(template.app_names.join(", "))),
                )
            })
            .children(templates.error.clone().map(|error| error_line(error, theme)));
        let hover = theme.accent.opacity(0.9);
        let enabled = !templates.busy;
        let add = div()
            .id("template-add")
            .px_5()
            .py_2p5()
            .flex()
            .items_center()
            .gap_2()
            .rounded_full()
            .bg(theme.accent)
            .item()
            .font_weight(FontWeight::MEDIUM)
            .text_color(gpui_kit::white())
            .when(enabled, |button| button.cursor_pointer().hover(move |style| style.bg(hover)))
            .when(!enabled, |button| button.opacity(0.6))
            .child(if templates.busy { "Adding…" } else { "Add bot" })
            .on_click(cx.listener(|this, _, window, cx| this.add_template(window, cx)));
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(div().id("template-review").flex_1().min_h_0().overflow_y_scroll().px_8().pt_4().pb_6().child(body))
            .child(
                div()
                    .px_8()
                    .py_4()
                    .flex()
                    .justify_end()
                    .border_t_1()
                    .border_color(theme.hairline.opacity(0.35))
                    .child(add),
            )
            .into_any_element()
    }
}
