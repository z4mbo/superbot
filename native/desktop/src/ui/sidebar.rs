use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::base::ElementExt as _;
use gpui_kit::component::input::Input;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::{AgentSummary, GroupSummary, Target};
use crate::app::{Desktop, MenuKind, View};
use crate::theme::{mix, radius, ActiveTheme, Theme, SIDEBAR_WIDTH};
use crate::ui::corner::Corner;
use crate::ui::focus::{self, Ring};
use crate::ui::motion::{Colors, Pointer};
use crate::ui::tile_preview::tile_preview;
use crate::ui::tooltip;
use crate::ui::{
    bot_avatar_with, drag_region, empty_line, face_state, icon, person_face, traffic_lights_reserve, AvatarSlot, Type,
};

impl Desktop {
    pub fn render_sidebar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let query = if self.search_open { self.search.read(cx).value().trim().to_lowercase() } else { String::new() };
        let matches = |name: &str| query.is_empty() || name.to_lowercase().contains(&query);
        let open = self.chat.as_ref().filter(|_| self.view == View::Chat).map(|chat| chat.target.clone());

        let groups: Vec<GroupSummary> = self.groups().iter().filter(|group| matches(&group.name)).cloned().collect();
        let agents = self.agents();
        let primary = primary_agent(agents, self.search_open, |agent| superbot_avatars::primary_tile(&agent.name, cx));
        let mut pinned = Vec::new();
        let mut listed = Vec::new();
        for agent in agents.iter().filter(|agent| matches(&agent.name)) {
            if primary.is_some_and(|primary| primary.id == agent.id) {
                continue;
            }
            if !self.search_open && agent.pinned {
                pinned.push(agent.clone());
            } else {
                listed.push(agent.clone());
            }
        }
        let primary = primary.cloned();
        let roster = primary.is_some() || !(pinned.is_empty() && listed.is_empty() && groups.is_empty());
        let found = self.search_open.then(|| self.render_message_search(roster, &theme, cx)).flatten();
        let nothing = !roster && found.is_none();

        if pinned.is_empty() {
            self.forget_tile_preview();
        }
        let card =
            primary.map(|agent| div().pt_2().child(self.render_primary_card(agent, open.as_ref(), &theme, window, cx)));
        let tiles =
            (!pinned.is_empty()).then(|| {
                div().flex().flex_wrap().justify_center().gap_1().pt_2().pb_4().children(
                    pinned.into_iter().map(|agent| self.render_tile(agent, open.as_ref(), &theme, window, cx)),
                )
            });
        let rows = div()
            .flex()
            .flex_col()
            .gap_1()
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
                    .children(card)
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

    fn render_sidebar_top(&mut self, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> Stateful<Div> {
        let creating = self.menu.as_ref().is_some_and(|menu| menu.kind == MenuKind::New) || self.creating_agent();
        let search = self.corner_control(Corner::Search, self.search_open, theme, window, cx);
        let new = self.corner_control(Corner::New, creating, theme, window, cx);
        let space = self.space.as_ref().map(|space| space.name.clone()).filter(|_| self.spaces.len() > 1);
        let hover = theme.ink_at(0.06);
        let show_space_tooltip =
            !cfg!(target_os = "macos") || !self.menu.as_ref().is_some_and(|menu| menu.kind == MenuKind::Spaces);
        let left = traffic_lights_reserve(window).max(px(8.));
        drag_region(div(), "sidebar-drag", window, cx)
            .h(px(60.))
            .flex_shrink_0()
            .flex()
            .items_start()
            .gap_2p5()
            .pl(left)
            .pr_4()
            .pt_3()
            .children(space.map(|space| {
                let name = StyledText::new(space.clone());
                let layout = name.layout().clone();
                let name = div().id("space-name").name().truncate().child(name);
                let name = name.when(show_space_tooltip, |name| {
                    tooltip::when(name, space.clone().into(), move || layout.text() != space)
                });
                let button = div()
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
                    .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                        this.open_menu(MenuKind::Spaces, event.position() + point(px(-8.), px(22.)), window, cx)
                    }))
                    .child(name)
                    .child(icon("chevron-down", px(14.), theme.ink_secondary));
                focus::control(button, Ring::InnerPill, theme)
            }))
            .child(div().flex_1())
            .child(focus::control(
                search.on_click(cx.listener(|this, _, window, cx| {
                    this.search_open = !this.search_open;
                    if this.search_open {
                        this.search.update(cx, |search, cx| search.focus(window, cx));
                    } else {
                        this.search.update(cx, |search, cx| search.set_value("", window, cx));
                    }
                    cx.notify();
                })),
                Ring::OuterPill,
                theme,
            ))
            .child(focus::control(
                new.on_click(cx.listener(|this, _, window, cx| this.open_new_menu(window, cx))),
                Ring::OuterPill,
                theme,
            ))
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

    fn render_primary_card(
        &mut self,
        agent: AgentSummary,
        open: Option<&Target>,
        theme: &Theme,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let target = Target::Agent(agent.id.clone());
        let selected = open == Some(&target);
        let rest = if selected { theme.raised } else { mix(theme.panel, theme.ink, 0.04) };
        let hover = if selected { theme.raised } else { mix(theme.panel, theme.ink, 0.06) };
        let colors = Colors::new(rest, hover, mix(theme.panel, theme.ink, 0.08));
        let menu = agent.id.clone();
        let more = agent.id.clone();
        let keys = agent.id.clone();
        let bounds = self.tile_bounds(&agent.id);
        let handle = self.tile_focus(&agent.id, cx);
        let keyboard = focus::visible(&handle, window);
        let watch = SharedString::from(format!("primary:{}", agent.id));
        let slot = AvatarSlot {
            presence: face_state(Some(&agent), self.avatar_asleep(&agent.id), false),
            watch: Some(watch.clone()),
            ..AvatarSlot::default()
        };
        let face = bot_avatar_with(agent.avatar(), px(48.), agent.working(), slot, theme, cx);
        let (line, waiting) = latest_line(&agent);
        let text = div()
            .flex_1()
            .min_w_0()
            .child(
                div()
                    .text_size(px(15.))
                    .line_height(px(22.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .truncate()
                    .child(agent.name.clone()),
            )
            .when(!line.is_empty(), |text| {
                text.child(
                    div()
                        .mt(px(2.))
                        .body()
                        .text_color(if waiting { theme.warning } else { theme.ink_secondary })
                        .truncate()
                        .child(line),
                )
            });
        let more = div()
            .id("primary-more")
            .role(Role::Button)
            .aria_label("Agent actions")
            .size_6()
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .when(!keyboard, |button| button.invisible().group_hover("primary-card", |style| style.visible()))
            .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                cx.stop_propagation();
                this.open_menu(MenuKind::Agent(more.clone()), event.position(), window, cx);
            }))
            .child(icon("ellipsis", px(14.), theme.ink_secondary));
        let card = div()
            .id(SharedString::from(format!("primary-{}", agent.id)))
            .role(Role::Button)
            .group("primary-card")
            .w(SIDEBAR_WIDTH - px(24.))
            .h(px(72.))
            .flex()
            .items_center()
            .pl(px(72.))
            .pr(px(12.))
            .gap_3()
            .rounded(radius::CARD)
            .cursor_pointer()
            .track_focus(&handle)
            .on_prepaint(move |area, _, _| bounds.set(area))
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .on_click(cx.listener(move |this, _, window, cx| {
                this.close_tile_preview(cx);
                this.open(target.clone(), window, cx);
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    this.close_tile_preview(cx);
                    this.open_menu(MenuKind::Agent(menu.clone()), event.position, window, cx);
                }),
            )
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if this.tile_key(&keys, &event.keystroke, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(text)
            .child(more)
            .when(agent.unread, |card| card.child(div().size_2().flex_shrink_0().rounded_full().bg(theme.accent)));
        let theme = theme.clone();
        focus::decorate(superbot_avatars::watch_region(card, watch))
            .tint(Pointer::ROW, move |card, levels| {
                let fill = colors.sample(levels);
                let ring = if selected { 0.10 } else { 0.06 + 0.04 * levels.hover };
                card.bg(fill)
                    .child(div().absolute().inset_0().rounded(radius::CARD).border_1().border_color(theme.ink_at(ring)))
                    .child(div().absolute().left(px(12.)).top(px(12.)).child(face).children(
                        status_dot(&agent, fill, &theme).map(|dot| dot.absolute().bottom(px(-1.)).right(px(-1.))),
                    ))
                    .when(keyboard, |card| card.child(Ring::Inner(radius::CARD).element(theme.focus)))
            })
            .into_any_element()
    }

    fn render_tile(
        &mut self,
        agent: AgentSummary,
        open: Option<&Target>,
        theme: &Theme,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let target = Target::Agent(agent.id.clone());
        let selected = open.and_then(Target::agent) == Some(agent.id.as_str());
        let fill = if selected { theme.raised } else { theme.panel };
        let menu = agent.id.clone();
        let keys = agent.id.clone();
        let focus = self.tile_focus(&agent.id, cx);
        let ring = focus::visible(&focus, window);
        let bounds = self.tile_bounds(&agent.id);
        let shape = radius::FIELD;
        let watch = SharedString::from(format!("tile:{}", agent.id));
        let width = px(78.);
        let presence = face_state(Some(&agent), self.avatar_asleep(&agent.id), false);
        let slot = AvatarSlot { presence, watch: Some(watch.clone()), ..AvatarSlot::default() };
        let quote = latest_line(&agent).0;
        let preview = (self.tile_preview_shown(&agent.id) && !quote.is_empty()).then(|| {
            div().absolute().top_0().left_0().child(tile_preview(&agent, quote.clone(), width, presence, theme, cx))
        });
        let hovered = (agent.id.clone(), !quote.is_empty());
        let tile =
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
                .pt_2()
                .rounded(shape)
                .bg(fill)
                .cursor_pointer()
                .track_focus(&focus)
                // A pointer press leaves focus where opening the bot puts it, on the composer.
                .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                    if this.tile_key(&keys, &event.keystroke, window, cx) {
                        cx.stop_propagation();
                    }
                }))
                .when(quote.is_empty(), |tile| tooltip::on(tile, agent.name.clone()))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.close_tile_preview(cx);
                    this.open(target.clone(), window, cx)
                }))
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                        this.close_tile_preview(cx);
                        this.open_menu(MenuKind::Agent(menu.clone()), event.position, window, cx)
                    }),
                )
                .child(
                    // GPUI (gpui-pre 0.3.12) takes one on_hover per element; the avatar watch region has the tile's.
                    div().id("tile-rest").absolute().inset_0().on_hover(cx.listener(
                        move |this, hovering: &bool, window, cx| {
                            this.hover_tile(&hovered.0, *hovering, hovered.1, window, cx)
                        },
                    )),
                )
                .child(canvas(move |drawn, _, _| bounds.set(drawn), |_, _, _, _| {}).absolute().inset_0())
                .children(preview)
                .child(
                    div()
                        .relative()
                        .child(bot_avatar_with(agent.avatar(), px(60.), agent.working(), slot, theme, cx))
                        .children(
                            status_dot(&agent, fill, theme).map(|dot| dot.absolute().top(px(-2.)).right(px(-2.))),
                        ),
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
                .when(ring, |tile| tile.child(Ring::Inner(shape).element(theme.focus)));
        focus::decorate(tile).fill(Pointer::ROW, row_colors(theme, selected)).into_any_element()
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
        let key_menu = menu.clone();
        let more_menu = menu.clone();
        let bounds = Rc::new(Cell::new(Bounds::<Pixels>::default()));
        let drawn = bounds.clone();
        let watch = SharedString::from(format!("row:{}", agent.id));
        let slot = AvatarSlot {
            presence: face_state(Some(&agent), self.avatar_asleep(&agent.id), false),
            watch: Some(watch.clone()),
            ..AvatarSlot::default()
        };
        let face = div()
            .relative()
            .child(bot_avatar_with(agent.avatar(), px(36.), agent.working(), slot, theme, cx))
            .children(status_dot(&agent, fill, theme).map(|dot| dot.absolute().bottom(px(-1.)).right(px(-1.))));
        let element = superbot_avatars::watch_region(
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
            cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                this.open_menu(MenuKind::Agent(menu.clone()), event.position, window, cx)
            }),
        )
        .on_prepaint(move |area, _, _| drawn.set(area))
        .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
            if crate::ui::tile_preview::is_menu_key(&event.keystroke) {
                this.open_menu(MenuKind::Agent(key_menu.clone()), bounds.get().center(), window, cx);
                cx.stop_propagation();
            }
        }));
        focus::control(element, Ring::Inner(radius::FIELD), theme)
            .fill(Pointer::ROW, row_colors(theme, selected))
            .when_visible(
                div()
                    .size_4()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                            window.prevent_default();
                            cx.stop_propagation();
                            this.open_menu(MenuKind::Agent(more_menu.clone()), event.position, window, cx);
                        }),
                    )
                    .child(icon("ellipsis", px(14.), theme.ink_secondary)),
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
        let element = row(
            SharedString::from(format!("group-{}", group.id)),
            face,
            group.name.clone(),
            (preview, theme.ink_secondary),
            group.unread,
            selected,
            theme,
        )
        .on_click(cx.listener(move |this, _, window, cx| this.open(target.clone(), window, cx)));
        focus::control(element, Ring::Inner(radius::FIELD), theme)
            .fill(Pointer::ROW, row_colors(theme, selected))
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
                div().flex_1().min_w_0().child(focus::control(
                    div()
                        .id("profile")
                        .rounded(radius::FIELD)
                        .flex()
                        .items_center()
                        .gap_2()
                        .cursor_pointer()
                        .hover(move |style| style.text_color(ink))
                        .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                            this.open_menu(MenuKind::Profile, event.position() + point(px(-12.), px(-18.)), window, cx)
                        }))
                        .child(person_face(&name, px(36.), theme))
                        .child(div().name().truncate().child(name)),
                    Ring::Inner(radius::FIELD),
                    theme,
                )),
            )
            .child(focus::control(
                plugins.on_click(cx.listener(|this, _, window, cx| this.show(View::Store, window, cx))),
                Ring::OuterPill,
                theme,
            ))
            .child(focus::control(
                workspace.on_click(cx.listener(|this, _, window, cx| this.show(View::Workspace, window, cx))),
                Ring::OuterPill,
                theme,
            ))
    }
}

fn primary_agent(
    agents: &[AgentSummary],
    searching: bool,
    pack_primary: impl Fn(&AgentSummary) -> bool,
) -> Option<&AgentSummary> {
    if searching {
        return None;
    }
    agents.iter().find(|agent| pack_primary(agent)).or_else(|| agents.iter().find(|agent| agent.pinned))
}

fn row_colors(theme: &Theme, selected: bool) -> Colors {
    if selected {
        Colors::new(theme.raised, theme.raised, theme.raised_hover)
    } else {
        Colors::new(theme.panel, mix(theme.panel, theme.raised, 0.5), theme.raised)
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
    div()
        .id(id)
        .h(px(54.))
        .w_full()
        .flex()
        .items_center()
        .gap_2p5()
        .px_2()
        .rounded(radius::CARD)
        .cursor_pointer()
        .when(selected, |row| row.bg(theme.raised))
        .child(face)
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

#[cfg(test)]
mod tests {
    use super::{latest_line, primary_agent, AgentSummary};

    #[test]
    fn primary_card_uses_pack_then_first_pin_and_stays_out_of_search() {
        let agents: Vec<AgentSummary> = serde_json::from_value(serde_json::json!([
            {"id":"1","name":"Pack bot"},
            {"id":"2","name":"First pin","pinned":true},
            {"id":"3","name":"Second pin","pinned":true}
        ]))
        .unwrap();
        let pack = |bot: &AgentSummary| bot.name == "Pack bot";
        assert_eq!(primary_agent(&agents, false, pack).map(|bot| bot.id.as_str()), Some("1"));
        assert_eq!(primary_agent(&agents, false, |_| false).map(|bot| bot.id.as_str()), Some("2"));
        assert!(primary_agent(&agents[..1], false, |_| false).is_none());
        assert_eq!(primary_agent(&agents[1..2], false, |_| false).map(|bot| bot.id.as_str()), Some("2"));
        assert!(primary_agent(&agents, true, pack).is_none());
    }

    #[test]
    fn the_card_uses_the_same_waiting_working_and_preview_order_as_the_rows() {
        let mut bot: AgentSummary = serde_json::from_value(serde_json::json!({
            "id": "agent", "name": "Fixture agent", "status": "running",
            "threadStatus": "waiting_input", "preview": "Latest reply"
        }))
        .unwrap();
        assert_eq!(latest_line(&bot), ("Waiting for you".to_owned(), true));
        bot.thread_status = None;
        assert_eq!(latest_line(&bot), ("Working…".to_owned(), false));
        bot.status.clear();
        assert_eq!(latest_line(&bot), ("Latest reply".to_owned(), false));
    }
}
