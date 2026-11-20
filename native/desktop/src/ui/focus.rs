use std::cell::Cell;
use std::rc::Rc;
use std::time::Instant;

use gpui_kit::*;

use crate::theme::Theme;
use crate::ui::motion::{Colors, ControlTint, Levels, Pointer};

#[derive(Clone, Copy)]
pub enum Ring {
    Inner(Pixels),
    InnerPill,
    OuterPill,
    TrailingSwitch,
}

impl Ring {
    pub fn element(self, color: Hsla) -> Div {
        let border = div().border_2().border_color(color);
        match self {
            Self::Inner(radius) => border.absolute().inset_0().rounded(radius),
            Self::InnerPill => border.absolute().inset_0().rounded_full(),
            Self::OuterPill => border.absolute().inset(px(-4.)).rounded_full(),
            Self::TrailingSwitch => div()
                .absolute()
                .right(px(10.))
                .top_0()
                .bottom_0()
                .flex()
                .items_center()
                .child(border.w(px(40.)).h(px(26.)).rounded_full()),
        }
    }
}

pub fn visible(handle: &FocusHandle, window: &Window) -> bool {
    handle.is_focused(window) && window.last_input_was_keyboard()
}

pub fn control(element: Stateful<Div>, ring: Ring, theme: &Theme) -> FocusControl {
    let mut control = FocusControl::new(element);
    control.ring = Some((ring, theme.focus));
    control
}

pub fn decorate(element: Stateful<Div>) -> FocusControl {
    FocusControl::new(element)
}

type TintStyle = Box<dyn FnOnce(Stateful<Div>, Levels, &mut Window, &mut App) -> Stateful<Div>>;

pub struct FocusControl {
    id: ElementId,
    element: Option<Stateful<Div>>,
    ring: Option<(Ring, Hsla)>,
    on_visible: Option<Div>,
    motion: Option<(Pointer, TintStyle)>,
}

#[derive(Default)]
struct ControlState {
    focus: Option<FocusHandle>,
    tint: Option<Rc<Cell<ControlTint>>>,
}

impl FocusControl {
    fn new(element: Stateful<Div>) -> Self {
        Self {
            id: Element::id(&element).expect("controls have a stable element id"),
            element: Some(element),
            ring: None,
            on_visible: None,
            motion: None,
        }
    }

    pub fn when_visible(mut self, child: Div) -> Self {
        self.on_visible = Some(child);
        self
    }

    pub fn fill(self, pointer: Pointer, colors: Colors) -> Self {
        self.tint(pointer, move |control, levels| control.bg(colors.sample(levels)))
    }

    pub fn tint(self, pointer: Pointer, style: impl FnOnce(Stateful<Div>, Levels) -> Stateful<Div> + 'static) -> Self {
        self.tint_in(pointer, move |control, levels, _, _| style(control, levels))
    }

    pub fn tint_in(
        mut self,
        pointer: Pointer,
        style: impl FnOnce(Stateful<Div>, Levels, &mut Window, &mut App) -> Stateful<Div> + 'static,
    ) -> Self {
        self.motion = Some((pointer, Box::new(style)));
        self
    }
}

/// A non-occluding hitbox over the control, including its children. This leaves native
/// hover handlers on the control itself available to the avatar and tile preview.
fn pointer_surface(state: &Rc<Cell<ControlTint>>, pointer: Pointer) -> Stateful<Div> {
    let track_hover = state.clone();
    let surface = div()
        .id("pointer-tint")
        .absolute()
        .inset_0()
        .hover_listener_mode(HoverListenerMode::InputModalityIndependent)
        .on_hover(move |hovered, window, cx| {
            let mut tint = track_hover.get();
            tint.hover(*hovered, pointer, Instant::now(), cx.reduce_motion());
            track_hover.set(tint);
            window.refresh();
        });
    if !pointer.presses {
        return surface;
    }
    let press = |pressed| {
        let state = state.clone();
        move |window: &mut Window, cx: &mut App| {
            let mut tint = state.get();
            if tint.press(pressed, Instant::now(), cx.reduce_motion()) {
                state.set(tint);
                window.refresh();
            }
        }
    };
    let down = press(true);
    let up = press(false);
    let up_out = press(false);
    surface
        .on_mouse_down(MouseButton::Left, move |_, window, cx| down(window, cx))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| up(window, cx))
        .on_mouse_up_out(MouseButton::Left, move |_, window, cx| up_out(window, cx))
}

// Keep the focus handle with the mounted element, including for virtualized file rows.
impl IntoElement for FocusControl {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for FocusControl {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        window.with_element_state(id.expect("controls have a stable element id"), |state, window| {
            let mut state: ControlState = state.unwrap_or_default();
            let mut control = self.element.take().expect("one layout per element").relative();
            if let Some((pointer, style)) = self.motion.take() {
                let stored = state.tint.get_or_insert_with(Default::default);
                let mut tint = stored.get();
                let (levels, moving) = tint.settle(pointer, Instant::now(), cx.reduce_motion());
                stored.set(tint);
                if moving {
                    window.request_animation_frame();
                }
                control = style(control, levels, window, cx).child(pointer_surface(stored, pointer));
            }
            if let Some((ring, color)) = self.ring {
                let handle = state.focus.get_or_insert_with(|| cx.focus_handle().tab_stop(true));
                control = control.track_focus(handle);
                if visible(handle, window) {
                    control = control.children(self.on_visible.take()).child(ring.element(color));
                }
            }
            let mut control = control.into_any_element();
            ((control.request_layout(window, cx), control), state)
        })
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        control: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        control.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        control: &mut AnyElement,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        control.paint(window, cx);
    }
}
