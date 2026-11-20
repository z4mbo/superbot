use std::sync::OnceLock;
use std::time::{Duration, Instant};

use gpui_kit::profiler::{self, FrameEvent, FrameTimingCollector};
use gpui_kit::{px, Pixels, Window};

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

fn frame_override() -> Option<Duration> {
    static FRAME_OVERRIDE: OnceLock<Option<Duration>> = OnceLock::new();
    *FRAME_OVERRIDE.get_or_init(|| {
        std::env::var("SUPERBOT_PANEL_FRAME_MS")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .and_then(|ms| Duration::try_from_secs_f64(ms / 1000.).ok())
    })
}

fn fixed_chat_width(overridden: Option<Duration>, slow_frame: bool) -> bool {
    overridden.map_or(slow_frame, exceeds_frame_budget)
}

fn exceeds_frame_budget(frame: Duration) -> bool {
    frame > FRAME_BUDGET
}

const FRAME_BUDGET: Duration = Duration::from_millis(12);

/// Measure only draws made while the panel is asking the chat to reflow. Keep the fallback for
/// this window once a draw misses the budget so lighter frames cannot switch it back mid-flight.
#[derive(Default)]
pub(crate) struct PanelPerformance {
    probe: Option<FrameProbe>,
    slow_frame: bool,
}

impl PanelPerformance {
    pub(super) fn observe(&mut self, window: &Window, moving: bool) {
        if frame_override().is_some() || self.slow_frame {
            return;
        }
        if let Some(probe) = &mut self.probe {
            let id = window.window_handle().window_id();
            self.slow_frame = probe.frames.collect_unseen().into_iter().any(|event| {
                matches!(event, FrameEvent::Draw(frame) if frame.window_id == id && exceeds_frame_budget(frame.draw_duration()))
            });
        }
        if moving && !self.slow_frame {
            self.probe.get_or_insert_with(FrameProbe::new);
        } else {
            self.stop();
        }
    }

    pub(crate) fn stop(&mut self) {
        self.probe = None;
    }

    pub(super) fn fixed_chat_width(&self) -> bool {
        fixed_chat_width(frame_override(), self.slow_frame)
    }
}

struct FrameProbe {
    frames: FrameTimingCollector,
    enabled_trace: bool,
}

impl FrameProbe {
    fn new() -> Self {
        let enabled_trace = profiler::set_trace_enabled(true);
        Self {
            frames: FrameTimingCollector::new(),
            enabled_trace,
        }
    }
}

impl Drop for FrameProbe {
    fn drop(&mut self) {
        if self.enabled_trace {
            profiler::set_trace_enabled(false);
        }
    }
}

pub(in crate::ui) struct PanelLayout {
    pub visible: Pixels,
    pub occupied: Pixels,
}

impl PanelLayout {
    pub(super) fn new(visible: Pixels, target: Pixels, fixed_chat: bool) -> Self {
        Self { visible, occupied: if fixed_chat { target } else { visible } }
    }
}

#[cfg(test)]
mod tests {
    use super::{aim, fixed_chat_width, sample, PanelLayout, PANEL_WIDTH};
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
    fn the_fallback_keeps_the_trajectory_but_reserves_the_final_chat_width() {
        assert!(!fixed_chat_width(None, false));
        assert!(fixed_chat_width(None, true));
        assert!(!fixed_chat_width(Some(Duration::from_millis(12)), true));
        assert!(fixed_chat_width(Some(Duration::from_micros(12_001)), false));
        let middle = px(245.);
        assert_eq!(PanelLayout::new(middle, PANEL_WIDTH, false).occupied, middle);
        for target in [px(0.), PANEL_WIDTH] {
            let layout = PanelLayout::new(middle, target, true);
            assert_eq!(layout.occupied, target);
            assert_eq!(layout.visible, middle);
        }
    }
}
