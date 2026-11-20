use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::ui::motion::{self, Bezier, Tween, EMPHASIS, FADE, MSG, STANDARD};

/// Motion belongs to the open conversation, independently of virtualized row lifetimes.
pub(crate) struct ChatMotion {
    switch_pending: bool,
    switched_at: Option<Instant>,
    messages: HashMap<String, Instant>,
    optimistic: Option<Instant>,
    working: Option<Working>,
}

struct Working {
    label: Option<String>,
    fade: Tween<f32>,
}

fn phase(started: Instant, now: Instant, span: Duration, curve: Bezier) -> Option<f32> {
    let age = now.saturating_duration_since(started);
    (age < span).then(|| curve.sample(age.as_secs_f32() / span.as_secs_f32()))
}

impl ChatMotion {
    pub fn new(switch_pending: bool) -> Self {
        Self { switch_pending, switched_at: None, messages: HashMap::new(), optimistic: None, working: None }
    }

    pub fn snapshot(&mut self, now: Instant) {
        if std::mem::take(&mut self.switch_pending) {
            self.switched_at = Some(now);
        }
    }

    pub fn message(&mut self, id: String, now: Instant) {
        self.messages.insert(id, now);
    }

    pub fn optimistic(&mut self, now: Instant) {
        self.optimistic = Some(now);
    }

    pub fn frame(
        &mut self,
        now: Instant,
        still: bool,
        at_tail: bool,
        working: Option<String>,
        loaded: bool,
    ) -> (f32, bool) {
        let msg = motion::duration(MSG, still || !at_tail);
        self.messages.retain(|_, at| phase(*at, now, msg, EMPHASIS).is_some());
        self.optimistic = self.optimistic.filter(|at| phase(*at, now, msg, EMPHASIS).is_some());

        let span = motion::duration(FADE, still);
        let transcript = self.switched_at.and_then(|at| phase(at, now, span, STANDARD));
        if transcript.is_none() {
            self.switched_at = None;
        }

        let mut moving = !self.messages.is_empty() || self.optimistic.is_some() || transcript.is_some();
        if loaded {
            let on = f32::from(working.is_some());
            let current = self.working.get_or_insert_with(|| Working { label: None, fade: Tween::at_rest(on, now) });
            if working.is_some() {
                current.label = working;
            }
            current.fade.aim(on, now, span, STANDARD, lerp);
            moving |= current.fade.moving(now);
            if !current.fade.moving(now) && on == 0. {
                current.label = None;
            }
        }

        (transcript.map_or(1., |progress| lerp(0.6, 1., progress)), moving)
    }

    pub fn arrival(&self, id: &str, now: Instant) -> Option<f32> {
        phase(*self.messages.get(id)?, now, MSG, EMPHASIS)
    }

    pub fn optimistic_arrival(&self, now: Instant) -> Option<f32> {
        phase(self.optimistic?, now, MSG, EMPHASIS)
    }

    pub fn working(&self, now: Instant) -> Option<(&str, f32)> {
        let working = self.working.as_ref()?;
        Some((working.label.as_deref()?, working.fade.sample(now, STANDARD, lerp)))
    }
}

fn lerp(from: f32, to: f32, progress: f32) -> f32 {
    from + (to - from) * progress
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_initial_read_is_static_and_a_switch_starts_at_sixty_percent_when_history_arrives() {
        let now = Instant::now();
        let mut initial = ChatMotion::new(false);
        initial.snapshot(now);
        assert_eq!(initial.frame(now, false, true, None, true), (1., false));

        let mut switch = ChatMotion::new(true);
        assert_eq!(switch.frame(now, false, true, None, false), (1., false));
        switch.snapshot(now);
        assert_eq!(switch.frame(now, false, true, None, true), (0.6, true));
        let (alpha, moving) = switch.frame(now + FADE / 2, false, true, None, true);
        assert!((0.6..1.).contains(&alpha) && moving);
        assert_eq!(switch.frame(now + FADE, false, true, None, true), (1., false));
    }

    #[test]
    fn a_live_row_only_moves_while_following_the_tail() {
        let now = Instant::now();
        let mut motion = ChatMotion::new(false);
        assert_eq!(motion.arrival("historical", now), None);
        motion.message("live".into(), now);
        assert_eq!(motion.arrival("live", now), Some(0.));
        assert!(motion.arrival("live", now + MSG / 2).is_some());
        assert_eq!(motion.arrival("live", now + MSG), None);
        motion.frame(now + MSG / 2, false, false, None, true);
        assert_eq!(motion.arrival("live", now + MSG / 2), None);
    }

    #[test]
    fn the_working_line_waits_for_each_fade_to_settle() {
        let now = Instant::now();
        let mut motion = ChatMotion::new(false);
        motion.frame(now, false, true, None, true);
        motion.frame(now, false, true, Some("Working…".into()), true);
        assert_eq!(motion.working(now), Some(("Working…", 0.)));
        assert_eq!(motion.working(now + FADE), Some(("Working…", 1.)));
        motion.frame(now + FADE, false, true, None, true);
        let (_, fading) = motion.working(now + FADE + FADE / 2).unwrap();
        assert!((0. ..1.).contains(&fading));
        motion.frame(now + FADE * 2, false, true, None, true);
        assert_eq!(motion.working(now + FADE * 2), None);
    }

    #[test]
    fn reduced_motion_clears_all_pending_offsets_and_fades() {
        let now = Instant::now();
        let mut motion = ChatMotion::new(true);
        motion.message("live".into(), now);
        motion.optimistic(now);
        motion.snapshot(now);
        assert_eq!(motion.frame(now, true, true, Some("Working…".into()), true), (1., false));
        assert_eq!(motion.arrival("live", now), None);
        assert_eq!(motion.optimistic_arrival(now), None);
        assert_eq!(motion.working(now), Some(("Working…", 1.)));
        assert_eq!(motion.frame(now, true, true, None, true), (1., false));
        assert_eq!(motion.working(now), None);
    }
}
