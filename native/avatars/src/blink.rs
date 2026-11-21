use std::time::{Duration, Instant};

use gpui_kit::{App, Context, Entity, SharedString, Subscription, Task, Window};

use crate::face_motion::FaceTiming;
use crate::{pack::fnv1a, Avatars};

const CLOSE: Duration = Duration::from_millis(60);
const HOLD: Duration = Duration::from_millis(30);
const OPEN: Duration = Duration::from_millis(120);
const DOUBLE: Duration = Duration::from_millis(180);
pub(crate) const BLINK: Duration = Duration::from_millis(210);

#[derive(Clone, Copy)]
pub(crate) struct Blink {
    pub at: Instant,
    twice: bool,
}

impl Blink {
    pub fn once(at: Instant) -> Self {
        Self { at, twice: false }
    }

    pub fn opening(self, now: Instant, timing: FaceTiming) -> f32 {
        let sample = |at| {
            let Some(elapsed) = now.checked_duration_since(at) else { return 1. };
            if elapsed < CLOSE {
                1. - 0.88 * (timing.ease_in)(elapsed.as_secs_f32() / CLOSE.as_secs_f32())
            } else if elapsed < CLOSE + HOLD {
                0.12
            } else if elapsed < BLINK {
                let opening = (elapsed - CLOSE - HOLD).as_secs_f32() / OPEN.as_secs_f32();
                0.12 + 0.88 * (timing.emphasis)(opening)
            } else {
                1.
            }
        };
        let first = sample(self.at);
        if self.twice {
            first.min(sample(self.at + DOUBLE))
        } else {
            first
        }
    }

    pub fn moving(self, now: Instant) -> bool {
        now < self.at + BLINK + if self.twice { DOUBLE } else { Duration::ZERO }
    }
}

pub(crate) struct ConversationBlink {
    scope: SharedString,
    waiting: bool,
    model: Option<SharedString>,
    last: Option<Blink>,
    seed: Vec<u8>,
    pulse: u64,
    timer: Option<Task<()>>,
    _visibility: Subscription,
}

impl ConversationBlink {
    fn sync_timer(&mut self, visible: bool, window: &Window, cx: &mut Context<Self>) {
        if !visible || cx.reduce_motion() {
            self.timer = None;
            self.last = None;
        } else if self.timer.is_none() {
            let n_start = self.seed.len();
            self.seed.extend_from_slice(&self.pulse.to_le_bytes());
            let roll = u64::from(fnv1a(&self.seed));
            self.seed.truncate(n_start);
            let weak = cx.entity().downgrade();
            self.timer = Some(window.spawn(cx, async move |cx| {
                cx.background_executor().timer(Duration::from_millis(4_500 + roll % 3_500)).await;
                let Some(state) = weak.upgrade() else { return };
                let _ = cx.update(|window, cx| {
                    state.update(cx, |state, cx| {
                        state.timer = None;
                        if window.is_visible() && !cx.reduce_motion() {
                            state.pulse += 1;
                            state.last = Some(Blink { at: Instant::now(), twice: roll / 3_500 % 6 == 0 });
                            window.refresh();
                        }
                        state.sync_timer(window.is_visible(), window, cx);
                    });
                });
            }));
        }
    }
}

/// Keep one blink timer while this conversation is drawn. Its three faces sample the
/// same pulse. Dropping the keyed state when the chat closes cancels the pending timer.
pub fn conversation_blink(
    scope: SharedString,
    bot: &str,
    model: Option<SharedString>,
    waiting: bool,
    window: &mut Window,
    cx: &mut App,
) {
    if cx.reduce_motion() || cx.try_global::<Avatars>().is_none() {
        return;
    }
    let id = window.window_handle().window_id();
    let state = window.use_keyed_state(scope.clone(), cx, |window, cx| {
        let entity_id = cx.entity_id();
        cx.on_release(move |_, cx| {
            let owns_clock = cx
                .try_global::<Avatars>()
                .and_then(|a| a.blinks.get(&id))
                .is_some_and(|blink| blink.entity_id() == entity_id);
            if owns_clock {
                cx.global_mut::<Avatars>().blinks.remove(&id);
            }
        })
        .detach();
        let visibility =
            cx.observe_window_visibility(window, |state: &mut ConversationBlink, visibility, window, cx| {
                state.sync_timer(visibility.is_visible(), window, cx);
            });
        ConversationBlink {
            scope,
            waiting,
            model: model.clone(),
            last: None,
            seed: bot.as_bytes().to_vec(),
            pulse: 0,
            timer: None,
            _visibility: visibility,
        }
    });
    state.update(cx, |state, cx| {
        let model_changed = state.model.as_ref().zip(model.as_ref()).is_some_and(|(old, next)| old != next);
        if (waiting && !state.waiting) || model_changed {
            state.last = Some(Blink::once(Instant::now()));
        }
        state.waiting = waiting;
        state.model = model;
        state.sync_timer(window.is_visible(), window, cx);
    });
    cx.global_mut::<Avatars>().blinks.insert(id, state.downgrade());
}

pub(crate) fn active(scope: &SharedString, window: &Window, cx: &App) -> Option<Blink> {
    let id = window.window_handle().window_id();
    let state: Entity<ConversationBlink> = cx.try_global::<Avatars>()?.blinks.get(&id)?.upgrade()?;
    let state = state.read(cx);
    (state.scope == *scope).then_some(state.last).flatten()
}

#[cfg(test)]
mod tests {
    use super::{Blink, FaceTiming, Instant};
    use std::time::Duration;

    #[cfg(target_os = "linux")]
    #[test]
    fn a_hidden_conversation_drops_its_timer_and_arms_a_new_one_on_return() {
        use gpui_kit::*;
        use std::sync::mpsc;

        struct Conversation;

        impl Render for Conversation {
            fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
                super::conversation_blink("test".into(), "bot", None, false, window, cx);
                div()
            }
        }

        let (done, result) = mpsc::channel();
        gpui_kit::platform::headless().run(move |cx| {
            cx.set_reduce_motion(false);
            cx.set_global(super::Avatars::with_pack(None));
            let tested = cx
                .open_window(WindowOptions::default(), |_, cx| cx.new(|_| Conversation))
                .and_then(|window| {
                    AnyWindowHandle::from(window).update(cx, |_, window, cx| {
                        window.draw(cx).clear(cx);
                        let id = window.window_handle().window_id();
                        let state = cx.global::<super::Avatars>().blinks.get(&id)?.upgrade()?;
                        Some(state.update(cx, |state, cx| {
                            state.sync_timer(true, window, cx);
                            let armed = state.timer.is_some();
                            state.last = Some(Blink::once(Instant::now()));
                            state.sync_timer(false, window, cx);
                            let suspended = state.timer.is_none() && state.last.is_none();
                            state.sync_timer(true, window, cx);
                            (armed, suspended, state.timer.is_some())
                        }))
                    })
                })
                .ok()
                .flatten();
            cx.spawn(async move |cx| cx.update(|cx| cx.quit())).detach();
            done.send(tested).unwrap();
        });
        assert_eq!(result.recv().unwrap(), Some((true, true, true)));
    }

    #[test]
    fn the_blink_closes_holds_and_opens_on_its_three_boundaries() {
        let start = Instant::now();
        let timing = FaceTiming {
            standard: gpui_kit::linear,
            emphasis: gpui_kit::linear,
            ease_in: gpui_kit::quadratic,
            settle: Duration::from_millis(160),
            state: Duration::from_millis(240),
        };
        let blink = Blink::once(start);
        let at = |ms| blink.opening(start + Duration::from_millis(ms), timing);
        for (ms, expected) in [(0, 1.), (30, 0.78), (60, 0.12), (90, 0.12), (150, 0.56), (210, 1.)] {
            assert!((at(ms) - expected).abs() <= 1e-5);
        }
        assert!(!blink.moving(start + Duration::from_millis(210)));
    }

    #[test]
    fn the_second_blink_starts_180_ms_after_the_first() {
        let start = Instant::now();
        let timing = FaceTiming {
            standard: gpui_kit::linear,
            emphasis: gpui_kit::linear,
            ease_in: gpui_kit::quadratic,
            settle: Duration::from_millis(160),
            state: Duration::from_millis(240),
        };
        let double = Blink { at: start, twice: true };
        assert_eq!(double.opening(start + Duration::from_millis(240), timing), 0.12);
        assert!(double.moving(start + Duration::from_millis(389)));
        assert!(!double.moving(start + Duration::from_millis(390)));
    }
}
