use gpui_kit::component::input::Input;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::{AgentSummary, GroupSummary, Target};
use crate::app::{Desktop, MenuKind, View};
use crate::theme::{mix, radius, ActiveTheme, Theme, SIDEBAR_WIDTH};
use crate::ui::corner::Corner;
use crate::ui::tile_preview::tile_preview;
use crate::ui::{bot_avatar, empty_line, icon, person_face, Type};

impl Desktop {
    pub fn render_sidebar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let query = if self.search_open { self.search.read(cx).value().trim().to_lowercase() } else { String::new() };
        let matches = |name: &str| query.is_empty() || name.to_lowercase().contains(&query);
        let open = self.chat.as_ref().filter(|_| self.view == View::Chat).map(|chat| chat.target.clone());

        let groups: Vec<GroupSummary> = self.groups().iter().filter(|group| matches(&group.name)).cloned().collect();
        let mut pinned = Vec::new();
        let mut listed = Vec::new();
        for agent in self.agents().iter().filter(|agent| matches(&agent.name)) {
            let primary = superbot_avatars::primary_tile(&agent.name, cx);
            if query.is_empty() && (primary || agent.pinned) {
                pinned.push((primary, agent.clone()));
            } else {
                listed.push(agent.clone());
            }
        }
        let found = self.search_open.then(|| self.render_message_search(&theme, cx)).flatten();
        let nothing = pinned.is_empty() && listed.is_empty() && groups.is_empty() && found.is_none();

        if pinned.is_empty() {
            self.forget_tile_preview();
        }
        let tiles = (!pinned.is_empty()).then(|| {
            pinned.sort_by_key(|(primary, _)| !*primary);
            div().flex().flex_wrap().justify_center().gap_1().pt_3p5().pb_4().children(
                pinned
                    .into_iter()
                    .map(|(primary, agent)| self.render_tile(agent, primary, open.as_ref(), &theme, window, cx)),
            )
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
                    .children(found)
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
        let creating = self.menu.as_ref().is_some_and(|menu| menu.kind == MenuKind::New) || self.creating_agent();
        let search = self.corner_control(Corner::Search, self.search_open, theme, window, cx);
        let new = self.corner_control(Corner::New, creating, theme, window, cx);
        let space = self.space.as_ref().map(|space| space.name.clone()).filter(|_| self.spaces.len() > 1);
        let hover = theme.ink_at(0.06);
        div()
            .h(px(56.))
            .flex_shrink_0()
            .flex()
            .items_start()
            .gap_2p5()
            .pl_2()
            .pr_4()
            .pt_3()
            .window_control_area(WindowControlArea::Drag)
            .children(space.map(|space| {
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
                    .child(icon("chevron-down", px(14.), theme.ink_secondary))
            }))
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
            .child(new.on_click(cx.listener(|this, _, window, cx| this.open_new_menu(window, cx))))
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
        primary: bool,
        open: Option<&Target>,
        theme: &Theme,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let target = Target::Agent(agent.id.clone());
        let selected = open.and_then(Target::agent) == Some(agent.id.as_str());
        let fill = if selected { theme.raised } else { theme.panel };
        let hover = if selected { theme.raised } else { mix(theme.panel, theme.raised, 0.5) };
        let menu = agent.id.clone();
        let keys = agent.id.clone();
        let focus = self.tile_focus(&agent.id, cx);
        let ring = focus.is_focused(window) && window.last_input_was_keyboard();
        let bounds = self.tile_bounds(&agent.id);
        let shape = if primary { radius::CARD } else { radius::FIELD };
        let watch = SharedString::from(format!("tile:{}", agent.id));
        let width = px(if primary { 95. } else { 78. });
        let quote = latest_line(&agent).0;
        let preview = (self.tile_preview_shown(&agent.id) && !quote.is_empty())
            .then(|| div().absolute().top_0().left_0().child(tile_preview(&agent, quote.clone(), width, theme, cx)));
        let hovered = (agent.id.clone(), !quote.is_empty());
        superbot_avatars::watch_region(div().id(SharedString::from(format!("tile-{}", agent.id))), watch.clone())
            .group("bot-tile")
            .relative()
            .w(width)
            .h(px(92.))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .items_center()
            .px_1()
            .pt(px(if primary { 4. } else { 8. }))
            .rounded(shape)
            .bg(fill)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .track_focus(&focus)
            // A pointer press leaves focus where opening the bot puts it, on the composer.
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if this.tile_key(&keys, &event.keystroke, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .when(quote.is_empty(), |tile| {
                let name = SharedString::from(agent.name.clone());
                tile.tooltip(move |window, cx| Tooltip::new(name.clone()).build(window, cx))
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                this.close_tile_preview(cx);
                this.open(target.clone(), window, cx)
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                    this.close_tile_preview(cx);
                    this.open_menu(MenuKind::Agent(menu.clone()), event.position, cx)
                }),
            )
            .child(
                // GPUI (gpui-pre 0.3.12) takes one on_hover per element; the avatar watch region has the tile's.
                div().id("tile-rest").absolute().inset_0().on_hover(cx.listener(
                    move |this, hovering: &bool, _, cx| this.hover_tile(&hovered.0, *hovering, hovered.1, cx),
                )),
            )
            .child(canvas(move |drawn, _, _| bounds.set(drawn), |_, _, _, _| {}).absolute().inset_0())
            .children(preview)
            .child(
                div()
                    .relative()
                    .child(bot_avatar(
                        agent.avatar(),
                        px(if primary { 60. } else { 56. }),
                        agent.working(),
                        Some(watch),
                        theme,
                        cx,
                    ))
                    .when(primary, |avatar| {
                        avatar.child(
                            div()
                                .absolute()
                                .right(px(-3.))
                                .bottom(px(-3.))
                                .size(px(20.))
                                .rounded_full()
                                .bg(fill)
                                .group_hover("bot-tile", move |style| style.bg(hover))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(
                                    div()
                                        .size_4()
                                        .rounded_full()
                                        .bg(rgb(0xf69412))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .child(icon("tile-star", px(10.), rgb(0xf5f5f5).into())),
                                ),
                        )
                    })
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
            .when(ring, |tile| {
                tile.child(div().absolute().inset_0().rounded(shape).border_2().border_color(theme.focus))
            })
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
        let selected = open.and_then(Target::agent) == Some(agent.id.as_str());
        let fill = if selected { theme.raised } else { theme.panel };
        let preview = match latest_line(&agent) {
            (line, true) => (line, theme.warning),
            (line, false) => (line, theme.ink_secondary),
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

/// What a bot's row and tile preview quote: what it waits on or is doing, else its latest line.
/// The flag marks a wait on the person.
fn latest_line(agent: &AgentSummary) -> (String, bool) {
    if agent.waiting_on_you() {
        ("Waiting for you".to_owned(), true)
    } else if agent.working() {
        ("Working…".to_owned(), false)
    } else {
        (agent.preview.clone(), false)
    }
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
