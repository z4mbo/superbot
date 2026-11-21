use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::{canvas, px, AnyElement, IntoElement, Pixels, Styled};

use super::PANEL_WIDTH;
use crate::ui::motion::{self, Tween};

pub(super) fn aim(width: &mut Tween<Pixels>, open: bool, now: Instant, reduce_motion: bool) {
    let (target, span) = if open { (PANEL_WIDTH, motion::PANEL_OPEN) } else { (px(0.), motion::PANEL_CLOSE) };
    width.aim(target, now, motion::duration(span, reduce_motion), motion::EMPHASIS, interpolate);
}

pub(super) fn sample(width: &Tween<Pixels>, now: Instant) -> Pixels {
    width.sample(now, motion::EMPHASIS, interpolate)
}

fn interpolate(from: Pixels, to: Pixels, progress: f32) -> Pixels {
    from + (to - from) * progress
}

const FRAME_BUDGET: Duration = Duration::from_millis(12);

fn exceeds_frame_budget(started: Instant, painted: Instant) -> bool {
    painted.duration_since(started) > FRAME_BUDGET
}

/// Latch the fallback for this window after a slow draw. Time the UI work leading
/// up to paint, since the gap between frames also includes the display's refresh interval.
#[derive(Default)]
pub(crate) struct PanelPerformance {
    slow_frame: Rc<Cell<bool>>,
}

impl PanelPerformance {
    pub(in crate::ui) fn measure_draw(&self, started: Instant) -> Option<AnyElement> {
        if self.fixed_chat_width() {
            return None;
        }
        let slow_frame = self.slow_frame.clone();
        Some(
            canvas(|_, _, _| (), move |_, _, _, _| slow_frame.set(exceeds_frame_budget(started, Instant::now())))
                .absolute()
                .size_0()
                .into_any_element(),
        )
    }

    pub(super) fn fixed_chat_width(&self) -> bool {
        self.slow_frame.get()
    }
}

pub(in crate::ui) struct PanelLayout {
    pub visible: Pixels,
    pub occupied: Pixels,
    pub measure_from: Option<Instant>,
}

impl PanelLayout {
    pub(super) fn new(visible: Pixels, target: Pixels, fixed_chat: bool) -> Self {
        Self { visible, measure_from: None, occupied: if fixed_chat { target } else { visible } }
    }
}

#[cfg(test)]
mod tests {
    use super::{aim, exceeds_frame_budget, sample, PanelLayout, PANEL_WIDTH};
    use crate::ui::motion::{Tween, PANEL_CLOSE, PANEL_OPEN};
    use gpui_kit::px;
    use std::time::{Duration, Instant};

    #[test]
    fn panel_traverses_the_full_width_without_overshoot_in_either_direction() {
        let start = Instant::now();
        let mut width = Tween::at_rest(px(0.), start);
        aim(&mut width, true, start, false);
        assert_eq!(sample(&width, start), px(0.));
        assert!((f32::from(sample(&width, start + PANEL_OPEN / 2)) - 384.553).abs() < 0.01);
        assert!(width.moving(start + PANEL_OPEN - Duration::from_millis(1)));
        let turn = start + PANEL_OPEN;
        assert_eq!(sample(&width, turn), PANEL_WIDTH);
        aim(&mut width, false, turn, false);
        assert_eq!(sample(&width, turn), PANEL_WIDTH);
        assert!((f32::from(sample(&width, turn + PANEL_CLOSE / 2)) - 15.447).abs() < 0.01);
        assert_eq!(sample(&width, turn + PANEL_CLOSE), px(0.));
        for (at, span, direction) in [(start, PANEL_OPEN, true), (turn, PANEL_CLOSE, false)] {
            let mut motion = Tween::at_rest(if direction { px(0.) } else { PANEL_WIDTH }, at);
            aim(&mut motion, direction, at, false);
            for index in 0..20 {
                let a = sample(&motion, at + span * index / 20);
                let b = sample(&motion, at + span * (index + 1) / 20);
                assert!((px(0.)..=PANEL_WIDTH).contains(&a));
                assert!(if direction { a <= b } else { b <= a });
            }
        }
    }

    #[test]
    fn reversing_midway_keeps_the_current_width_and_reduced_motion_snaps() {
        let start = Instant::now();
        let mut width = Tween::at_rest(px(0.), start);
        aim(&mut width, true, start, false);
        let reverse = start + Duration::from_millis(40);
        let visible = sample(&width, reverse);
        aim(&mut width, false, reverse, false);
        assert_eq!(sample(&width, reverse), visible);
        aim(&mut width, false, reverse, true);
        assert_eq!(sample(&width, reverse), px(0.));
        assert!(!width.moving(reverse));
    }

    #[test]
    fn the_draw_budget_excludes_idle_time_between_frames() {
        let first = Instant::now();
        let second = first + Duration::from_millis(17);
        assert!(!exceeds_frame_budget(first, first + Duration::from_millis(8)));
        assert!(!exceeds_frame_budget(second, second + Duration::from_millis(12)));
        assert!(exceeds_frame_budget(second, second + Duration::from_micros(12_001)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_slow_paint_latches_fixed_width_for_the_following_draws() {
        use super::PanelPerformance;
        use gpui_kit::*;

        #[derive(Default)]
        struct Probe {
            performance: PanelPerformance,
            started: Option<Instant>,
        }

        impl Render for Probe {
            fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
                div().children(self.started.and_then(|started| self.performance.measure_draw(started)))
            }
        }

        crate::test_support::headless(|cx| {
            let window = cx.open_window(WindowOptions::default(), |_, cx| cx.new(|_| Probe::default())).unwrap();
            window
                .update(cx, |probe, _, cx| {
                    assert!(!probe.performance.fixed_chat_width());
                    probe.started = Some(Instant::now() - Duration::from_millis(13));
                    cx.notify();
                })
                .unwrap();
            AnyWindowHandle::from(window).update(cx, |_, window, cx| window.draw(cx).clear(cx)).unwrap();
            window
                .update(cx, |probe, _, _| {
                    assert!(probe.performance.fixed_chat_width());
                    assert!(probe.performance.measure_draw(Instant::now()).is_none());
                })
                .unwrap();
        });
    }

    #[test]
    fn the_fallback_keeps_the_trajectory_but_reserves_the_final_chat_width() {
        let middle = px(245.);
        assert_eq!(PanelLayout::new(middle, PANEL_WIDTH, false).occupied, middle);
        for target in [px(0.), PANEL_WIDTH] {
            let layout = PanelLayout::new(middle, target, true);
            assert_eq!(layout.occupied, target);
            assert_eq!(layout.visible, middle);
        }
    }
}
