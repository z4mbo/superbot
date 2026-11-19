use gpui_kit::component::input::Input;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::{AgentSummary, GroupSummary, Target};
use crate::app::{Desktop, DialogKind, MenuKind, View};
use crate::theme::{mix, radius, ActiveTheme, Theme, SIDEBAR_WIDTH};
use crate::ui::corner::Corner;
use crate::ui::{bot_avatar, empty_line, icon, person_face, Type};

impl Desktop {
    pub fn render_sidebar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let query = self.search.read(cx).value().trim().to_lowercase();
        let matches = |name: &str| query.is_empty() || name.to_lowercase().contains(&query);
        let open = self.chat.as_ref().filter(|_| self.view == View::Chat).map(|chat| chat.target.clone());

        let agents: Vec<AgentSummary> = self.agents().iter().filter(|agent| matches(&agent.name)).cloned().collect();
        let groups: Vec<GroupSummary> = self.groups().iter().filter(|group| matches(&group.name)).cloned().collect();
        let (pinned, listed): (Vec<_>, Vec<_>) = agents.into_iter().partition(|agent| agent.pinned && query.is_empty());
        let nothing = pinned.is_empty() && listed.is_empty() && groups.is_empty();

        let tiles = (!pinned.is_empty()).then(|| {
            div()
                .flex()
                .flex_wrap()
                .justify_center()
                .gap_1()
                .pt_3p5()
                .pb_4()
                .children(pinned.into_iter().map(|agent| self.render_tile(agent, open.as_ref(), &theme, cx)))
        });
        let rows = div()
            .flex()
            .flex_col()
            .gap_0p5()
            .pb_2()
            .when(tiles.is_none(), |rows| rows.pt_2())
            .children(listed.into_iter().map(|agent| self.render_agent_row(agent, open.as_ref(), &theme, cx)))
            .children(groups.into_iter().map(|group| self.render_group_row(group, open.as_ref(), &theme, cx)));

        div()
            .w(SIDEBAR_WIDTH)
            .h_full()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .bg(theme.panel)
            .border_r_1()
            .border_color(theme.edge)
            .child(self.render_sidebar_top(&theme, window, cx))
            .when(self.search_open, |sidebar| sidebar.child(self.render_search(&theme, cx)))
            .child(
                div()
                    .id("sidebar-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_3()
                    .children(tiles)
                    .child(rows)
                    .when(nothing, |scroll| {
                        scroll.child(div().px_2().pt_2().child(empty_line(
                            if query.is_empty() {
                                "No agents yet. Add one with the plus button."
                            } else {
                                "Nothing matches that search."
                            },
                            &theme,
                        )))
                    }),
            )
            .child(self.render_sidebar_footer(&theme, window, cx))
            .into_any_element()
    }

    fn render_sidebar_top(&mut self, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let creating = self.dialog.as_ref().is_some_and(|dialog| dialog.kind == DialogKind::NewAgent);
        let search = self.corner_control(Corner::Search, self.search_open, theme, window, cx);
        let new = self.corner_control(Corner::New, creating, theme, window, cx);
        let space = self.space.as_ref().map(|space| space.name.clone()).unwrap_or_default();
        let hover = theme.ink_at(0.06);
        div()
            .h(px(56.))
            .flex_shrink_0()
            .flex()
            .items_start()
            .gap_2()
            .pl_2()
            .pr_4()
            .pt_3()
            .window_control_area(WindowControlArea::Drag)
            .child(
                div()
                    .id("space-switcher")
                    .h_9()
                    .min_w_0()
                    .px_2p5()
                    .flex()
                    .items_center()
                    .gap_1()
                    .rounded_full()
                    .cursor_pointer()
                    .occlude()
                    .hover(move |style| style.bg(hover))
                    .on_click(cx.listener(|this, event: &ClickEvent, _, cx| {
                        this.open_menu(MenuKind::Spaces, event.position() + point(px(-8.), px(22.)), cx)
                    }))
                    .child(div().name().truncate().child(space))
                    .child(icon("chevron-down", px(14.), theme.ink_secondary)),
            )
            .child(div().flex_1())
            .child(search.on_click(cx.listener(|this, _, window, cx| {
                this.search_open = !this.search_open;
                if this.search_open {
                    this.search.update(cx, |search, cx| search.focus(window, cx));
                } else {
                    this.search.update(cx, |search, cx| search.set_value("", window, cx));
                }
                cx.notify();
            })))
            .child(new.on_click(cx.listener(|this, _, window, cx| this.open_dialog(DialogKind::NewAgent, window, cx))))
    }

    fn render_search(&mut self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let hover = theme.raised;
        div().px_3().pb_2().pt_0p5().child(
            div()
                .h(px(34.))
                .pl_3()
                .pr_1p5()
                .flex()
                .items_center()
                .gap_2()
                .rounded_full()
                .bg(theme.composer)
                .border_1()
                .border_color(theme.ink_at(0.06))
                .child(icon("search", px(15.), theme.ink_secondary))
                .child(div().flex_1().min_w_0().child(Input::new(&self.search).appearance(false).bordered(false)))
                .child(
                    div()
                        .id("search-close")
                        .size_6()
                        .flex_shrink_0()
                        .rounded_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .hover(move |style| style.bg(hover))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.search_open = false;
                            this.search.update(cx, |search, cx| search.set_value("", window, cx));
                            cx.notify();
                        }))
                        .child(icon("x", px(14.), theme.ink_tertiary)),
                ),
        )
    }

    fn render_tile(
        &mut self,
        agent: AgentSummary,
        open: Option<&Target>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let target = Target::Agent(agent.id.clone());
        let selected = open == Some(&target);
        let fill = if selected { theme.raised } else { theme.panel };
        let hover = if selected { theme.raised } else { mix(theme.panel, theme.raised, 0.5) };
        let menu = agent.id.clone();
        let watch = SharedString::from(format!("tile:{}", agent.id));
        superbot_avatars::watch_region(div().id(SharedString::from(format!("tile-{}", agent.id))), watch.clone())
            .w(px(78.))
            .h(px(92.))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .items_center()
            .px_1()
            .pt_2()
            .rounded(radius::FIELD)
            .bg(fill)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(move |this, _, window, cx| this.open(target.clone(), window, cx)))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                    this.open_menu(MenuKind::Agent(menu.clone()), event.position, cx)
                }),
            )
            .child(
                div()
                    .relative()
                    .child(bot_avatar(agent.avatar(), px(56.), agent.working(), Some(watch), theme, cx))
                    .children(status_dot(&agent, fill, theme).map(|dot| dot.absolute().top(px(-2.)).right(px(-2.)))),
            )
            .child(
                div()
                    .mt_1p5()
                    .w_full()
                    .body()
                    .font_weight(FontWeight::MEDIUM)
                    .text_center()
                    .truncate()
                    .child(agent.name.clone()),
            )
            .into_any_element()
    }

    fn render_agent_row(
        &mut self,
        agent: AgentSummary,
        open: Option<&Target>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let target = Target::Agent(agent.id.clone());
        let selected = open == Some(&target);
        let fill = if selected { theme.raised } else { theme.panel };
        let preview = if agent.waiting_on_you() {
            ("Waiting for you".to_owned(), theme.warning)
        } else if agent.working() {
            ("Working…".to_owned(), theme.ink_secondary)
        } else {
            (agent.preview.clone(), theme.ink_secondary)
        };
        let menu = agent.id.clone();
        let watch = SharedString::from(format!("row:{}", agent.id));
        let face = div()
            .relative()
            .child(bot_avatar(agent.avatar(), px(42.), agent.working(), Some(watch.clone()), theme, cx))
            .children(status_dot(&agent, fill, theme).map(|dot| dot.absolute().bottom(px(-1.)).right(px(-1.))));
        superbot_avatars::watch_region(
            row(
                SharedString::from(format!("agent-{}", agent.id)),
                face,
                agent.name.clone(),
                preview,
                agent.unread,
                selected,
                theme,
            ),
            watch,
        )
        .on_click(cx.listener(move |this, _, window, cx| this.open(target.clone(), window, cx)))
        .on_mouse_down(
            MouseButton::Right,
            cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                this.open_menu(MenuKind::Agent(menu.clone()), event.position, cx)
            }),
        )
        .into_any_element()
    }

    fn render_group_row(
        &mut self,
        group: GroupSummary,
        open: Option<&Target>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let target = Target::Group(group.id.clone());
        let selected = open == Some(&target);
        let face = self.target_face(&target, px(42.), None, theme, cx);
        let preview = if group.preview.is_empty() {
            group.members.iter().map(|member| member.name.as_str()).collect::<Vec<_>>().join(", ")
        } else {
            group.preview.clone()
        };
        row(
            SharedString::from(format!("group-{}", group.id)),
            face,
            group.name.clone(),
            (preview, theme.ink_secondary),
            group.unread,
            selected,
            theme,
        )
        .on_click(cx.listener(move |this, _, window, cx| this.open(target.clone(), window, cx)))
        .into_any_element()
    }

    fn render_sidebar_footer(&mut self, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let name = self.me.as_ref().map(|me| me.name.clone()).unwrap_or_default();
        let plugins = self.corner_control(Corner::Plugins, self.view == View::Store, theme, window, cx);
        let workspace = self.corner_control(Corner::Workspace, self.view == View::Workspace, theme, window, cx);
        let ink = theme.ink_secondary;
        div()
            .px_4()
            .pb_4()
            .pt_2()
            .flex()
            .items_center()
            .gap_2()
            .child(
                div().flex_1().min_w_0().child(
                    div()
                        .id("profile")
                        .flex()
                        .items_center()
                        .gap_2()
                        .cursor_pointer()
                        .hover(move |style| style.text_color(ink))
                        .on_click(cx.listener(|this, event: &ClickEvent, _, cx| {
                            this.open_menu(MenuKind::Profile, event.position() + point(px(-12.), px(-18.)), cx)
                        }))
                        .child(person_face(&name, px(36.), theme))
                        .child(div().name().truncate().child(name)),
                ),
            )
            .child(plugins.on_click(cx.listener(|this, _, window, cx| this.show(View::Store, window, cx))))
            .child(workspace.on_click(cx.listener(|this, _, window, cx| this.show(View::Workspace, window, cx))))
    }
}

/// One conversation in the list: its face, its name, the last thing said.
fn row(
    id: SharedString,
    face: Div,
    name: String,
    (preview, preview_ink): (String, Hsla),
    unread: bool,
    selected: bool,
    theme: &Theme,
) -> Stateful<Div> {
    let hover = if selected { theme.raised } else { theme.raised.opacity(0.5) };
    div()
        .id(id)
        .h(px(54.))
        .w_full()
        .flex()
        .items_center()
        .gap_2p5()
        .px_2()
        .rounded(radius::FIELD)
        .cursor_pointer()
        .when(selected, |row| row.bg(theme.raised))
        .hover(move |style| style.bg(hover))
        .child(face.m(px(-3.)))
        .child(div().flex_1().min_w_0().child(div().name().truncate().child(name)).when(!preview.is_empty(), |text| {
            text.pt(px(1.)).child(div().mt(px(2.)).body().text_color(preview_ink).truncate().child(preview))
        }))
        .when(unread, |row| row.child(div().size_2().flex_shrink_0().rounded_full().bg(theme.accent)))
}

/// The mark on a face for what its bot is doing, ringed in the surface it sits on.
fn status_dot(agent: &AgentSummary, surface: Hsla, theme: &Theme) -> Option<Div> {
    let tone = if agent.waiting_on_you() {
        theme.warning
    } else if agent.working() {
        theme.success
    } else {
        return None;
    };
    Some(div().size_3().rounded_full().bg(tone).border_2().border_color(surface))
}
