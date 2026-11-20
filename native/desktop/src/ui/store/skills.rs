use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use superbot_features::{AgentSkillEntry, AgentSkillSource, Features};

use crate::api::{self, ManifestPart, PluginVersion};
use crate::app::Desktop;
use crate::theme::Theme;
use crate::ui::{empty_line, error_line, icon, pill_button, Tone, Type};

use super::marketplace::Shelf;

fn source_label(source: &AgentSkillSource) -> &'static str {
    match source {
        AgentSkillSource::Builtin => "Built in",
        AgentSkillSource::Plugin => "From a plugin",
        AgentSkillSource::User => "Added here",
    }
}

fn has_skill(version: &PluginVersion) -> bool {
    version.manifest.parts.iter().any(|part| matches!(part, ManifestPart::Skill { .. }))
}

impl Desktop {
    pub(super) fn load_store_skills(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.as_ref(), self.space_id()) else { return };
        let features = Features::new(api.client.clone());
        let work = async move { features.space(space_id).agent_skills().await };
        self.call(window, cx, work, |this, result, _, _| {
            this.store.skills = Some(result.map_err(|error| api::explain(&error)));
        });
        if self.store.marketplace.unread() {
            self.load_marketplace(window, cx);
        }
    }

    pub(super) fn render_store_skills(&mut self, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let query = self.store.query.read(cx).value().trim().to_lowercase();
        let matches = |text: &str| query.is_empty() || text.to_lowercase().contains(&query);

        let space = match &self.store.skills {
            None => Some(empty_line("Loading skills…", theme).into_any_element()),
            Some(Err(problem)) => Some(
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap_3()
                    .child(error_line(problem.clone(), theme))
                    .child(
                        pill_button("skills-retry", "Try again", Tone::Quiet, true, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.load_store_skills(window, cx))),
                    )
                    .into_any_element(),
            ),
            Some(Ok(skills)) => {
                let shown: Vec<&AgentSkillEntry> =
                    skills.iter().filter(|skill| matches(&skill.name) || matches(&skill.description)).collect();
                (!shown.is_empty()).then(|| {
                    div()
                        .flex()
                        .flex_col()
                        .children(shown.into_iter().map(|skill| skill_row(skill, theme)))
                        .into_any_element()
                })
            }
        };
        let space = space.map(|list| {
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(div().section().child("In this Space"))
                .child(div().body().text_color(theme.ink_tertiary).pb_1().child("Every agent here can use these."))
                .child(list)
                .into_any_element()
        });

        let plugins: Vec<PluginVersion> = if self.store.loaded {
            self.store
                .latest(&query)
                .into_iter()
                .filter(|version| has_skill(version))
                .filter(|version| matches(&version.manifest.name) || matches(&version.manifest.description))
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        let plugins = (!plugins.is_empty()).then(|| {
            let columns = if window.viewport_size().width > px(1180.) { 2 } else { 1 };
            let cards: Vec<AnyElement> = plugins.into_iter().map(|version| self.render_card(version, theme, cx)).collect();
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(div().section().child("Choose for each agent"))
                .child(div().grid().grid_cols(columns).gap_x_4().gap_y_1().children(cards))
                .into_any_element()
        });

        let packs = self.render_marketplace_section(Shelf::SkillPacks, theme, cx);
        if space.is_none() && plugins.is_none() && packs.is_none() {
            return empty_line("No skill matches that search.", theme).pt_2().into_any_element();
        }
        div().flex().flex_col().gap_6().children(space).children(plugins).children(packs).into_any_element()
    }
}

fn skill_row(skill: &AgentSkillEntry, theme: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap_3()
        .p_2()
        .child(
            div()
                .size(px(32.))
                .flex_shrink_0()
                .rounded_full()
                .bg(theme.control.opacity(0.7))
                .flex()
                .items_center()
                .justify_center()
                .child(icon("sparkles", px(15.), theme.ink_secondary)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(div().name().truncate().child(skill.name.clone()))
                .when(!skill.description.is_empty(), |cell| {
                    cell.child(div().body().text_color(theme.ink_secondary).truncate().child(skill.description.clone()))
                }),
        )
        .child(div().meta().text_color(theme.ink_tertiary).child(source_label(&skill.source)))
}
