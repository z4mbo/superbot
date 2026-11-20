use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::*;

use crate::ui::motion::{self, FADE, INSTANT, STANDARD, TOOLTIP_DELAY, TOOLTIP_GRACE};

#[derive(Default)]
struct History {
    visible: Cell<usize>,
    closed: Cell<Option<Instant>>,
}

impl History {
    fn delay(&self, now: Instant) -> Duration {
        if self.visible.get() > 0
            || self.closed.get().is_some_and(|at| now.saturating_duration_since(at) < TOOLTIP_GRACE)
        {
            INSTANT
        } else {
            TOOLTIP_DELAY
        }
    }
}

/// The native tooltip owns the hit test, placement, and cancellation. Only the presentation
/// waits: GPUI's native delay is fixed per trigger and can't see another trigger's tooltip.
#[derive(Default)]
struct WindowHistory(Option<(AnyWindowHandle, Rc<History>)>);

impl Global for WindowHistory {}

pub(in crate::ui) fn on(trigger: Stateful<Div>, title: impl Into<SharedString>) -> Stateful<Div> {
    let title = title.into();
    trigger.tooltip_show_delay(INSTANT).tooltip(move |window, cx| {
        let handle = window.window_handle();
        let slot = &mut cx.default_global::<WindowHistory>().0;
        let history = if let Some((_, history)) = slot.as_ref().filter(|(owner, _)| *owner == handle) {
            history.clone()
        } else {
            let history = Rc::new(History::default());
            *slot = Some((handle, history.clone()));
            history
        };
        let now = Instant::now();
        let delay = history.delay(now);
        let body = Tooltip::new(title.clone()).build(window, cx);
        cx.new(|cx: &mut Context<ChatTooltip>| {
            let wake = (!delay.is_zero()).then(|| {
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(delay).await;
                    this.update(cx, |_, cx| cx.notify()).ok();
                })
            });
            ChatTooltip { history, show_at: now + delay, visible: false, body, _wake: wake }
        })
        .into()
    })
}

struct ChatTooltip {
    history: Rc<History>,
    show_at: Instant,
    visible: bool,
    body: AnyView,
    _wake: Option<Task<()>>,
}

impl Render for ChatTooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        if Instant::now() < self.show_at {
            return div().into_any_element();
        }
        if !self.visible {
            self.visible = true;
            self.history.visible.set(self.history.visible.get() + 1);
        }
        let fade = motion::animation(FADE, STANDARD).expect("FADE has a duration");
        // A native tooltip is laid out at the root. Translate its child within that root.
        div()
            .child(div().child(self.body.clone()).with_animation("chat-tooltip-enter", fade, |tip, progress| {
                tip.relative().top(px(2. * (1. - progress))).opacity(progress)
            }))
            .into_any_element()
    }
}

impl Drop for ChatTooltip {
    fn drop(&mut self) {
        if self.visible {
            self.history.visible.set(self.history.visible.get() - 1);
            self.history.closed.set(Some(Instant::now()));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{History, INSTANT, TOOLTIP_DELAY, TOOLTIP_GRACE};

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
}
