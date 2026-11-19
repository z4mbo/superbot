//! The panel's controls, drawn only from `Tokens` and the type, radius and
//! size tables in `DESKTOP-DESIGN.md` §3.

use std::rc::Rc;

use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::*;
use gpui_kit::{
    div, px, relative, AnyElement, App, ClickEvent, Div, ElementId, Entity, Focusable as _,
    FontWeight, Hsla, Role, SharedString, Stateful, ViewElement, Window,
};

use superbot_avatars::{Bot, Mark};

use crate::icons::{icon, Glyph};
use crate::theme::{
    mono_font, tokens, Tokens, RADIUS_CARD, RADIUS_FIELD, RADIUS_FULL, RADIUS_MENU_ROW,
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tone {
    /// The one neutral ink pill a view may have.
    Primary,
    /// A pill with a hairline edge.
    Outline,
    /// A destructive pill.
    Danger,
    /// Text only, in the accent text colour.
    Link,
    /// Text only, in `danger`.
    DangerLink,
    /// Text only, in secondary ink.
    Quiet,
}

/// A button: a pill, a text button or a round icon button.
pub(crate) struct Action {
    id: ElementId,
    label: SharedString,
    glyph: Option<Glyph>,
    icon_only: bool,
    tone: Tone,
    height: f32,
    disabled: bool,
    busy: bool,
    selected: bool,
    on_click: Option<ClickHandler>,
}

impl Action {
    pub(crate) fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            glyph: None,
            icon_only: false,
            tone: Tone::Outline,
            height: 32.,
            disabled: false,
            busy: false,
            selected: false,
            on_click: None,
        }
    }

    /// A round button showing only `glyph`; `label` is its accessible name.
    pub(crate) fn icon(
        id: impl Into<ElementId>,
        glyph: Glyph,
        label: impl Into<SharedString>,
    ) -> Self {
        let mut action = Self::new(id, label).tone(Tone::Quiet);
        action.glyph = Some(glyph);
        action.icon_only = true;
        action
    }

    pub(crate) fn tone(mut self, tone: Tone) -> Self {
        self.tone = tone;
        self
    }

    pub(crate) fn glyph(mut self, glyph: Glyph) -> Self {
        self.glyph = Some(glyph);
        self
    }

    pub(crate) fn small(mut self) -> Self {
        self.height = 28.;
        self
    }

    pub(crate) fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Shows a spinner and ignores clicks while the request is in flight.
    pub(crate) fn busy(mut self, busy: bool) -> Self {
        self.busy = busy;
        self
    }

    /// Fills the pill with ink: the chosen option in a row of pills.
    pub(crate) fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub(crate) fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl IntoElement for Action {
    type Element = ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        ViewElement::new(self)
    }
}

impl RenderOnce for Action {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = tokens(cx);
        let inert = self.disabled || self.busy;
        let text_only = matches!(self.tone, Tone::Link | Tone::DangerLink | Tone::Quiet);
        let (fill, ink, edge) = match self.tone {
            _ if self.selected => (Some(t.ink), t.app, None),
            Tone::Primary => (Some(t.ink), t.app, None),
            Tone::Danger => (Some(t.danger), t.danger_ink, None),
            Tone::Outline => (None, t.ink, Some(t.hairline)),
            Tone::Link => (None, t.accent_text, None),
            Tone::DangerLink => (None, t.danger, None),
            Tone::Quiet => (None, t.ink_secondary, None),
        };
        let filled = fill.is_some();
        let glyph_size = if self.height <= 28. { 14. } else { 16. };

        div()
            .id(self.id)
            .role(Role::Button)
            .aria_label(self.label.clone())
            .flex()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .gap_1p5()
            .h(px(self.height))
            .rounded(RADIUS_FULL)
            .text_size(px(13.))
            .line_height(px(18.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(ink)
            .whitespace_nowrap()
            .map(|this| {
                if self.icon_only {
                    this.w(px(self.height))
                } else if text_only {
                    this.px_2()
                } else {
                    this.px_3p5()
                }
            })
            .when_some(fill, |this, fill| this.bg(fill))
            .when_some(edge, |this, edge| this.border_1().border_color(edge))
            .when(inert, |this| this.opacity(0.5))
            .when(!inert, |this| {
                this.cursor_pointer()
                    .tab_index(0)
                    .focus_visible(|style| style.border_2().border_color(t.focus))
                    .map(|this| {
                        if filled {
                            this.hover(|style| style.opacity(0.88))
                                .active(|style| style.opacity(0.78))
                        } else {
                            this.hover(|style| style.bg(t.hover()))
                                .active(|style| style.bg(t.pressed()))
                        }
                    })
            })
            .when_some(self.on_click.filter(|_| !inert), |this, handler| {
                this.on_click(move |event, window, cx| {
                    cx.stop_propagation();
                    handler(event, window, cx)
                })
            })
            .when(self.busy, |this| {
                this.child(Spinner::new().with_size(px(glyph_size)).color(ink))
            })
            .when_some(self.glyph.filter(|_| !self.busy), |this, glyph| {
                this.child(icon(glyph, glyph_size, ink))
            })
            .when(!self.icon_only, |this| this.child(self.label))
    }
}

/// An on/off control. The owner writes the requested value back.
pub(crate) struct Toggle {
    id: ElementId,
    label: SharedString,
    on: bool,
    disabled: bool,
    on_change: Option<Rc<dyn Fn(&bool, &mut Window, &mut App)>>,
}

impl Toggle {
    pub(crate) fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, on: bool) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            on,
            disabled: false,
            on_change: None,
        }
    }

    pub(crate) fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub(crate) fn on_change(
        mut self,
        handler: impl Fn(&bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl IntoElement for Toggle {
    type Element = ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        ViewElement::new(self)
    }
}

impl RenderOnce for Toggle {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = tokens(cx);
        let next = !self.on;
        div()
            .id(self.id)
            .role(Role::Switch)
            .aria_label(self.label)
            .flex()
            .flex_shrink_0()
            .items_center()
            .w(px(34.))
            .h(px(20.))
            .px(px(2.))
            .rounded(RADIUS_FULL)
            .map(|this| {
                if self.on {
                    this.bg(t.ink).justify_end()
                } else {
                    this.bg(t.control).border_1().border_color(t.hairline)
                }
            })
            .when(self.disabled, |this| this.opacity(0.5))
            .when(!self.disabled, |this| {
                this.cursor_pointer()
                    .tab_index(0)
                    .focus_visible(|style| style.border_2().border_color(t.focus))
            })
            .when_some(
                self.on_change.filter(|_| !self.disabled),
                |this, handler| {
                    this.on_click(move |_, window, cx| {
                        cx.stop_propagation();
                        handler(&next, window, cx)
                    })
                },
            )
            .child(div().size(px(14.)).rounded(RADIUS_FULL).bg(if self.on {
                t.app
            } else {
                t.ink_secondary
            }))
    }
}

fn field_frame(t: &Tokens, focused: bool, invalid: bool) -> Div {
    div()
        .w_full()
        .rounded(RADIUS_FIELD)
        .bg(t.inset)
        .border_1()
        .border_color(if invalid {
            t.danger
        } else if focused {
            t.focus
        } else {
            t.hairline
        })
}

/// A 36px single-line field.
pub(crate) fn text_field(
    state: &Entity<InputState>,
    label: &'static str,
    invalid: bool,
    window: &Window,
    cx: &App,
) -> Div {
    let t = tokens(cx);
    let focused = state.read(cx).focus_handle(cx).is_focused(window);
    field_frame(&t, focused, invalid)
        .h(px(36.))
        .flex()
        .items_center()
        .child(
            Input::new(state)
                .appearance(false)
                .aria_label(label)
                .text_size(px(13.)),
        )
}

/// A multi-line field that grows with its text.
pub(crate) fn text_area(
    state: &Entity<TextareaState>,
    label: &'static str,
    mono: bool,
    window: &Window,
    cx: &App,
) -> Div {
    let t = tokens(cx);
    let focused = state.read(cx).focus_handle(cx).is_focused(window);
    field_frame(&t, focused, false).py_1().child(
        Textarea::new(state)
            .appearance(false)
            .aria_label(label)
            .text_size(px(13.))
            .when(mono, |this| this.font_family(mono_font(cx))),
    )
}

/// A labelled form row: the label 12/500 tertiary above its control, and an
/// optional `danger` message under it.
pub(crate) fn labelled(
    label: &'static str,
    control: impl IntoElement,
    problem: Option<SharedString>,
    cx: &App,
) -> Div {
    let t = tokens(cx);
    div()
        .flex()
        .flex_col()
        .gap_1p5()
        .child(group_label(label, &t))
        .child(control)
        .when_some(problem, |this, problem| {
            this.child(
                div()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(t.danger)
                    .child(problem),
            )
        })
}

pub(crate) fn group_label(text: impl Into<SharedString>, t: &Tokens) -> Div {
    div()
        .text_size(px(12.))
        .line_height(px(16.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(t.ink_tertiary)
        .child(text.into())
}

pub(crate) fn section_title(text: impl Into<SharedString>, t: &Tokens) -> Div {
    div()
        .text_size(px(20.))
        .line_height(px(28.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(t.ink)
        .truncate()
        .child(text.into())
}

pub(crate) fn body(text: impl Into<SharedString>, color: Hsla) -> Div {
    div()
        .text_size(px(13.))
        .line_height(px(18.))
        .text_color(color)
        .child(text.into())
}

pub(crate) fn meta(text: impl Into<SharedString>, t: &Tokens) -> Div {
    div()
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(t.ink_tertiary)
        .child(text.into())
}

pub(crate) fn mono(text: impl Into<SharedString>, color: Hsla, cx: &App) -> Div {
    div()
        .font_family(mono_font(cx))
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(color)
        .child(text.into())
}

/// A 24px chip on a card: 12/400 on `control`.
pub(crate) fn chip(text: impl Into<SharedString>, color: Hsla, t: &Tokens) -> Div {
    div()
        .flex()
        .flex_shrink_0()
        .items_center()
        .h(px(24.))
        .px_2()
        .rounded(RADIUS_FULL)
        .bg(t.control)
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(color)
        .whitespace_nowrap()
        .child(text.into())
}

// The three faces below match `native/desktop` (its `agent_face`,
// `person_face` and group stack), so a bot, a person and a group look the
// same in the sidebar and in this panel.

/// A bot's face: its identity colour and two eyes.
pub(crate) fn bot_face(color: Hsla, size: f32) -> Div {
    let eye = size * 0.14;
    div()
        .size(px(size))
        .flex_shrink_0()
        .rounded(RADIUS_FULL)
        .bg(color)
        .flex()
        .items_center()
        .justify_center()
        .gap(px(size * 0.16))
        .pb(px(size * 0.06))
        .children((0..2).map(|_| {
            div()
                .w(px(eye))
                .h(px(eye * 1.5))
                .rounded(RADIUS_FULL)
                .bg(gpui_kit::white())
        }))
}

/// A bot's avatar: the local avatar pack's mark when one is installed, otherwise [`bot_face`].
pub(crate) fn bot_avatar(bot: Bot, size: f32, working: bool, t: &Tokens, cx: &App) -> AnyElement {
    match superbot_avatars::look(bot, cx) {
        Some(look) => Mark::new(
            SharedString::from(format!("avatar-{}", bot.id)),
            look,
            px(size),
            t.ink,
        )
        .working(working)
        .into_any_element(),
        None => bot_face(t.identity_for(bot.color), size).into_any_element(),
    }
}

/// A group's face: its first two bots, overlapping.
pub(crate) fn group_face<'a>(
    bots: impl IntoIterator<Item = Bot<'a>>,
    size: f32,
    t: &Tokens,
    cx: &App,
) -> Div {
    let face = size * 0.68;
    div().size(px(size)).flex_shrink_0().relative().children(
        bots.into_iter().take(2).enumerate().map(|(index, bot)| {
            let offset = if index == 0 { 0. } else { size - face };
            div()
                .absolute()
                .left(px(offset))
                .top(px(offset))
                .child(bot_avatar(bot, face, false, t, cx))
        }),
    )
}

/// A person's face: their initials on a quiet plate.
pub(crate) fn person_face(name: &str, size: f32, t: &Tokens) -> Div {
    div()
        .size(px(size))
        .flex_shrink_0()
        .rounded(RADIUS_FULL)
        .bg(t.pressed())
        .border_1()
        .border_color(t.hover())
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(size * 0.38))
        .line_height(relative(1.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(t.ink)
        .child(crate::format::initials(name))
}

/// A list row: name 13/500 over one line of supporting text, with a leading
/// element and trailing controls. Clickable when given a handler.
pub(crate) struct Row {
    id: ElementId,
    leading: Option<AnyElement>,
    title: SharedString,
    detail: Option<SharedString>,
    trailing: Vec<AnyElement>,
    on_click: Option<ClickHandler>,
}

impl Row {
    pub(crate) fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            leading: None,
            title: title.into(),
            detail: None,
            trailing: Vec::new(),
            on_click: None,
        }
    }

    pub(crate) fn leading(mut self, element: impl IntoElement) -> Self {
        self.leading = Some(element.into_any_element());
        self
    }

    pub(crate) fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        let detail = detail.into();
        self.detail = (!detail.is_empty()).then_some(detail);
        self
    }

    pub(crate) fn trailing(mut self, element: impl IntoElement) -> Self {
        self.trailing.push(element.into_any_element());
        self
    }

    pub(crate) fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl IntoElement for Row {
    type Element = ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        ViewElement::new(self)
    }
}

impl RenderOnce for Row {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = tokens(cx);
        let clickable = self.on_click.is_some();
        div()
            .id(self.id)
            .flex()
            .items_center()
            .gap(px(10.))
            .min_h(px(54.))
            .px_2()
            .py_1p5()
            .rounded(RADIUS_FIELD)
            .when(clickable, |this| {
                this.cursor_pointer()
                    .role(Role::Button)
                    .aria_label(self.title.clone())
                    .tab_index(0)
                    .focus_visible(|style| style.bg(t.hover()))
                    .hover(|style| style.bg(t.hover()))
                    .active(|style| style.bg(t.pressed()))
            })
            .when_some(self.on_click, |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
            .children(self.leading)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(t.ink)
                            .truncate()
                            .child(self.title),
                    )
                    .when_some(self.detail, |this, detail| {
                        this.child(
                            div()
                                .text_size(px(13.))
                                .line_height(px(18.))
                                .text_color(t.ink_secondary)
                                .truncate()
                                .child(detail),
                        )
                    }),
            )
            .children(self.trailing)
    }
}

/// A 44px settings row: label at the start, its control at the end.
pub(crate) fn setting_row(
    label: impl Into<SharedString>,
    hint: Option<SharedString>,
    control: impl IntoElement,
    t: &Tokens,
) -> Div {
    div()
        .flex()
        .items_center()
        .gap_3()
        .min_h(px(44.))
        .py_1()
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(body(label, t.ink))
                .when_some(hint, |this, hint| this.child(meta(hint, t))),
        )
        .child(control)
}

/// A card: `card` fill, radius 12, 16px padding, no border, no shadow.
pub(crate) fn card(t: &Tokens) -> Div {
    div()
        .flex()
        .flex_col()
        .gap_3()
        .p_4()
        .rounded(RADIUS_CARD)
        .bg(t.card)
}

pub(crate) fn divider(t: &Tokens) -> Div {
    div().h(px(1.)).w_full().flex_shrink_0().bg(t.edge)
}

/// One line of state in place of a list: empty, denied or failed, with an
/// optional text button after it.
pub(crate) fn notice(text: impl Into<SharedString>, action: Option<Action>, t: &Tokens) -> Div {
    div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap_1()
        .py_3()
        .child(body(text, t.ink_secondary))
        .children(action)
}

pub(crate) fn problem_line(text: impl Into<SharedString>, t: &Tokens) -> Div {
    div()
        .flex()
        .items_start()
        .gap_1p5()
        .child(
            div()
                .pt(px(2.))
                .child(icon(Glyph::CircleAlert, 14., t.danger)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(12.))
                .line_height(px(18.))
                .text_color(t.danger)
                .child(text.into()),
        )
}

pub(crate) fn loading_line(t: &Tokens) -> Div {
    div()
        .flex()
        .items_center()
        .gap_2()
        .py_3()
        .child(Spinner::new().with_size(px(14.)).color(t.ink_tertiary))
        .child(body("Loading…", t.ink_tertiary))
}

/// A row in the section list: 30px, radius 6, icon 16 and a 13px label.
pub(crate) fn nav_row(
    id: impl Into<ElementId>,
    glyph: Glyph,
    label: &'static str,
    selected: bool,
    t: &Tokens,
) -> Stateful<Div> {
    div()
        .id(id.into())
        .role(Role::Tab)
        .aria_label(label)
        .flex()
        .items_center()
        .gap_2()
        .h(px(30.))
        .px_2()
        .rounded(RADIUS_MENU_ROW)
        .cursor_pointer()
        .tab_index(0)
        .text_size(px(13.))
        .line_height(px(18.))
        .text_color(if selected { t.ink } else { t.ink_secondary })
        .when(selected, |this| {
            this.bg(t.raised).font_weight(FontWeight::MEDIUM)
        })
        .when(!selected, |this| {
            this.hover(|style| style.bg(t.hover()))
                .active(|style| style.bg(t.pressed()))
        })
        .focus_visible(|style| style.bg(t.hover()))
        .child(icon(
            glyph,
            16.,
            if selected { t.ink } else { t.ink_secondary },
        ))
        .child(label)
}

pub(crate) fn new_input(
    placeholder: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> Entity<InputState> {
    cx.new(|cx| InputState::new(window, cx).placeholder(placeholder))
}

pub(crate) fn new_textarea(
    placeholder: &'static str,
    rows: (usize, usize),
    window: &mut Window,
    cx: &mut App,
) -> Entity<TextareaState> {
    cx.new(|cx| {
        TextareaState::new(window, cx)
            .auto_grow(rows.0, rows.1)
            .placeholder(placeholder)
    })
}

pub(crate) fn set_input(
    state: &Entity<InputState>,
    value: &str,
    window: &mut Window,
    cx: &mut App,
) {
    let value = value.to_owned();
    state.update(cx, |state, cx| state.set_value(value, window, cx));
}

pub(crate) fn set_textarea(
    state: &Entity<TextareaState>,
    value: &str,
    window: &mut Window,
    cx: &mut App,
) {
    let value = value.to_owned();
    state.update(cx, |state, cx| state.set_value(value, window, cx));
}
