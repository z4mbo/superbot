use std::time::{Duration, Instant};

use crate::frames::{Frame, Frames};

/// A value this close to its target has reached it.
const SETTLED: f32 = 0.001;

/// Where a mark looks: a point that chases the pointer and a hold that rises toward 1 while the
/// pointer is over its region and falls to 0 after, both closing the same share of their gap each
/// moment, as the frames were captured.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gaze {
    rate: f32,
    since: Instant,
    held: bool,
    target: (f32, f32),
    point: (f32, f32),
    hold: f32,
}

impl Gaze {
    pub fn new(rate: f32, now: Instant) -> Gaze {
        Gaze { rate, since: now, held: false, target: (0., 0.), point: (0., 0.), hold: 0. }
    }

    /// The point and hold at `now`.
    pub fn at(&self, now: Instant) -> ((f32, f32), f32) {
        let left = (-self.rate * now.saturating_duration_since(self.since).as_secs_f32()).exp();
        let chase = |from: f32, to: f32| {
            let value = to + (from - to) * left;
            if (to - value).abs() < SETTLED {
                to
            } else {
                value
            }
        };
        let point = (chase(self.point.0, self.target.0), chase(self.point.1, self.target.1));
        (point, chase(self.hold, if self.held { 1. } else { 0. }))
    }

    pub fn settled(&self, now: Instant) -> bool {
        let (point, hold) = self.at(now);
        point == self.target && hold == if self.held { 1. } else { 0. }
    }

    pub fn holding(&self) -> bool {
        self.held
    }

    /// Looks toward `(x, y)`. From rest the mark turns straight to the point; already turned, it
    /// follows it.
    pub fn look(&mut self, x: f32, y: f32, now: Instant) {
        let (point, hold) = self.at(now);
        *self = Gaze {
            point: if hold == 0. { (x, y) } else { point },
            hold,
            since: now,
            held: true,
            target: (x, y),
            ..*self
        };
    }

    pub fn release(&mut self, now: Instant) {
        let (point, hold) = self.at(now);
        *self = Gaze { point, hold, since: now, held: false, ..*self };
    }

    /// Drops the hold to 0 at `at`, as the mark comes back to rest from work, and turns again from
    /// there if the pointer is still over it.
    pub fn restart(&mut self, at: Instant) {
        *self = Gaze { point: self.target, hold: 0., since: at, ..*self };
    }

    pub fn frame<'a>(&self, frames: &'a Frames, now: Instant) -> &'a Frame {
        let ((x, y), hold) = self.at(now);
        if now < self.since {
            return frames.rest();
        }
        frames.look(x, y, hold)
    }
}

/// Whole frames played between `since` and `now`.
fn steps(frames: &Frames, since: Instant, now: Instant) -> usize {
    (now.saturating_duration_since(since).as_secs_f32() * frames.fps) as usize
}

/// One bot's work, as one of its marks shows it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Work {
    pub working: bool,
    /// When work began while the mark was shown, so it plays the bridge into the loop.
    started: Option<Instant>,
    /// When work ended while the mark was shown, and what it was showing.
    stopped: Option<(Instant, Stopped)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Stopped {
    /// In the loop, at this position: the loop runs on to the next captured bridge to rest.
    Loop(f64),
    /// On this frame of the bridge into work: it plays back to rest.
    Starting(usize),
}

impl Work {
    /// A mark that appears as it is, without a bridge.
    pub fn shown(working: bool) -> Work {
        Work { working, started: None, stopped: None }
    }

    /// The mark's work changes to `working` at `now`.
    pub fn change(&mut self, working: bool, frames: &Frames, epoch: Instant, phase: f32, now: Instant) {
        if working {
            let started = Some(now).filter(|_| !frames.start().0.is_empty());
            *self = Work { working, started, stopped: None };
            return;
        }
        let starting = self.started.map(|started| steps(frames, started, now)).filter(|n| *n < frames.start().0.len());
        let stopped = match starting {
            Some(frame) => Stopped::Starting(frame),
            None => Stopped::Loop(self.position(frames, epoch, phase, now)),
        };
        *self = Work { working, started: None, stopped: Some((now, stopped)) };
    }

    /// For a stop: when the loop reaches the next captured bridge, and that bridge.
    fn bridge<'a>(&self, frames: &'a Frames) -> Option<(Instant, &'a [Frame])> {
        let (at, Stopped::Loop(position)) = self.stopped? else { return None };
        let index = frames.loop_index(false, position);
        let length = frames.working(false).len() as f64;
        let (wait, bridge) = frames.stop_from(index)?;
        let into = (position.rem_euclid(1.) * length).fract() / frames.fps as f64;
        let wait = Duration::from_secs_f64(((wait + 1) as f64 / frames.fps as f64 - into).max(0.));
        Some((at + wait, bridge))
    }

    /// When a stop's bridge ends, if one is playing.
    pub fn resting_from(&self, frames: &Frames) -> Option<Instant> {
        if let Some((at, Stopped::Starting(frame))) = self.stopped {
            return Some(at + frames.frame_time() * (frame + 1) as u32);
        }
        let (from, bridge) = self.bridge(frames)?;
        Some(from + frames.frame_time() * bridge.len() as u32)
    }

    /// Where the loop is at `now`, in loops: from the shared clock with this bot's own offset, or
    /// from the frame the start bridge handed over to.
    pub fn position(&self, frames: &Frames, epoch: Instant, phase: f32, now: Instant) -> f64 {
        let length = frames.loop_length(false).as_secs_f64();
        if let Some(started) = self.started {
            let (bridge, join) = frames.start();
            let joined = started + frames.frame_time() * bridge.len() as u32;
            let since = now.saturating_duration_since(joined).as_secs_f64();
            return join as f64 / frames.working(false).len() as f64 + since / length;
        }
        now.saturating_duration_since(epoch).as_secs_f64() / length + phase as f64
    }

    /// The frame of this mark's work at `now`, or `None` when it is at rest and done stopping.
    pub fn frame<'a>(
        &self,
        frames: &'a Frames,
        compact: bool,
        epoch: Instant,
        phase: f32,
        now: Instant,
    ) -> Option<&'a Frame> {
        let step = |since: Instant| steps(frames, since, now);
        if self.working {
            if compact {
                let length = frames.loop_length(true).as_secs_f64();
                let position = now.saturating_duration_since(epoch).as_secs_f64() / length + phase as f64;
                return Some(frames.working_frame(true, position));
            }
            if let Some(frame) = self.started.and_then(|started| frames.start().0.get(step(started))) {
                return Some(frame);
            }
            return Some(frames.working_frame(false, self.position(frames, epoch, phase, now)));
        }
        let (at, stopped) = self.stopped.filter(|_| !compact)?;
        let position = match stopped {
            Stopped::Starting(frame) => return frame.checked_sub(step(at)).map(|back| &frames.start().0[back]),
            Stopped::Loop(position) => position,
        };
        let (from, bridge) = self.bridge(frames)?;
        if now < from {
            let since = now.saturating_duration_since(at).as_secs_f64();
            return Some(frames.working_frame(false, position + since / frames.loop_length(false).as_secs_f64()));
        }
        bridge.get(step(from))
    }

    /// Whether the mark is still moving on its own at `now`.
    pub fn moving(&self, frames: &Frames, now: Instant) -> bool {
        self.working || self.resting_from(frames).is_some_and(|end| now < end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::tests::{frames, text, v1};

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn a_turn_closes_its_gap_at_the_rate_and_settles() {
        let start = Instant::now();
        let mut gaze = Gaze::new(9., start);
        gaze.look(1., 0.5, start);
        let ((x, y), hold) = gaze.at(start + ms(100));
        assert_eq!((x, y), (1., 0.5));
        assert!((hold - (1. - (-0.9f32).exp())).abs() < 1e-4);
        assert!(!gaze.settled(start + ms(100)));
        assert!(gaze.settled(start + ms(1000)));
    }

    #[test]
    fn following_moves_the_point_and_leaving_keeps_it_while_the_hold_falls() {
        let start = Instant::now();
        let mut gaze = Gaze::new(9., start);
        gaze.look(1., 0., start);
        gaze.look(-1., 0., start + ms(1000));
        let ((x, _), hold) = gaze.at(start + ms(1100));
        assert!(x > -1. && x < 1.);
        assert_eq!(hold, 1.);
        gaze.release(start + ms(1100));
        let ((later_x, _), later_hold) = gaze.at(start + ms(1200));
        assert!(later_x < x);
        assert!(later_hold < 1. && later_hold > 0.);
        assert!(gaze.settled(start + ms(3000)));
        assert_eq!(gaze.at(start + ms(3000)).1, 0.);
    }

    #[test]
    fn a_brief_hover_turns_only_part_way_and_back() {
        let start = Instant::now();
        let mut gaze = Gaze::new(9., start);
        gaze.look(1., 1., start);
        gaze.release(start + ms(50));
        let (_, hold) = gaze.at(start + ms(50));
        assert!(hold > 0.3 && hold < 0.4);
        let frames = frames();
        assert_eq!(text(gaze.frame(&frames, start + ms(50))), "<svg><title>1,1 at 0.25</title></svg>");
        assert_eq!(text(gaze.frame(&frames, start + ms(2000))), "<svg><title>rest</title></svg>");
    }

    #[test]
    fn coming_back_to_rest_restarts_the_turn_after_the_bridge() {
        let start = Instant::now();
        let mut gaze = Gaze::new(9., start);
        gaze.look(1., 1., start);
        gaze.restart(start + ms(500));
        let frames = frames();
        assert_eq!(text(gaze.frame(&frames, start + ms(400))), "<svg><title>rest</title></svg>");
        assert_eq!(gaze.at(start + ms(500)).1, 0.);
        assert!(gaze.at(start + ms(600)).1 > 0.5);
    }

    #[test]
    fn work_bridges_in_then_loops_from_the_join_and_bridges_out() {
        let frames = frames();
        let epoch = Instant::now();
        let start = epoch + ms(250);
        let mut work = Work::shown(false);
        work.change(true, &frames, epoch, 0., start);
        let at = |work: &Work, n: u64| work.frame(&frames, false, epoch, 0., start + ms(n)).map(|f| text(f).to_owned());
        assert_eq!(at(&work, 0).unwrap(), "<svg><title>start 0</title></svg>");
        assert_eq!(at(&work, 250).unwrap(), "<svg><title>start 2</title></svg>");
        assert_eq!(at(&work, 300).unwrap(), "<svg><title>work 6</title></svg>");
        assert_eq!(at(&work, 450).unwrap(), "<svg><title>work 7</title></svg>");
        let stop = start + ms(450);
        work.change(false, &frames, epoch, 0., stop);
        assert_eq!(at(&work, 450).unwrap(), "<svg><title>work 7</title></svg>");
        assert_eq!(at(&work, 660).unwrap(), "<svg><title>work 9</title></svg>");
        assert_eq!(at(&work, 760).unwrap(), "<svg><title>work 0</title></svg>");
        assert_eq!(at(&work, 810).unwrap(), "<svg><title>stop 0 0</title></svg>");
        assert_eq!(at(&work, 910).unwrap(), "<svg><title>stop 0 1</title></svg>");
        assert_eq!(at(&work, 1010), None);
        assert!(work.moving(&frames, start + ms(950)));
        assert!(!work.moving(&frames, start + ms(1050)));
    }

    #[test]
    fn work_that_ends_during_the_bridge_in_plays_it_back_to_rest() {
        let frames = frames();
        let epoch = Instant::now();
        let mut work = Work::shown(false);
        work.change(true, &frames, epoch, 0., epoch);
        work.change(false, &frames, epoch, 0., epoch + ms(150));
        let at = |n: u64| work.frame(&frames, false, epoch, 0., epoch + ms(n)).map(|f| text(f).to_owned());
        assert_eq!(at(150).unwrap(), "<svg><title>start 1</title></svg>");
        assert_eq!(at(260).unwrap(), "<svg><title>start 0</title></svg>");
        assert_eq!(at(360), None);
        assert!(!work.moving(&frames, epoch + ms(360)));
    }

    #[test]
    fn without_captured_bridges_work_cuts_between_rest_and_the_shared_loop() {
        let frames = v1();
        let epoch = Instant::now();
        let mut work = Work::shown(false);
        work.change(true, &frames, epoch, 0.5, epoch + ms(100));
        let at =
            |work: &Work, n: u64| work.frame(&frames, false, epoch, 0.5, epoch + ms(n)).map(|f| text(f).to_owned());
        assert_eq!(at(&work, 120).unwrap(), "work 3");
        work.change(false, &frames, epoch, 0.5, epoch + ms(150));
        assert_eq!(at(&work, 150), None);
        assert!(!work.moving(&frames, epoch + ms(150)));
    }

    #[test]
    fn a_mark_shown_at_work_runs_the_shared_loop_at_its_own_place() {
        let frames = frames();
        let epoch = Instant::now();
        let work = Work::shown(true);
        let frame = |phase, n| text(work.frame(&frames, false, epoch, phase, epoch + ms(n)).unwrap()).to_owned();
        assert_eq!(frame(0., 0), "<svg><title>work 0</title></svg>");
        assert_eq!(frame(0.5, 0), "<svg><title>work 5</title></svg>");
        assert_eq!(frame(0., 950), "<svg><title>work 9</title></svg>");
        let compact = text(work.frame(&frames, true, epoch, 0., epoch + ms(250)).unwrap()).to_owned();
        assert_eq!(compact, "<svg><title>small 2</title></svg>");
    }
}
