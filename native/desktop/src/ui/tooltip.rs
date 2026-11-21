use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::*;

use crate::ui::motion::{self, FADE, INSTANT, STANDARD, TOOLTIP_DELAY, TOOLTIP_GRACE};

#[derive(Default)]
pub(super) struct History {
    visible: Cell<usize>,
    closed: Cell<Option<Instant>>,
}

impl History {
    pub(super) fn delay(&self, now: Instant) -> Duration {
        if self.visible.get() > 0
            || self.closed.get().is_some_and(|at| now.saturating_duration_since(at) < TOOLTIP_GRACE)
        {
            INSTANT
        } else {
            TOOLTIP_DELAY
        }
    }

    pub(super) fn show(self: &Rc<Self>) -> Visible {
        self.visible.set(self.visible.get() + 1);
        Visible(self.clone())
    }
}

/// The native tooltip owns the hit test, placement, and cancellation. Only the presentation
/// waits: GPUI's native delay is fixed per trigger and can't see another trigger's tooltip.
#[derive(Default)]
struct WindowHistory(Option<(AnyWindowHandle, Rc<History>)>);

impl Global for WindowHistory {}

pub(super) fn history(window: &Window, cx: &mut App) -> Rc<History> {
    let handle = window.window_handle();
    let slot = &mut cx.default_global::<WindowHistory>().0;
    if let Some((_, history)) = slot.as_ref().filter(|(owner, _)| *owner == handle) {
        history.clone()
    } else {
        let history = Rc::new(History::default());
        *slot = Some((handle, history.clone()));
        history
    }
}

pub(super) fn on(trigger: Stateful<Div>, title: impl Into<SharedString>) -> Stateful<Div> {
    let title = title.into();
    when(trigger, title, || true)
}

pub(super) fn when(trigger: Stateful<Div>, title: SharedString, show: impl Fn() -> bool + 'static) -> Stateful<Div> {
    trigger.tooltip_show_delay(INSTANT).tooltip(move |window, cx| {
        if !show() {
            return cx.new(|_| EmptyTooltip).into();
        }
        let history = history(window, cx);
        let now = Instant::now();
        let delay = history.delay(now);
        let body = Tooltip::new(title.clone()).build(window, cx);
        cx.new(|cx: &mut Context<DelayedTooltip>| {
            let wake = (!delay.is_zero()).then(|| {
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(delay).await;
                    this.update(cx, |_, cx| cx.notify()).ok();
                })
            });
            DelayedTooltip { history, show_at: now + delay, visible: None, body, _wake: wake }
        })
        .into()
    })
}

struct EmptyTooltip;

impl Render for EmptyTooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

struct DelayedTooltip {
    history: Rc<History>,
    show_at: Instant,
    visible: Option<Visible>,
    body: AnyView,
    _wake: Option<Task<()>>,
}

impl Render for DelayedTooltip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if Instant::now() < self.show_at {
            return div().into_any_element();
        }
        self.visible.get_or_insert_with(|| self.history.show());
        div().child(enter("tooltip-enter", div().child(self.body.clone()), cx)).into_any_element()
    }
}

pub(super) fn enter(id: impl Into<ElementId>, tip: Div, cx: &App) -> AnyElement {
    if let Some(fade) = entry_animation(cx.reduce_motion()) {
        tip.with_animation(id, fade, |tip, progress| tip.relative().top(px(2. * (1. - progress))).opacity(progress))
            .into_any_element()
    } else {
        tip.into_any_element()
    }
}

fn entry_animation(reduced_motion: bool) -> Option<Animation> {
    motion::animation(motion::duration(FADE, reduced_motion), STANDARD)
}

/// Dropping a visible tooltip starts the grace period, including when its trigger disappears.
pub(super) struct Visible(Rc<History>);

impl Drop for Visible {
    fn drop(&mut self) {
        self.0.visible.set(self.0.visible.get() - 1);
        self.0.closed.set(Some(Instant::now()));
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{entry_animation, History, INSTANT, TOOLTIP_DELAY, TOOLTIP_GRACE};

    #[test]
    fn only_a_visible_or_recently_closed_tip_waives_the_first_delay() {
        let at = Instant::now();
        let history = History::default();
        assert_eq!(history.delay(at), TOOLTIP_DELAY);
        history.visible.set(1);
        assert_eq!(history.delay(at), INSTANT);
        history.visible.set(0);
        history.closed.set(Some(at));
        assert_eq!(history.delay(at + TOOLTIP_GRACE - Duration::from_millis(1)), INSTANT);
        assert_eq!(history.delay(at + TOOLTIP_GRACE), TOOLTIP_DELAY);
    }

    #[test]
    fn reduced_motion_skips_entry_and_preserves_the_wait() {
        assert!(entry_animation(false).is_some());
        assert!(entry_animation(true).is_none());
        assert_eq!(History::default().delay(Instant::now()), TOOLTIP_DELAY);
    }
}
