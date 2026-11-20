use gpui_kit::component::input::Input;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use superbot_features::ThinkingLevel;

use super::{level_label, Act, Gutter, Line, Spot, Trailing};
use crate::app::Desktop;
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::new_menu::menu_shadow;
use crate::ui::{icon, Type};

fn gutter(gutter: Gutter, theme: &Theme) -> Div {
    let glyph = match gutter {
        Gutter::Blank => None,
        Gutter::Hosted => Some("sparkles"),
        Gutter::Local => Some("monitor"),
        Gutter::Thinking => Some("lightbulb"),
        Gutter::Manage => Some("settings"),
        Gutter::Recheck => Some("refresh-cw"),
    };
    div()
        .w(px(16.))
        .flex_shrink_0()
        .flex()
        .justify_center()
        .children(glyph.map(|glyph| icon(glyph, px(15.), theme.ink_secondary)))
}

impl Desktop {
    fn model_line(&self, line: Line, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let hover = theme.ink_at(0.06);
        let highlight = self.model_menu.highlight;
        match line {
            Line::Separator => div().my_1().mx_2().h(px(1.)).bg(theme.hairline.opacity(0.5)).into_any_element(),
            Line::Label(text, mark) => div()
                .mt_1()
                .pl(px(6.))
                .pr_2()
                .h(px(28.))
                .flex()
                .items_center()
                .gap_2()
                .meta()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink_tertiary)
                .child(gutter(mark, theme))
                .child(div().min_w_0().truncate().child(text))
                .into_any_element(),
            Line::Status(text) => div()
                .h(px(32.))
                .pl(px(6.))
                .pr_2()
                .flex()
                .items_center()
                .gap_2()
                .item()
                .text_color(theme.ink_tertiary)
                .child(
                    div()
                        .w(px(16.))
                        .flex()
                        .justify_center()
                        .child(Spinner::new().with_size(px(14.)).color(theme.ink_tertiary)),
                )
                .child(div().min_w_0().truncate().child(text))
                .into_any_element(),
            Line::Note(text) | Line::Hint(text) => {
                div().px_2().pt_0p5().pb_1p5().meta().text_color(theme.ink_tertiary).child(text).into_any_element()
            }
            Line::Effort { first, levels, current } => {
                let pill = |index: usize, level: Option<ThinkingLevel>, cx: &mut Context<Self>| {
                    let pressed = level == current;
                    let lit = highlight == Some(Spot { row: first + index, star: false });
                    div()
                        .id(("model-effort", index))
                        .h(px(32.))
                        .px_1p5()
                        .flex_1()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_full()
                        .body()
                        .cursor_pointer()
                        .truncate()
                        .text_color(if pressed { theme.ink } else { theme.ink_secondary })
                        .when(pressed, |pill| pill.bg(theme.ink_at(0.1)).font_weight(FontWeight::MEDIUM))
                        .when(lit && !pressed, |pill| pill.bg(hover))
                        .hover(move |style| style.text_color(theme.ink))
                        .on_click(
                            cx.listener(move |this, _, window, cx| this.model_menu_act(Act::Effort(level), window, cx)),
                        )
                        .child(level_label(level))
                };
                let pills: Vec<_> =
                    levels.into_iter().enumerate().map(|(index, level)| pill(index, level, cx)).collect();
                div().m_1().p(px(3.)).flex().rounded_full().bg(theme.ink_at(0.05)).children(pills).into_any_element()
            }
            Line::Row { nav, label, meta, gutter: mark, trailing, star, quiet } => {
                let lit = highlight.is_some_and(|spot| spot.row == nav && !spot.star);
                let star_lit = highlight == Some(Spot { row: nav, star: true });
                let group = SharedString::from(format!("model-row-{nav}"));
                let act = self.model_menu.nav.get(nav).map(|stop| stop.act.clone());
                let key = self.model_menu.nav.get(nav).and_then(|stop| stop.star.clone());
                let trailing = match trailing {
                    Trailing::None => None,
                    Trailing::Check => Some(icon("check", px(14.), theme.ink).into_any_element()),
                    Trailing::Chevron(glyph) => Some(icon(glyph, px(16.), theme.ink_tertiary).into_any_element()),
                    Trailing::Value(value, glyph) => Some(
                        div()
                            .flex()
                            .items_center()
                            .gap_1()
                            .text_color(theme.ink_secondary)
                            .child(value)
                            .child(icon(glyph, px(16.), theme.ink_tertiary))
                            .into_any_element(),
                    ),
                };
                let row = div()
                    .id(("model-row", nav))
                    .w_full()
                    .min_h(px(if meta.is_some() { 40. } else { 32. }))
                    .py_1()
                    .pl(px(6.))
                    .pr(if star.is_some() { px(34.) } else { px(8.) })
                    .flex()
                    .items_center()
                    .gap_2()
                    .rounded(radius::MENU_ROW)
                    .cursor_pointer()
                    .when(lit, |row| row.bg(hover))
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if let Some(act) = act.clone() {
                            this.model_menu_act(act, window, cx);
                        }
                    }))
                    .child(gutter(mark, theme))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .item()
                                    .text_color(if quiet { theme.ink_secondary } else { theme.ink })
                                    .truncate()
                                    .child(label.clone()),
                            )
                            .children(
                                meta.map(|meta| div().meta().text_color(theme.ink_tertiary).truncate().child(meta)),
                            ),
                    )
                    .children(trailing);
                let star = star.zip(key).map(|(starred, key)| {
                    let shown = starred || star_lit;
                    let name = if starred {
                        format!("Remove {label} from favorites")
                    } else {
                        format!("Add {label} to favorites")
                    };
                    div()
                        .id(("model-star", nav))
                        .absolute()
                        .right(px(6.))
                        .top_0()
                        .bottom_0()
                        .my_auto()
                        .size_6()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .cursor_pointer()
                        .occlude()
                        .when(!shown, |star| star.opacity(0.))
                        .group_hover(group.clone(), |style| style.opacity(1.))
                        .when(star_lit, |star| star.bg(hover))
                        .hover(move |style| style.bg(hover))
                        .tooltip(move |window, cx| {
                            gpui_kit::component::tooltip::Tooltip::new(name.clone()).build(window, cx)
                        })
                        .on_click(cx.listener(move |this, _, _, cx| this.toggle_favorite(&key, cx)))
                        .child(icon("star", px(13.), if starred { theme.warning } else { theme.ink_tertiary }))
                });
                div().group(group).relative().child(row).children(star).into_any_element()
            }
        }
    }

    /// The agent's model in a popover like the Simple menu: the current model pinned, then each
    /// source's suggestions, thinking where the model takes it, and the way to manage models.
    pub fn render_model_menu(&mut self, bot_id: &str, viewport: Size<Pixels>, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let hover = theme.ink_at(0.06);
        let trigger = self.model_menu.bounds(self.model_menu.trigger).get();
        let (menu_edge, button_edge) = if trigger.center().x > viewport.width / 2. {
            (Anchor::TopRight, Anchor::BottomRight)
        } else {
            (Anchor::TopLeft, Anchor::BottomLeft)
        };
        let margin = px(8.);
        let gap = px(6.);
        let available = (viewport.height - trigger.bottom()).max(trigger.top()) - gap - margin;
        let query = self.model_menu_query(cx);
        let sheet = self.model_sheet(bot_id, &query);
        self.model_menu.search_shown = sheet.search;
        self.model_menu.nav = sheet.nav;
        if self.model_menu.fresh && !self.model_menu.nav.is_empty() {
            self.model_menu.fresh = false;
            self.model_menu.highlight = (!sheet.search).then_some(Spot { row: 0, star: false });
        }
        if let Some(spot) = self.model_menu.highlight.filter(|spot| spot.row >= self.model_menu.nav.len()) {
            self.model_menu.highlight =
                Some(Spot { row: spot.row.min(self.model_menu.nav.len().saturating_sub(1)), star: false });
        }

        let search = sheet.search.then(|| self.model_menu.query.clone()).flatten().map(|input| {
            let clear = (!query.is_empty()).then(|| {
                div()
                    .id("model-search-clear")
                    .size_5()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(|this, _, window, cx| {
                        if let Some(query) = &this.model_menu.query {
                            query.update(cx, |query, cx| query.set_value("", window, cx));
                        }
                        cx.notify();
                    }))
                    .child(icon("x", px(14.), theme.ink_tertiary))
            });
            div()
                .h(px(36.))
                .flex_shrink_0()
                .pl(px(14.))
                .pr_2()
                .flex()
                .items_center()
                .gap_2()
                .border_b_1()
                .border_color(theme.ink_at(0.1))
                .child(icon("search", px(16.), theme.ink_tertiary))
                .child(div().flex_1().min_w_0().body().child(Input::new(&input).appearance(false).bordered(false)))
                .children(clear)
        });
        let lines: Vec<AnyElement> = sheet.lines.into_iter().map(|line| self.model_line(line, &theme, cx)).collect();
        let footer: Vec<AnyElement> = sheet.footer.into_iter().map(|line| self.model_line(line, &theme, cx)).collect();

        let mut sheet = div()
            .id("model-menu")
            .w(px(324.).min((viewport.width - margin * 2.).max(px(0.))))
            .max_h(px(480.).min(available.max(px(0.))))
            .flex()
            .flex_col()
            .rounded(radius::CARD)
            .bg(theme.menu)
            .border_1()
            .border_color(theme.hairline.opacity(0.5))
            .shadow(menu_shadow(&theme))
            .occlude()
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if this.model_menu_key(event, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .when(self.model_menu.saving, |sheet| sheet.opacity(0.7))
            .children(search)
            .child(
                div()
                    .id("model-menu-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p(px(6.))
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .children(lines),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .px(px(6.))
                    .pb(px(6.))
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .when_some(self.model_menu.problem.clone(), |footer, problem| {
                        footer.child(div().px_2().py_1().body().text_color(theme.danger).child(problem))
                    })
                    .children(footer),
            );
        if let Some(focus) = self.model_menu.focus.as_ref() {
            sheet = sheet.track_focus(focus);
        }

        div()
            .id("menu-backdrop")
            .absolute()
            .inset_0()
            .occlude()
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| this.close_model_menu(cx)))
            .on_mouse_down(MouseButton::Right, cx.listener(|this, _, _, cx| this.close_model_menu(cx)))
            .child(
                deferred(
                    anchored()
                        .anchor(menu_edge)
                        .attach(trigger, button_edge)
                        .offset(point(px(0.), gap))
                        .snap_to_window_with_margin(margin)
                        .child(sheet),
                )
                .with_priority(1),
            )
            .into_any_element()
    }
}
