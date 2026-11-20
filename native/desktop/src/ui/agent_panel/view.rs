use super::*;
use crate::ui::focus::{self, Ring};
use crate::ui::model_menu::{self, ModelTrigger};
use crate::ui::motion::{self, Colors, Pointer};
use crate::ui::{drag_region, MANUAL_WINDOW_DRAG};

impl Desktop {
    pub(in crate::ui) fn render_agent_panel(
        &mut self,
        layout: PanelLayout,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let panel = self.agent_panel.as_ref()?;
        let theme = cx.skin().clone();
        let id = panel.agent_id.clone();
        let summary = self.agent(&id).cloned();
        let bot = self.agent_info.bot(&id).cloned();

        let header = drag_region(div(), "agent-panel-drag", window, cx)
            .h(px(56.))
            .flex_shrink_0()
            .flex()
            .items_start()
            .gap(px(10.))
            .pl(px(11.))
            .pr(px(13.))
            .pt_3()
            .child(round_button("agent-settings", "settings", panel.settings, &theme, |button| {
                button
                    .when(MANUAL_WINDOW_DRAG, |button| button.occlude())
                    .tooltip(|window, cx| Tooltip::new("Agent settings").build(window, cx))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(panel) = this.agent_panel.as_mut() {
                            panel.settings = !panel.settings;
                            panel.screen = None;
                            panel.terminal = None;
                            panel.editing = None;
                        }
                        cx.notify();
                    }))
            }))
            .child(div().flex_1())
            .child(round_button("agent-panel-close", "x", false, &theme, |button| {
                button
                    .when(MANUAL_WINDOW_DRAG, |button| button.occlude())
                    .tooltip(|window, cx| Tooltip::new("Close").build(window, cx))
                    .on_click(cx.listener(|this, _, _, cx| this.close_agent_panel(cx)))
            }))
            .when(cfg!(not(target_os = "macos")), |header| header.mr(crate::theme::CAPTION_WIDTH));

        let body = match bot.as_ref() {
            None => div()
                .pt_10()
                .flex()
                .justify_center()
                .child(Spinner::new().with_size(px(16.)).color(theme.ink_tertiary))
                .into_any_element(),
            Some(bot) if panel.settings => self.render_agent_settings(bot, &theme, cx).into_any_element(),
            Some(bot) if panel.page.is_some() => self.render_library_page(bot, &theme, cx),
            Some(bot) => {
                let avatar = look::avatar_of(bot);
                let working = summary.as_ref().is_some_and(|agent| agent.working());
                let tab = panel.tab;
                div()
                    .flex()
                    .flex_col()
                    .child(self.render_hero(bot, working, &theme, cx))
                    .child(tabs(tab, &theme, window, cx))
                    .child(match tab {
                        PanelTab::Details => self.render_details(bot, &theme, window, cx),
                        PanelTab::Library => self.render_library(&theme, cx),
                        PanelTab::Computer => self.render_computer(bot, avatar, &theme, window, cx),
                        PanelTab::Inbox => self.render_agent_inbox(bot, &theme, cx),
                    })
                    .into_any_element()
            }
        };
        let problem = self.agent_panel.as_ref().and_then(|panel| panel.problem.clone());
        let showing_terminal = self.agent_panel.as_ref().is_some_and(|panel| panel.terminal.is_some());
        let showing_screen = showing_terminal || self.agent_panel.as_ref().is_some_and(|panel| panel.screen.is_some());
        let screen = match bot.as_ref() {
            Some(bot) if showing_terminal => {
                let name = bot.name.clone();
                Some(self.render_terminal(&name, window, &theme, cx))
            }
            Some(bot) if showing_screen => {
                let name = bot.name.clone();
                Some(self.render_screen(&name, window, &theme, cx))
            }
            _ => None,
        };

        let panel = div()
            .id("agent-panel")
            .w(PANEL_WIDTH)
            .h_full()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .bg(theme.app)
            .border_l_1()
            .border_color(theme.ink_at(0.06))
            .occlude()
            .child(header)
            .children(screen)
            .when(!showing_screen, |panel| {
                panel.child(
                    div()
                        .id("agent-panel-body")
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scroll()
                        .px_4()
                        .pb(px(28.))
                        .children(problem.map(|problem| div().pt_3().child(error_line(problem, &theme))))
                        .child(body),
                )
            });
        if layout.visible == PANEL_WIDTH && layout.occupied == PANEL_WIDTH {
            return Some(panel.into_any_element());
        }
        Some(
            div()
                .relative()
                .w(layout.occupied)
                .h_full()
                .flex_shrink_0()
                .child(
                    div()
                        .absolute()
                        .right_0()
                        .top_0()
                        .w(layout.visible)
                        .h_full()
                        .overflow_hidden()
                        .child(panel.absolute().left_0().top_0()),
                )
                .into_any_element(),
        )
    }

    fn render_hero(&self, bot: &Bot, working: bool, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let editing = self.agent_panel.as_ref().and_then(|panel| panel.editing.as_ref());
        let line_editor = |field: Field| match editing {
            Some((editing, Editor::Line(state))) if *editing == field => Some(state.clone()),
            _ => None,
        };
        let hover = theme.ink_at(0.04);
        let name = match line_editor(Field::Name) {
            Some(state) => inline_field(&state, px(220.), theme).into_any_element(),
            None => div()
                .id("agent-rename")
                .max_w_full()
                .px_1p5()
                .rounded(radius::FIELD)
                .text_size(px(17.))
                .line_height(px(24.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink)
                .truncate()
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .tooltip(|window, cx| Tooltip::new("Rename").build(window, cx))
                .on_click(cx.listener(|this, _, window, cx| this.edit(Field::Name, window, cx)))
                .child(bot.name.clone())
                .into_any_element(),
        };
        let description = bot.description.trim().to_owned();
        let job = match line_editor(Field::Description) {
            Some(state) => Some(inline_field(&state, px(200.), theme).mt(px(3.)).into_any_element()),
            None => (!description.is_empty()).then(|| {
                div()
                    .id("agent-job")
                    .mt(px(1.))
                    .max_w_full()
                    .px_1p5()
                    .rounded(px(6.))
                    .body()
                    .text_color(theme.ink_secondary)
                    .truncate()
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(|this, _, window, cx| this.edit(Field::Description, window, cx)))
                    .child(description)
                    .into_any_element()
            }),
        };
        div()
            .mt(px(14.))
            .flex()
            .flex_col()
            .items_center()
            .child(self.render_look_avatar(bot, working, theme, cx))
            .child(div().mt_2().max_w_full().flex().justify_center().child(name))
            .children(job)
    }

    fn render_details(&self, bot: &Bot, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let model = self.chat_model_label(&bot.id).unwrap_or_else(|| "Choose a model".to_owned());
        let chosen = self.selected_local_model().is_some()
            || bot.model_provider.as_ref().zip(bot.model_id.as_ref()).is_some()
            || self.agent_info.main_choice().is_some();
        let open = self.model_menu_is_open(ModelTrigger::Details);
        let turn = motion::value("details-model-chevron", f32::from(open), motion::SLIDE, motion::EMPHASIS, window, cx);
        let pill = self
            .model_menu_button(ModelTrigger::Details, cx)
            .role(Role::Button)
            .aria_label("Model")
            .h_7()
            .min_w_0()
            .pl(px(10.))
            .pr(px(8.))
            .flex()
            .items_center()
            .gap_1()
            .rounded_full()
            .cursor_pointer()
            .children(self.chat_model_mark(&bot.id).map(|mark| model_menu::mark_icon(mark, px(14.), None, theme)))
            .child(
                div()
                    .min_w_0()
                    .body()
                    .text_color(if chosen { theme.ink } else { theme.ink_secondary })
                    .truncate()
                    .child(model),
            )
            .child(
                icon("chevron-down", px(14.), theme.ink_tertiary)
                    .with_transformation(Transformation::rotate(radians(std::f32::consts::PI * turn))),
            );
        let model_row = div()
            .flex()
            .items_center()
            .gap(px(10.))
            .min_h(px(46.))
            .px(px(14.))
            .child(icon("sparkles", px(16.), theme.ink_secondary))
            .child(div().flex_1().name().text_color(theme.ink).child("Model"))
            .child(
                focus::control(pill, Ring::InnerPill, theme)
                    .fill(Pointer::BUTTON.held(open), Colors::ink(theme, 0., 0.06, 0.08)),
            );
        let hover = theme.ink_at(0.04);
        let link =
            |id: &'static str, glyph: &'static str, label: &'static str, section: Section, cx: &mut Context<Self>| {
                div()
                    .id(id)
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .min_h(px(46.))
                    .px(px(14.))
                    .rounded(radius::FIELD)
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(move |this, _, window, cx| this.show_workspace_section(section, window, cx)))
                    .child(icon(glyph, px(16.), theme.ink_secondary))
                    .child(div().flex_1().name().text_color(theme.ink).child(label))
                    .child(icon("chevron-right", px(15.), theme.ink_tertiary))
            };
        div()
            .pt_2()
            .flex()
            .flex_col()
            .child(model_row)
            .child(self.render_conversations(&bot.id, theme, cx))
            .child(card_label("In this space", theme))
            .child(link("agent-routines", "calendar-clock", "Routines", Section::Routines, cx))
            .child(link("agent-approvals", "shield-check", "Approvals", Section::Approvals, cx))
            .child(link("agent-activity", "activity", "Activity", Section::Activity, cx))
            .into_any_element()
    }
}
