//! The built-in sphere. All geometry is relative to the diameter of the avatar slot.

use gpui_kit::{
    black, canvas, div, fill, linear_color_stop, linear_gradient, point, px, size, white, Background, Bounds,
    BoxShadow, Corners, Div, Hsla, ParentElement, PathBuilder, Pixels, Point, Rgba, Styled, Window,
};

#[derive(Clone, Copy)]
pub struct FacePaint {
    pub body: Hsla,
    pub eyes: Hsla,
    pub dark: bool,
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

fn mix(base: Hsla, over: Hsla, amount: f32) -> Hsla {
    let (base, over) = (base.to_rgb(), over.to_rgb());
    let blend = |from: f32, to: f32| from + (to - from) * amount;
    Rgba { r: blend(base.r, over.r), g: blend(base.g, over.g), b: blend(base.b, over.b), a: base.a }.into()
}

fn gradient(angle: f32, high: Hsla, low: Hsla) -> Background {
    linear_gradient(angle, linear_color_stop(high, 0.), linear_color_stop(low, 1.))
}

fn body_stops(body: Hsla) -> (Hsla, Hsla) {
    (mix(body, white(), 0.16), mix(body, black(), 0.22))
}

fn gleam_alpha(paint: FacePaint) -> f32 {
    let rgb = paint.body.to_rgb();
    let linear = |c: f32| if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
    let luminance = 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
    let alpha = if paint.dark { 0.30 } else { 0.36 };
    if luminance > 0.6 {
        alpha / 2.
    } else {
        alpha
    }
}

fn shadow(color: Hsla, y: Pixels, blur_radius: Pixels, spread_radius: Pixels, inset: bool) -> BoxShadow {
    BoxShadow { color, offset: point(px(0.), y), blur_radius, spread_radius, inset }
}

fn gleam(bounds: Bounds<Pixels>, d: Pixels, paint: FacePaint, pose: Pose, window: &mut Window) {
    let radii = point(d * 0.20, d * 0.12);
    let center = bounds.origin + point(d * (0.36 + pose.shine_dx), d * (0.22 + pose.shine_dy));
    let left = center - point(radii.x, px(0.));
    let right = center + point(radii.x, px(0.));
    let mut path = PathBuilder::fill();
    path.move_to(left);
    path.arc_to(radii, px(0.), false, true, right);
    path.arc_to(radii, px(0.), false, true, left);
    path.close();
    if let Ok(path) = path.build() {
        window.paint_path(path, gradient(180., white().opacity(gleam_alpha(paint)), white().opacity(0.)));
    }
}

pub fn face(d: Pixels, paint: FacePaint, pose: Pose) -> Div {
    div().size(d).flex_shrink_0().child(
        canvas(|_, _, _| (), move |bounds, (), window, _| draw(bounds, d, paint, pose, true, window)).size_full(),
    )
}

fn pill(bounds: Bounds<Pixels>, color: impl Into<Background>, window: &mut Window) {
    let radius = bounds.size.width.min(bounds.size.height) / 2.;
    window.paint_quad(fill(bounds, color).corner_radii(Corners::all(radius)));
}

pub(crate) fn draw(
    bounds: Bounds<Pixels>,
    d: Pixels,
    paint: FacePaint,
    pose: Pose,
    contact: bool,
    window: &mut Window,
) {
    let tier = Tier::of(d);
    let corners = Corners::all(d / 2.);
    if contact && tier == Tier::Large {
        let alpha = if paint.dark { 0.40 } else { 0.14 };
        let contact = shadow(black().opacity(alpha), d * 0.05, d * 0.10, d * -0.06, false);
        window.paint_drop_shadows(bounds, corners, &[contact]);
    }
    let (high, low) = body_stops(paint.body);
    pill(bounds, gradient(150., high, low), window);
    if tier != Tier::Small {
        let shade = if paint.dark { 0.22 } else { 0.16 };
        let light = if paint.dark { 0.18 } else { 0.30 };
        window.paint_inset_shadows(
            bounds,
            corners,
            &[
                shadow(black().opacity(shade), d * -0.04, d * 0.10, px(0.), true),
                shadow(white().opacity(light), d * 0.03, d * 0.05, px(0.), true),
            ],
        );
        gleam(bounds, d, paint, pose, window);
    }
    for eye in eyes(d, pose) {
        pill(eye + bounds.origin, paint.eyes, window);
    }
}

fn eye_dimensions(d: Pixels) -> (Pixels, Pixels) {
    let snap = |length: Pixels| if d < px(24.) { px(f32::from(length).round()) } else { length };
    (snap(d * 0.14), snap(d * 0.21))
}

fn eyes(d: Pixels, pose: Pose) -> [Bounds<Pixels>; 2] {
    let (w, h) = eye_dimensions(d);
    let (w, h) = (w * pose.eye_w, h * pose.eye_h);
    [-1., 1.].map(|side| {
        let x = d * (0.5 + pose.eye_dx + side * 0.15 * pose.spread);
        let y = d * (pose.eye_y + pose.eye_dy);
        Bounds { origin: point(x - w / 2., y - h / 2.), size: size(w, h) }
    })
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
    use gpui_kit::rgb;

    #[test]
    fn pointer_is_normalized_about_the_slot_center_and_clamped() {
        let bounds = Bounds { origin: point(px(10.), px(20.)), size: size(px(42.), px(42.)) };
        assert_eq!(aim(bounds, point(px(111.), px(1.))), (0.5, 0.25));
        assert_eq!(aim(bounds, point(px(400.), px(400.))), (1., -1.));
        let small = Bounds { origin: point(px(0.), px(0.)), size: size(px(12.), px(12.)) };
        assert_eq!(aim(small, point(px(38.), px(6.))), (0.5, 0.));
    }

    #[test]
    fn eyes_move_and_foreshorten_on_the_sphere_and_press_recenters_them() {
        let d = px(42.);
        let looking = pose(FaceState::Rest, ((1., -0.5), 1.), 0., 1., 0., 0);
        let [left, right] = eyes(d, looking);
        let close = |actual: Pixels, expected: f32| assert!((f32::from(actual) - expected).abs() < 1e-4);
        close(left.center().x, 42. * (0.59 - 0.135));
        close(right.center().x, 42. * (0.59 + 0.135));
        close(right.center().y, 42. * (0.47 + 0.035));
        close(right.size.width, 42. * 0.14 * 0.8);
        assert!(f32::from(right.right()) < 42. * 0.81);
        assert_eq!(looking.shine_dx, -0.03);
        let pressed = pose(FaceState::Rest, ((1., -0.5), 1.), 1., 1., 0., 0);
        assert_eq!((pressed.eye_dx, pressed.eye_dy), (0., 0.));
        assert!((pressed.eye_h - 0.82).abs() < 1e-6);
        assert_eq!(pressed.eye_w, 1.06);
    }

    #[test]
    fn the_22_pixel_slot_starts_with_whole_pixel_eyes() {
        let [eye, _] = eyes(px(22.), Pose::default());
        assert_eq!(eye.size, size(px(3.), px(5.)));
    }

    #[test]
    fn body_stops_mix_in_srgb() {
        let (high, low) = body_stops(rgb(0x009957).into());
        for (actual, expected) in [(high, 0x29a972), (low, 0x007744)] {
            let (actual, expected) = (actual.to_rgb(), rgb(expected));
            for (a, b) in [(actual.r, expected.r), (actual.g, expected.g), (actual.b, expected.b)] {
                assert!((a - b).abs() <= 0.5 / 255.);
            }
        }
    }

    #[test]
    fn gleam_uses_skin_strength_and_halves_it_for_light_bodies() {
        for (dark, alpha) in [(true, 0.30), (false, 0.36)] {
            assert_eq!(gleam_alpha(FacePaint { body: black(), eyes: white(), dark }), alpha);
            assert_eq!(gleam_alpha(FacePaint { body: white(), eyes: black(), dark }), alpha / 2.);
        }
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
        let [eye, _] = eyes(px(22.), FaceState::Asleep.still_at(px(22.)));
        assert_eq!(eye.size.height, px(1.5));
    }
}
