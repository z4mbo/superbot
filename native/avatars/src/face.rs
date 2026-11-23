//! The built-in bot mark: one flat body with two eyes cut out of it, drawn with the even-odd
//! rule (see `mark.rs`). All geometry is relative to the diameter of the avatar slot.

use crate::mark::{self, Shape};
use gpui_kit::{canvas, div, point, px, Bounds, Div, Hsla, ParentElement, PathBuilder, Pixels, Point, Styled, Window};

#[derive(Clone, Copy)]
pub struct FacePaint {
    pub body: Hsla,
    pub eyes: Hsla,
    pub dark: bool,
    pub shape: Shape,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Small,
    Medium,
    Large,
}

impl Tier {
    pub fn of(d: Pixels) -> Self {
        if d < px(20.) {
            Self::Small
        } else if d < px(42.) {
            Self::Medium
        } else {
            Self::Large
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub eye_dx: f32,
    pub eye_dy: f32,
    pub eye_w: f32,
    pub eye_h: f32,
    pub eye_y: f32,
    pub spread: f32,
    pub shine_dx: f32,
    pub shine_dy: f32,
}

impl Default for Pose {
    fn default() -> Self {
        Self { eye_dx: 0., eye_dy: 0., eye_w: 1., eye_h: 1., eye_y: 0.47, spread: 1., shine_dx: 0., shine_dy: 0. }
    }
}

pub fn face(d: Pixels, paint: FacePaint, pose: Pose) -> Div {
    div().size(d).flex_shrink_0().child(
        canvas(|_, _, _| (), move |bounds, (), window, _| draw(bounds, d, paint, pose, true, window)).size_full(),
    )
}

pub(crate) fn draw(
    bounds: Bounds<Pixels>,
    d: Pixels,
    paint: FacePaint,
    pose: Pose,
    _contact: bool,
    window: &mut Window,
) {
    let frame = mark_frame(pose);
    let radius = f32::from(d) * mark::BODY_FILL / 2.;
    let center = bounds.center();
    let mut path = PathBuilder::fill();
    for outline in mark::outlines(paint.shape, &frame) {
        let mut points = outline.into_iter().map(|(x, y)| center + point(px(x * radius), px(y * radius)));
        let Some(first) = points.next() else { continue };
        path.move_to(first);
        for next in points {
            path.line_to(next);
        }
        path.close();
    }
    if let Ok(path) = path.build() {
        window.paint_path(path, paint.body);
    }
}

/// The mark's look for a face pose: the pose's eye offset turns the face, its eye size scales the
/// eyes. A face looking nowhere in particular glances up and aside with short tilted eyes.
pub(crate) fn mark_frame(pose: Pose) -> mark::Frame {
    let gaze = (pose.eye_dx / 0.09 * 0.5, pose.eye_dy / 0.07 * 0.5);
    let idle = gaze.0.abs() < 0.02 && gaze.1.abs() < 0.02;
    let eye = |base: mark::Eye| mark::Eye { w: base.w * pose.eye_w, h: base.h * pose.eye_h, tilt: 0. };
    if idle && (pose.eye_y - 0.47).abs() < 1e-3 {
        let comma = eye(mark::Eye { w: 0.23, h: 0.52, tilt: 0. });
        let resting = (0.32, -0.44);
        return mark::Frame {
            gaze: resting,
            left: comma,
            right: comma,
            roll: f32::atan2(resting.1, resting.0) * 0.66,
            ..mark::Frame::default()
        };
    }
    mark::Frame {
        gaze,
        left: eye(mark::REST_EYE),
        right: eye(mark::REST_EYE),
        lift: -0.05 + (pose.eye_y - 0.47) * 2.,
        spread: 0.305 * pose.spread,
        ..mark::Frame::default()
    }
}

fn eye_dimensions(d: Pixels) -> (Pixels, Pixels) {
    let snap = |length: Pixels| if d < px(24.) { px(f32::from(length).round()) } else { length };
    (snap(d * 0.14), snap(d * 0.21))
}

pub(crate) fn aim(bounds: Bounds<Pixels>, pointer: Point<Pixels>) -> (f32, f32) {
    let offset = pointer - bounds.center();
    let reach = (f32::from(bounds.size.width) * 4.).clamp(64., 160.);
    let axis = |delta: Pixels| (f32::from(delta) / reach).clamp(-1., 1.);
    (axis(offset.x), -axis(offset.y))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FaceState {
    #[default]
    Rest,
    Working,
    Waiting,
    Failed,
    Asleep,
}

impl FaceState {
    fn still(self) -> Pose {
        let mut pose = Pose::default();
        match self {
            Self::Rest => {}
            Self::Working => pose.eye_h = 0.85,
            Self::Waiting => {
                pose.eye_h = 1.10;
                pose.eye_w = 1.05;
            }
            Self::Failed => {
                pose.eye_h = 0.45;
                pose.eye_y += 0.03;
            }
            Self::Asleep => {
                pose.eye_h = 0.045 / 0.21;
                pose.eye_w = 0.16 / 0.14;
                pose.eye_y = 0.52;
            }
        }
        pose
    }

    pub(crate) fn still_at(self, d: Pixels) -> Pose {
        let mut pose = self.still();
        if self == Self::Asleep {
            let (w, h) = eye_dimensions(d);
            pose.eye_w = d * 0.16 / w;
            pose.eye_h = (d * 0.045).max(px(1.5)) / h;
        }
        pose
    }
}

impl Pose {
    pub(crate) fn mix(self, to: Self, progress: f32) -> Self {
        let blend = |a, b| a + (b - a) * progress;
        Self {
            eye_dx: blend(self.eye_dx, to.eye_dx),
            eye_dy: blend(self.eye_dy, to.eye_dy),
            eye_w: blend(self.eye_w, to.eye_w),
            eye_h: blend(self.eye_h, to.eye_h),
            eye_y: blend(self.eye_y, to.eye_y),
            spread: blend(self.spread, to.spread),
            shine_dx: blend(self.shine_dx, to.shine_dx),
            shine_dy: blend(self.shine_dy, to.shine_dy),
        }
    }

    pub(crate) fn with_work(mut self, amplitude: f32, work: f32, seed: u64, hold: f32) -> Self {
        let phase = ((seed as f64) % std::f64::consts::TAU) as f32;
        let cycle = std::f32::consts::TAU * (work / 2.4);
        let visible = amplitude * (1. - hold);
        self.eye_dx += 0.07 * visible * (cycle + phase).sin();
        self.eye_dy += 0.015 * visible * (2. * cycle + phase).sin();
        self.eye_h += (1. - 0.85) * amplitude * hold;
        self
    }

    pub(crate) fn with_input(mut self, gaze: ((f32, f32), f32), press: f32, blink: f32) -> Self {
        let ((x, y), hold) = gaze;
        let gx = x * hold * (1. - press);
        let gy = y * hold * (1. - press);
        self.eye_dx = self.eye_dx * (1. - press) + 0.09 * gx;
        self.eye_dy = self.eye_dy * (1. - press) - 0.07 * gy;
        self.eye_w *= (1. - 0.20 * gx.abs()) * (1. + 0.06 * press);
        self.eye_h *= (1. - 0.18 * press) * blink;
        self.spread *= 1. - 0.10 * gx.abs();
        self.shine_dx = -0.03 * gx;
        self.shine_dy = 0.02 * gy;
        self
    }
}

/// The expression at a point in the working cycle. `blink` is the fraction the eyelids are open.
pub fn pose(state: FaceState, gaze: ((f32, f32), f32), press: f32, blink: f32, work: f32, seed: u64) -> Pose {
    let mut pose = state.still();
    if state == FaceState::Asleep {
        return pose;
    }
    if state == FaceState::Working {
        pose = pose.with_work(1., work, seed, gaze.1);
    }
    pose.with_input(gaze, press, blink)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{point, size};

    #[test]
    fn pointer_is_normalized_about_the_slot_center_and_clamped() {
        let bounds = Bounds { origin: point(px(10.), px(20.)), size: size(px(42.), px(42.)) };
        assert_eq!(aim(bounds, point(px(111.), px(1.))), (0.5, 0.25));
        assert_eq!(aim(bounds, point(px(400.), px(400.))), (1., -1.));
        let small = Bounds { origin: point(px(0.), px(0.)), size: size(px(12.), px(12.)) };
        assert_eq!(aim(small, point(px(38.), px(6.))), (0.5, 0.));
    }

    #[test]
    fn a_face_looking_nowhere_glances_up_and_aside_and_a_turned_face_follows_its_pose() {
        let resting = mark_frame(Pose::default());
        assert!(resting.gaze.0 > 0. && resting.gaze.1 < 0.);
        assert!(resting.roll < 0.);
        let looking = mark_frame(pose(FaceState::Rest, ((1., 0.), 1.), 0., 1., 0., 0));
        assert!(looking.gaze.0 > 0.4);
        assert_eq!(looking.roll, 0.);
        let blinking = mark_frame(pose(FaceState::Rest, ((1., 0.), 1.), 0., 0.1, 0., 0));
        assert!(blinking.left.h < looking.left.h);
    }

    #[test]
    fn states_keep_their_expression_and_work_yields_to_gaze() {
        let neutral = ((0., 0.), 0.);
        assert_eq!(pose(FaceState::Rest, neutral, 0., 1., 0., 0), Pose::default());
        let work = pose(FaceState::Working, neutral, 0., 1., 0.6, 0);
        assert!((work.eye_dx - 0.07).abs() < 1e-6);
        assert_eq!(work.eye_h, 0.85);
        let other_bot = pose(FaceState::Working, neutral, 0., 1., 0.6, 1);
        assert_ne!(work.eye_dx, other_bot.eye_dx);
        let again = pose(FaceState::Working, neutral, 0., 1., 3., 0);
        assert!((work.eye_dx - again.eye_dx).abs() < 1e-6);
        let gaze = ((0.5, 0.), 1.);
        assert_eq!(pose(FaceState::Working, gaze, 0., 1., 0.6, 0), pose(FaceState::Rest, gaze, 0., 1., 0., 0));
        let waiting = pose(FaceState::Waiting, neutral, 0., 1., 0., 0);
        assert_eq!((waiting.eye_h, waiting.eye_w), (1.10, 1.05));
        let failed = pose(FaceState::Failed, neutral, 0., 1., 0., 0);
        assert!((failed.eye_y - 0.50).abs() < 1e-6);
        assert_eq!(failed.eye_h, 0.45);
        let asleep = pose(FaceState::Asleep, gaze, 1., 0.12, 1., 1);
        assert_eq!(asleep, FaceState::Asleep.still());
        assert_eq!(asleep.eye_y, 0.52);
        let asleep_frame = mark_frame(FaceState::Asleep.still_at(px(22.)));
        assert!(asleep_frame.left.h < 0.2);
    }
}
