use std::time::{Duration, Instant};

use gpui_kit::*;

use crate::blink::{self, Blink};
use crate::face::{aim, draw, FacePaint, FaceState, Pose, Tier};
use crate::pack::fnv1a;
use crate::{Avatars, Gaze};

const GAZE_RATE: f32 = 10.;
const PRESS: Duration = Duration::from_millis(70);
const REBLINK: Duration = Duration::from_secs(2);
const WORK_FRAME: Duration = Duration::from_nanos(33_333_334);

/// Curves and durations supplied by the desktop's motion primitives.
#[derive(Clone, Copy)]
pub struct FaceTiming {
    pub standard: fn(f32) -> f32,
    pub emphasis: fn(f32) -> f32,
    pub settle: Duration,
    pub state: Duration,
    pub ease_in: fn(f32) -> f32,
}

#[derive(Clone, Copy)]
struct Press {
    at: Instant,
    from: f32,
    down: bool,
}

impl Press {
    fn sample(self, now: Instant, timing: FaceTiming) -> (f32, bool) {
        let (target, duration, curve) =
            if self.down { (1., PRESS, timing.standard) } else { (0., timing.settle, timing.emphasis) };
        let elapsed = now.saturating_duration_since(self.at);
        if elapsed >= duration || self.from == target {
            return (target, false);
        }
        let mix = curve(elapsed.as_secs_f32() / duration.as_secs_f32());
        (self.from + (target - self.from) * mix, true)
    }
}

#[derive(Clone, Copy)]
struct Presence {
    pose: Pose,
    amplitude: f32,
}

struct StateBlend {
    from: Presence,
    began: Instant,
}

pub(crate) struct FaceMotion {
    gaze: Gaze,
    press: Press,
    timing: FaceTiming,
    status: FaceState,
    blend: Option<StateBlend>,
    allows_blink: bool,
    hover_blink: Option<Blink>,
    last_blink: Option<Instant>,
}

impl FaceMotion {
    fn new(now: Instant, timing: FaceTiming, status: FaceState) -> Self {
        Self {
            gaze: Gaze::new(GAZE_RATE, now),
            press: Press { at: now, from: 0., down: false },
            timing,
            status,
            blend: None,
            allows_blink: false,
            hover_blink: None,
            last_blink: None,
        }
    }

    fn presence(&mut self, d: Pixels, now: Instant) -> Presence {
        let pose = self.status.still_at(d);
        let amplitude = if self.status == FaceState::Working { 1. } else { 0. };
        if let Some(blend) = &self.blend {
            let elapsed = now.saturating_duration_since(blend.began);
            if elapsed < self.timing.state {
                let progress = (self.timing.emphasis)(elapsed.as_secs_f32() / self.timing.state.as_secs_f32());
                return Presence {
                    pose: blend.from.pose.mix(pose, progress),
                    amplitude: blend.from.amplitude + (amplitude - blend.from.amplitude) * progress,
                };
            }
            self.blend = None;
        }
        Presence { pose, amplitude }
    }

    fn change_state(&mut self, status: FaceState, d: Pixels, now: Instant) {
        if self.status == status {
            return;
        }
        let from = self.presence(d, now);
        self.status = status;
        self.blend = Some(StateBlend { from, began: now });
        if status == FaceState::Asleep {
            self.gaze = Gaze::new(GAZE_RATE, now);
            self.press = Press { at: now, from: 0., down: false };
            self.hover_blink = None;
        }
    }

    fn current(
        &mut self,
        d: Pixels,
        now: Instant,
        epoch: Instant,
        seed: u64,
        looking_down: bool,
        shared_blink: Option<Blink>,
    ) -> (Pose, bool, bool) {
        let Presence { mut pose, amplitude } = self.presence(d, now);
        if self.status == FaceState::Asleep {
            return (pose, self.blend.is_some(), false);
        }
        let (press, pressing) = self.press.sample(now, self.timing);
        let gaze = if looking_down { ((0., -0.6), 1.) } else { self.gaze.at(now) };
        let (mut aperture, mut blinking) = (1_f32, false);
        if self.allows_blink {
            for blink in [self.hover_blink, shared_blink].into_iter().flatten() {
                self.last_blink = Some(self.last_blink.map_or(blink.at, |last| last.max(blink.at)));
                aperture = aperture.min(blink.opening(now, self.timing));
                blinking |= blink.moving(now);
            }
        }
        if amplitude > 0. {
            let elapsed = now.saturating_duration_since(epoch).as_secs_f64();
            let tick = (elapsed / WORK_FRAME.as_secs_f64()).floor() * WORK_FRAME.as_secs_f64();
            pose = pose.with_work(amplitude, (tick % 2.4) as f32, seed, gaze.1);
        }
        let working = press < 1. && gaze.1 < 1. && (amplitude > 0. || self.status == FaceState::Working);
        let moving =
            (self.blend.is_some() && !working) || pressing || blinking || (!looking_down && !self.gaze.settled(now));
        (pose.with_input(gaze, press, aperture), moving, working)
    }

    pub(crate) fn follow(&mut self, bounds: Bounds<Pixels>, pointer: Point<Pixels>) {
        let now = Instant::now();
        if self.allows_blink
            && !self.gaze.holding()
            && self.last_blink.is_none_or(|last| now.saturating_duration_since(last) > REBLINK)
        {
            self.hover_blink = Some(Blink::once(now));
            self.last_blink = Some(now);
        }
        let (x, y) = aim(bounds, pointer);
        self.gaze.look(x, y, now);
    }

    pub(crate) fn rest(&mut self) -> bool {
        if !self.gaze.holding() {
            return false;
        }
        self.gaze.release(Instant::now());
        true
    }

    pub(crate) fn press(&mut self, down: bool) -> bool {
        if self.press.down == down {
            return false;
        }
        let at = Instant::now();
        let (from, _) = self.press.sample(at, self.timing);
        self.press = Press { at, from, down };
        true
    }
}

pub(crate) struct WatchedFace {
    pub bounds: Bounds<Pixels>,
    pub state: WeakEntity<FaceMotion>,
}

/// The built-in fallback, with optional input from a surrounding watch region.
#[derive(IntoElement)]
pub struct Face {
    id: ElementId,
    d: Pixels,
    paint: FacePaint,
    timing: FaceTiming,
    watch: Option<SharedString>,
    looking_down: bool,
    contact: bool,
    status: FaceState,
    blink_scope: Option<SharedString>,
    seed: u64,
}

impl Face {
    pub fn new(id: impl Into<ElementId>, bot: &str, d: Pixels, paint: FacePaint, timing: FaceTiming) -> Self {
        Self {
            id: id.into(),
            d,
            paint,
            timing,
            watch: None,
            looking_down: false,
            contact: true,
            status: FaceState::Rest,
            blink_scope: None,
            seed: u64::from(fnv1a(bot.as_bytes())),
        }
    }

    pub fn state(mut self, status: FaceState) -> Self {
        self.status = status;
        self
    }

    pub fn blink_in(mut self, scope: Option<SharedString>) -> Self {
        self.blink_scope = scope;
        self
    }

    pub fn watch(mut self, key: Option<SharedString>) -> Self {
        self.watch = key;
        self
    }

    pub fn looking_down(mut self, looking_down: bool) -> Self {
        self.looking_down = looking_down;
        self
    }

    pub fn contact_shadow(mut self, contact: bool) -> Self {
        self.contact = contact;
        self
    }
}

impl RenderOnce for Face {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let Self { id, d, paint, timing, watch, looking_down, contact, status, blink_scope, seed } = self;
        let small = Tier::of(d) == Tier::Small;
        let status = if small && status == FaceState::Working { FaceState::Rest } else { status };
        div().id(id).size(d).flex_shrink_0().child(
            canvas(
                move |bounds, window, cx| {
                    if !bounds.intersects(&window.content_mask().bounds) {
                        return None;
                    }
                    let avatars = cx.try_global::<Avatars>();
                    if let Some(pose) = static_pose(status, d, cx.reduce_motion() || avatars.is_none()) {
                        return Some(pose);
                    }
                    let epoch = avatars?.epoch;
                    let watch = watch.filter(|_| !small);
                    let eligibility = blink_scope.filter(|_| !small && status != FaceState::Asleep);
                    let shared_blink = eligibility.as_ref().and_then(|scope| blink::active(scope, window, cx));
                    let now = Instant::now();
                    let motion = window.use_keyed_state("face-motion", cx, |_, cx| {
                        if let Some(key) = watch.clone() {
                            let id = cx.entity_id();
                            cx.on_release(move |_, cx| {
                                let owns_watch = cx
                                    .try_global::<Avatars>()
                                    .and_then(|avatars| avatars.watched_faces.get(&key))
                                    .is_some_and(|watch| watch.state.entity_id() == id);
                                if owns_watch {
                                    cx.global_mut::<Avatars>().watched_faces.remove(&key);
                                }
                            })
                            .detach();
                        }
                        FaceMotion::new(now, timing, status)
                    });
                    if let Some(key) = watch {
                        if status == FaceState::Asleep {
                            cx.global_mut::<Avatars>().watched_faces.remove(&key);
                        } else {
                            cx.global_mut::<Avatars>()
                                .watched_faces
                                .insert(key, WatchedFace { bounds, state: motion.downgrade() });
                        }
                    }
                    let (pose, moving, working) = motion.update(cx, |motion, _| {
                        motion.change_state(status, d, now);
                        motion.allows_blink = eligibility.is_some();
                        if cfg!(target_os = "windows") && !window.is_window_hovered() {
                            motion.rest();
                            motion.press(false);
                        }
                        motion.current(d, now, epoch, seed, looking_down, shared_blink)
                    });
                    if moving {
                        window.request_animation_frame();
                    } else if working {
                        request_work_frame(window, cx);
                    }
                    Some(pose)
                },
                move |bounds, pose, window, _| {
                    if let Some(pose) = pose {
                        draw(bounds, d, paint, pose, contact, window);
                    }
                },
            )
            .size_full(),
        )
    }
}

fn static_pose(status: FaceState, diameter: Pixels, still: bool) -> Option<Pose> {
    still.then(|| status.still_at(diameter))
}

/// One pending 30 Hz frame for all visible working spheres in the window.
fn request_work_frame(window: &mut Window, cx: &mut App) {
    let id = window.window_handle().window_id();
    if !cx.global_mut::<Avatars>().face_work_pending.insert(id) {
        return;
    }
    window
        .spawn(cx, async move |cx| {
            cx.background_executor().timer(WORK_FRAME).await;
            let _ = cx.update(|window, cx| {
                cx.global_mut::<Avatars>().face_work_pending.remove(&id);
                if window.is_visible() && !cx.reduce_motion() {
                    window.refresh();
                }
            });
        })
        .detach();
}

#[cfg(test)]
mod tests {
    use super::{static_pose, FaceState, FaceTiming, Instant, Press, PRESS};
    use gpui_kit::{linear, px};
    use std::time::Duration;

    #[test]
    fn reduced_motion_uses_the_centered_pose_even_while_working() {
        assert!(static_pose(FaceState::Working, px(48.), false).is_none());
        let pose = static_pose(FaceState::Working, px(48.), true).unwrap();
        assert_eq!(pose.eye_dx, 0.);
        assert_eq!(pose.eye_dy, 0.);
        assert_eq!(pose.shine_dx, 0.);
        assert_eq!(pose.shine_dy, 0.);
    }

    #[test]
    fn pressure_finishes_at_70_ms_and_release_uses_the_supplied_settle_time() {
        let at = Instant::now();
        let timing = FaceTiming {
            standard: linear,
            emphasis: linear,
            settle: Duration::from_millis(160),
            state: Duration::from_millis(240),
            ease_in: linear,
        };
        let press = Press {
            at,
            from: 0.,
            down: true,
        };
        assert_eq!(PRESS, Duration::from_millis(70));
        assert!(press.sample(at + PRESS - Duration::from_millis(1), timing).1);
        assert_eq!(press.sample(at + PRESS, timing), (1., false));
        let release = Press {
            at,
            from: 1.,
            down: false,
        };
        assert!(release.sample(at + timing.settle - Duration::from_millis(1), timing).1);
        assert_eq!(release.sample(at + timing.settle, timing), (0., false));
    }
}
