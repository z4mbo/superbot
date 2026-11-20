use std::sync::OnceLock;
use std::time::{Duration, Instant};

use gpui_kit::{px, Pixels};

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

/// Supply the slowest frame from the 500-message benchmark on the reference machine.
/// Without a benchmark result, keep the chat reflow animation.
pub(super) fn use_fixed_chat_width() -> bool {
    static FIXED_CHAT_WIDTH: OnceLock<bool> = OnceLock::new();
    *FIXED_CHAT_WIDTH.get_or_init(|| {
        let frame = std::env::var("SUPERBOT_PANEL_FRAME_MS")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .and_then(|ms| Duration::try_from_secs_f64(ms / 1000.).ok());
        exceeds_frame_budget(frame)
    })
}

fn exceeds_frame_budget(frame: Option<Duration>) -> bool {
    frame.is_some_and(|frame| frame > Duration::from_millis(12))
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
    fn the_fallback_keeps_the_trajectory_but_reserves_the_final_chat_width() {
        assert!(!exceeds_frame_budget(None));
        assert!(!exceeds_frame_budget(Some(Duration::from_millis(12))));
        assert!(exceeds_frame_budget(Some(Duration::from_micros(12_001))));
        let middle = px(245.);
        assert_eq!(PanelLayout::new(middle, PANEL_WIDTH, false).occupied, middle);
        for target in [px(0.), PANEL_WIDTH] {
            let layout = PanelLayout::new(middle, target, true);
            assert_eq!(layout.occupied, target);
            assert_eq!(layout.visible, middle);
        }
    }
}
