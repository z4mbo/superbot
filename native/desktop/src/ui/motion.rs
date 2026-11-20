use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

use gpui_kit::{quadratic, Animation, Hsla};

use crate::theme::{mix, Theme};

#[derive(Clone, Copy)]
pub struct Bezier {
    x: (f32, f32),
    y: (f32, f32),
}

pub const fn bezier(x1: f32, y1: f32, x2: f32, y2: f32) -> Bezier {
    Bezier { x: (x1, x2), y: (y1, y2) }
}

impl Bezier {
    pub fn sample(self, progress: f32) -> f32 {
        if progress <= 0.0 || progress >= 1.0 {
            return progress.clamp(0.0, 1.0);
        }
        let along = |(first, second): (f32, f32), t: f32| {
            let rest = 1.0 - t;
            3.0 * rest * rest * t * first + 3.0 * rest * t * t * second + t * t * t
        };
        let (mut low, mut high) = (0.0_f32, 1.0_f32);
        for _ in 0..24 {
            let middle = (low + high) / 2.0;
            if along(self.x, middle) < progress {
                low = middle;
            } else {
                high = middle;
            }
        }
        along(self.y, (low + high) / 2.0)
    }
}

pub const STANDARD: Bezier = bezier(0.4, 0.0, 0.2, 1.0);
pub const EMPHASIS: Bezier = bezier(0.22, 1.0, 0.36, 1.0);
pub const EASE_IN: fn(f32) -> f32 = quadratic;

pub const INSTANT: Duration = Duration::ZERO;
pub const QUICK: Duration = Duration::from_millis(90);
pub const PRESS: Duration = Duration::from_millis(60);
pub const HOVER: Duration = Duration::from_millis(120);
pub const FADE: Duration = Duration::from_millis(120);
pub const GROW: Duration = Duration::from_millis(100);
pub const POP: Duration = Duration::from_millis(160);
pub const SLIDE: Duration = Duration::from_millis(160);
pub const SETTLE: Duration = Duration::from_millis(160);
pub const MSG: Duration = Duration::from_millis(180);
pub const PANEL_OPEN: Duration = Duration::from_millis(200);
pub const PANEL_CLOSE: Duration = Duration::from_millis(180);
pub const STATE: Duration = Duration::from_millis(240);

/// Use the app's reduced-motion setting for tweens driven outside GPUI's animation wrapper.
pub fn duration(span: Duration, reduce_motion: bool) -> Duration {
    if reduce_motion {
        INSTANT
    } else {
        span
    }
}

/// GPUI snaps one-shot animations to their end when reduced motion is active.
/// For a zero-length transition, apply the final state directly instead of wrapping the element.
pub fn animation(span: Duration, curve: Bezier) -> Option<Animation> {
    (!span.is_zero()).then(|| Animation::new(span).with_easing(move |progress| curve.sample(progress)))
}

/// One control's hover tint, moving the way a CSS transition does: 0 at rest, 1 fully tinted.
#[derive(Clone, Copy, Debug)]
pub struct Tint {
    from: f32,
    to: f32,
    began: Option<Instant>,
    span: Duration,
    /// The part of a full transition this one covers. A transition turned back part-way runs
    /// only for as long as it had come (CSS Transitions, "faster reversing").
    share: f32,
}

impl Default for Tint {
    fn default() -> Self {
        Self { from: 0.0, to: 0.0, began: None, span: Duration::ZERO, share: 1.0 }
    }
}

impl Tint {
    fn progress(&self, now: Instant) -> f32 {
        match self.began {
            Some(began) if !self.span.is_zero() => {
                (now.saturating_duration_since(began).as_secs_f32() / self.span.as_secs_f32()).min(1.0)
            }
            _ => 1.0,
        }
    }

    pub fn level(&self, now: Instant) -> f32 {
        self.from + (self.to - self.from) * STANDARD.sample(self.progress(now))
    }

    pub fn moving(&self, now: Instant) -> bool {
        self.progress(now) < 1.0
    }

    /// Heads for tinted or rest from wherever the tint is now. `still` is reduced motion: it arrives at once.
    pub fn aim(&mut self, tinted: bool, now: Instant, still: bool) {
        self.transition(tinted, now, duration(HOVER, still));
    }

    pub fn transition(&mut self, tinted: bool, now: Instant, span: Duration) {
        let to = if tinted { 1.0 } else { 0.0 };
        if span.is_zero() {
            *self = Self { from: to, to, ..Self::default() };
            return;
        }
        if to == self.to {
            return;
        }
        let eased = STANDARD.sample(self.progress(now));
        let share = if self.moving(now) { (eased * self.share + 1.0 - self.share).clamp(0.0, 1.0) } else { 1.0 };
        *self = Self { from: self.level(now), to, began: Some(now), span: span.mul_f32(share), share };
    }
}

#[derive(Clone, Copy)]
pub struct Pointer {
    enter: Duration,
    leave: Duration,
    pub presses: bool,
    pub held: bool,
}

impl Pointer {
    pub const BUTTON: Self = Self { enter: HOVER, leave: HOVER, presses: true, held: false };
    pub const ROW: Self = Self { enter: INSTANT, leave: QUICK, ..Self::BUTTON };
    pub const MENU: Self = Self { enter: INSTANT, leave: INSTANT, ..Self::BUTTON };
    pub const HOVER_ONLY: Self = Self { presses: false, ..Self::BUTTON };

    pub fn held(mut self, held: bool) -> Self {
        self.held = held;
        self
    }
}

#[derive(Clone, Copy)]
pub struct Levels {
    pub hover: f32,
    pub press: f32,
}

#[derive(Clone, Copy)]
pub struct Colors {
    rest: Hsla,
    hover: Hsla,
    press: Hsla,
}

impl Colors {
    pub fn new(rest: Hsla, hover: Hsla, press: Hsla) -> Self {
        Self { rest, hover, press }
    }

    pub fn ink(theme: &Theme, rest: f32, hover: f32, press: f32) -> Self {
        Self::new(theme.ink_at(rest), theme.ink_at(hover), theme.ink_at(press))
    }

    pub fn elevated(theme: &Theme) -> Self {
        Self::new(theme.composer, theme.elevated_hover(), mix(theme.composer, theme.ink, 0.12))
    }

    pub fn sample(self, levels: Levels) -> Hsla {
        let blend =
            |from: Hsla, to: Hsla, part: f32| Hsla { a: from.a + (to.a - from.a) * part, ..mix(from, to, part) };
        blend(blend(self.rest, self.hover, levels.hover), self.press, levels.press)
    }
}

#[derive(Clone, Copy, Default)]
pub struct ControlTint {
    hovered: bool,
    held: bool,
    pressed: bool,
    hover: Tint,
    press: Tint,
}

impl ControlTint {
    pub fn hover(&mut self, hovered: bool, pointer: Pointer, now: Instant, still: bool) {
        self.hovered = hovered;
        self.update_hover(pointer, now, still);
    }

    pub fn press(&mut self, pressed: bool, now: Instant, still: bool) -> bool {
        if self.pressed == pressed {
            return false;
        }
        self.pressed = pressed;
        self.press.transition(pressed, now, duration(if pressed { PRESS } else { HOVER }, still));
        true
    }

    pub fn settle(&mut self, pointer: Pointer, now: Instant, still: bool) -> (Levels, bool) {
        self.held = pointer.held;
        self.update_hover(pointer, now, still);
        if still {
            self.press.transition(self.pressed, now, INSTANT);
        }
        (
            Levels { hover: self.hover.level(now), press: self.press.level(now) },
            self.hover.moving(now) || self.press.moving(now),
        )
    }

    fn update_hover(&mut self, pointer: Pointer, now: Instant, still: bool) {
        let tinted = self.hovered || self.held;
        self.hover.transition(tinted, now, duration(if tinted { pointer.enter } else { pointer.leave }, still));
    }
}

/// Tints keyed by the controls that are interacting or still settling.
pub struct Tints<K>(HashMap<K, ControlTint>);

impl<K> Default for Tints<K> {
    fn default() -> Self {
        Self(HashMap::new())
    }
}

impl<K: Eq + Hash> Tints<K> {
    pub fn hover(&mut self, key: K, hovered: bool, now: Instant, still: bool) {
        self.0.entry(key).or_default().hover(hovered, Pointer::BUTTON, now, still);
    }

    pub fn press(&mut self, key: K, pressed: bool, now: Instant, still: bool) -> bool {
        if pressed {
            self.0.entry(key).or_default().press(true, now, still)
        } else {
            self.0.get_mut(&key).is_some_and(|state| state.press(false, now, still))
        }
    }

    pub fn settle(&mut self, key: K, held: bool, now: Instant, still: bool) -> (Levels, bool) {
        if !held && !self.0.contains_key(&key) {
            return ControlTint::default().settle(Pointer::BUTTON, now, still);
        }
        let state = self.0.entry(key).or_default();
        let (levels, moving) = state.settle(Pointer::BUTTON.held(held), now, still);
        if !moving && levels.hover == 0.0 && levels.press == 0.0 {
            self.0.retain(|_, state| {
                state.hover.level(now) != 0.0
                    || state.hover.moving(now)
                    || state.press.level(now) != 0.0
                    || state.press.moving(now)
            });
        }
        (levels, moving)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn old_corner_ease(progress: f32) -> f32 {
        const X: (f32, f32) = (0.4, 0.2);
        const Y: (f32, f32) = (0.0, 1.0);
        let along = |(first, second): (f32, f32), t: f32| {
            let rest = 1.0 - t;
            3.0 * rest * rest * t * first + 3.0 * rest * t * t * second + t * t * t
        };
        let progress = progress.clamp(0.0, 1.0);
        let (mut low, mut high) = (0.0_f32, 1.0_f32);
        for _ in 0..24 {
            let middle = (low + high) / 2.0;
            if along(X, middle) < progress {
                low = middle;
            } else {
                high = middle;
            }
        }
        along(Y, (low + high) / 2.0)
    }

    #[test]
    fn standard_matches_the_previous_corner_curve_at_101_points() {
        for point in 0..=100 {
            let progress = point as f32 / 100.0;
            assert!((STANDARD.sample(progress) - old_corner_ease(progress)).abs() <= 1e-4);
        }
    }

    #[test]
    fn emphasis_and_ease_in_follow_their_control_points() {
        for (progress, expected) in [(0., 0.), (0.1590625, 0.578125), (0.3425, 0.875), (1., 1.)] {
            assert!((EMPHASIS.sample(progress) - expected).abs() <= 1e-4);
        }
        assert_eq!(EASE_IN(0.5), 0.25);
    }

    #[test]
    fn reduced_motion_maps_every_duration_to_zero() {
        for span in [INSTANT, QUICK, PRESS, HOVER, FADE, GROW, POP, SLIDE, SETTLE, MSG, PANEL_OPEN, PANEL_CLOSE, STATE]
        {
            assert_eq!(duration(span, false), span);
            assert_eq!(duration(span, true), INSTANT);
        }
        assert!(animation(INSTANT, STANDARD).is_none());
    }

    #[test]
    fn sidebar_hover_arrives_immediately_and_leaves_in_quick() {
        let now = Instant::now();
        let mut tint = ControlTint::default();
        tint.hover(true, Pointer::ROW, now, false);
        assert_eq!(tint.settle(Pointer::ROW, now, false).0.hover, 1.0);
        tint.hover(false, Pointer::ROW, now, false);
        assert!(tint.settle(Pointer::ROW, now + QUICK - Duration::from_millis(1), false).1);
        assert_eq!(tint.settle(Pointer::ROW, now + QUICK, false).0.hover, 0.0);
    }

    #[test]
    fn pressing_and_releasing_use_their_own_durations() {
        let now = Instant::now();
        let mut tint = ControlTint::default();
        tint.press(true, now, false);
        assert!(tint.settle(Pointer::BUTTON, now + PRESS - Duration::from_millis(1), false).1);
        assert_eq!(tint.settle(Pointer::BUTTON, now + PRESS, false).0.press, 1.0);
        tint.press(false, now + PRESS, false);
        assert!(tint.settle(Pointer::BUTTON, now + PRESS + HOVER - Duration::from_millis(1), false).1);
        assert_eq!(tint.settle(Pointer::BUTTON, now + PRESS + HOVER, false).0.press, 0.0);
    }

    #[test]
    fn reducing_motion_during_a_transition_snaps_to_its_existing_target() {
        let now = Instant::now();
        let mut tint = Tint::default();
        tint.aim(true, now, false);
        tint.aim(true, now, true);
        assert_eq!(tint.level(now), 1.0);
        assert!(!tint.moving(now));
    }
}
