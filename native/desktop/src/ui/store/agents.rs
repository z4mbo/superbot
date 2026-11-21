use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::json;

use crate::api;
use crate::app::create::Template;
use crate::app::Desktop;
use crate::theme::{radius, Theme};
use crate::ui::{empty_line, error_line, pill_button, Tone, Type};

use super::count;
use super::services::service_mark;

impl Desktop {
    pub(super) fn load_store_templates(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let work = async move { api.client.rpc::<Vec<Template>>("bots/templates", Some(&space_id), json!({})).await };
        self.call(window, cx, work, |this, result, _, _| {
            this.store.templates = Some(result.map_err(|error| api::explain(&error)));
        });
    }

    /// Opens the template's review, where the person names the agent before it is made, or the
    /// agent an earlier add already made.
    fn add_from_template(&mut self, template: Template, window: &mut Window, cx: &mut Context<Self>) {
        if template.bot_id.as_deref().is_none_or(|id| self.agent(id).is_none()) {
            self.open_templates(window, cx);
        }
        self.pick_template(template, window, cx);
    }

    pub(super) fn render_store_agents(
        &mut self,
        theme: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let templates = match &self.store.templates {
            None => return empty_line("Loading agents…", theme).pt_2().into_any_element(),
            Some(Err(problem)) => {
                return div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap_3()
                    .child(error_line(problem.clone(), theme))
                    .child(
                        pill_button("templates-retry", "Try again", Tone::Quiet, true, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.load_store_templates(window, cx))),
                    )
                    .into_any_element()
            }
            Some(Ok(templates)) => templates.clone(),
        };
        let query = self.store.query.read(cx).value().to_string();
        let shown: Vec<Template> = templates.into_iter().filter(|template| template.matches(&query)).collect();
        if shown.is_empty() {
            let line = if query.trim().is_empty() {
                "This server offers no ready-made agents yet."
            } else {
                "No agent matches that search."
            };
            return empty_line(line, theme).pt_2().into_any_element();
        }
        let columns = if window.viewport_size().width > px(1180.) { 2 } else { 1 };
        let cards: Vec<AnyElement> =
            shown.into_iter().map(|template| self.template_card(template, theme, cx)).collect();
        div().grid().grid_cols(columns).gap_x_4().gap_y_1().children(cards).into_any_element()
    }

    fn template_card(&mut self, template: Template, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let made = template.bot_id.as_deref().is_some_and(|id| self.agent(id).is_some());
        let mut details = Vec::new();
        if !template.skills.is_empty() {
            details.push(count(template.skills.len(), "skill"));
        }
        if !template.routines.is_empty() {
            details.push(count(template.routines.len(), "routine"));
        }
        let hover = theme.raised.opacity(0.4);
        let picked = template.clone();
        let action = pill_button(
            SharedString::from(format!("template-add-{}", template.id)),
            if made { "Open" } else { "Add" },
            Tone::Quiet,
            true,
            theme,
        );
        div()
            .id(SharedString::from(format!("template-{}", template.id)))
            .flex()
            .items_center()
            .gap_3()
            .p_2()
            .rounded(radius::CARD)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(move |this, _, window, cx| this.add_from_template(picked.clone(), window, cx)))
            .child(service_mark(&template.name, &template.id, theme))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().item().font_weight(FontWeight::SEMIBOLD).truncate().child(template.name.clone()))
                    .child(div().body().text_color(theme.ink_secondary).truncate().child(template.summary.clone()))
                    .when(!details.is_empty(), |cell| {
                        cell.child(div().meta().text_color(theme.ink_tertiary).child(details.join(" · ")))
                    }),
            )
            .child(action)
            .into_any_element()
    }
}
