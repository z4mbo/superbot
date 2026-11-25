//! The bot mark, the same drawing the web app makes (`packages/core/src/avatars/bot-mark.ts`):
//! one flat body with two eyes cut out of it as a single even-odd path. The eyes sit like decals
//! on a sphere seen head-on, so looking aside slides them toward the rim and narrows them. Nothing
//! is shaded or extruded. Geometry is in body radii; the body is a radius-1 disc for the circle.

use std::f32::consts::{PI, TAU};
use std::sync::OnceLock;

pub type Point = (f32, f32);

/// The body takes this share of the avatar slot, as in the web app (60% of a 192-unit box seen
/// through a 124-unit window).
pub const BODY_FILL: f32 = 0.93;

macro_rules! shapes {
    ($($name:ident => $key:literal),* $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Shape { $($name),* }
        impl Shape {
            pub const ALL: &'static [Shape] = &[$(Shape::$name),*];
            pub fn key(self) -> &'static str { match self { $(Shape::$name => $key),* } }
            pub fn named(name: &str) -> Option<Shape> { match name { $($key => Some(Shape::$name),)* _ => None } }
        }
    };
}

shapes! {
    Circle => "circle", Arch => "arch", Bean => "bean", Blob => "blob", Capsule => "capsule",
    Cloud => "cloud", Clover => "clover", Crystal => "crystal", Cylinder => "cylinder",
    Dome => "dome", Egg => "egg", Flower => "flower", Gem => "gem", Heart => "heart", Hex => "hex",
    House => "house", Leaf => "leaf", Pebble => "pebble", Pumpkin => "pumpkin", Shield => "shield",
    Sparkle => "sparkle", Square => "square", Squircle => "squircle", Star => "star",
    Tablet => "tablet", Teardrop => "teardrop", Wedge => "wedge",
}

/// The same 32-bit FNV-1a hash the web app uses, so a bot gets the same shape everywhere.
pub fn seed(identity: &str) -> u32 {
    let mut hash: u32 = 2166136261;
    for unit in identity.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(16777619);
    }
    hash
}

impl Shape {
    /// The picked shape when it is one of ours, else the one the bot's identity picks.
    pub fn for_bot(identity: &str, picked: Option<&str>) -> Shape {
        picked.and_then(Shape::named).unwrap_or_else(|| Shape::ALL[(seed(identity) as usize) % Shape::ALL.len()])
    }

    /// The outline in body radii, centred and evened out in size. Cached per shape.
    pub fn body(self) -> &'static [Point] {
        static BODIES: OnceLock<Vec<Vec<Point>>> = OnceLock::new();
        let bodies = BODIES.get_or_init(|| Shape::ALL.iter().map(|shape| normalised(*shape)).collect());
        let index = Shape::ALL.iter().position(|shape| *shape == self).unwrap_or(0);
        &bodies[index]
    }
}

const SAMPLES: usize = 72;

fn polar(radius: impl Fn(f32) -> f32, sx: f32, sy: f32) -> Vec<Point> {
    (0..SAMPLES)
        .map(|index| {
            let theta = index as f32 / SAMPLES as f32 * TAU - PI / 2.;
            let r = radius(theta);
            (theta.cos() * r * sx, theta.sin() * r * sy)
        })
        .collect()
}

fn superellipse(power: f32, sx: f32, sy: f32) -> Vec<Point> {
    superellipse_turned(power, sx, sy, 0.)
}

fn superellipse_turned(power: f32, sx: f32, sy: f32, turn: f32) -> Vec<Point> {
    (0..SAMPLES)
        .map(|index| {
            let theta = index as f32 / SAMPLES as f32 * TAU;
            let (c, s) = (theta.cos(), theta.sin());
            let (x, y) = (c.signum() * c.abs().powf(2. / power) * sx, s.signum() * s.abs().powf(2. / power) * sy);
            (x * turn.cos() - y * turn.sin(), x * turn.sin() + y * turn.cos())
        })
        .collect()
}

fn resample(points: &[Point], count: usize) -> Vec<Point> {
    let mut lengths = vec![0.];
    for index in 1..=points.len() {
        let (a, b) = (points[index - 1], points[index % points.len()]);
        lengths.push(lengths[index - 1] + ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt());
    }
    let total = lengths[points.len()];
    let mut out = Vec::with_capacity(count);
    let mut segment = 0;
    for index in 0..count {
        let at = index as f32 / count as f32 * total;
        while lengths[segment + 1] < at {
            segment += 1;
        }
        let (a, b) = (points[segment], points[(segment + 1) % points.len()]);
        let span = (lengths[segment + 1] - lengths[segment]).max(f32::EPSILON);
        let t = (at - lengths[segment]) / span;
        out.push((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t));
    }
    out
}

/// Corner-cut a polygon until its corners read as soft.
fn rounded(points: &[Point], passes: usize) -> Vec<Point> {
    let mut shape = points.to_vec();
    for _ in 0..passes {
        let mut next = Vec::with_capacity(shape.len() * 2);
        for index in 0..shape.len() {
            let (a, b) = (shape[index], shape[(index + 1) % shape.len()]);
            next.push((a.0 * 0.75 + b.0 * 0.25, a.1 * 0.75 + b.1 * 0.25));
            next.push((a.0 * 0.25 + b.0 * 0.75, a.1 * 0.25 + b.1 * 0.75));
        }
        shape = next;
    }
    resample(&shape, SAMPLES)
}

fn parametric(fun: impl Fn(f32) -> Point) -> Vec<Point> {
    let raw: Vec<Point> = (0..360).map(|index| fun(index as f32 / 360. * TAU)).collect();
    resample(&raw, SAMPLES)
}

fn raw(shape: Shape) -> Vec<Point> {
    use Shape::*;
    match shape {
        Circle => polar(|_| 1., 1., 1.),
        Arch => rounded(
            &[(-0.82, 0.95), (-0.82, -0.15), (-0.6, -0.7), (0., -1.), (0.6, -0.7), (0.82, -0.15), (0.82, 0.95)],
            4,
        ),
        Bean => polar(|t| 1. + 0.1 * (2. * t).cos() - 0.22 * (t + 0.4).cos().max(0.).powi(6), 1.06, 0.86),
        Blob => polar(|t| 1. + 0.07 * (3. * t + 0.5).cos() + 0.05 * (5. * t).sin(), 1., 1.),
        Capsule => superellipse_turned(2.57, 1.144, 0.811, -0.237),
        Cloud => polar(|t| 0.84 + 0.12 * (2. * t + 0.2).cos().abs().powf(0.6), 1., 0.86),
        Clover => polar(|t| 0.879 + 0.137 * (2. * t - 0.055).cos().abs().powf(0.441), 1.116, 0.941),
        Crystal => rounded(&[(0., -1.08), (0.78, -0.3), (0.55, 0.9), (-0.55, 0.9), (-0.78, -0.3)], 3),
        Cylinder => superellipse(7., 0.82, 1.),
        Dome => {
            rounded(&[(-1., 0.7), (-0.95, -0.1), (-0.6, -0.72), (0., -0.92), (0.6, -0.72), (0.95, -0.1), (1., 0.7)], 4)
        }
        Egg => parametric(|t| (0.84 * t.cos() * (1. + 0.14 * t.sin()), 1.02 * t.sin())),
        Flower => polar(|t| 0.84 + 0.16 * (6. * t).cos(), 1., 1.),
        Gem => rounded(&[(-0.6, -0.8), (0.6, -0.8), (1.02, -0.25), (0., 1.), (-1.02, -0.25)], 3),
        Heart => parametric(|t| {
            (
                16. * t.sin().powi(3) / 16.5,
                -(13. * t.cos() - 5. * (2. * t).cos() - 2. * (3. * t).cos() - (4. * t).cos()) / 15. + 0.15,
            )
        }),
        Hex => rounded(
            &(0..6)
                .map(|index| {
                    let angle = index as f32 / 6. * TAU + PI / 6.;
                    (angle.cos() * 1.05, angle.sin() * 1.05)
                })
                .collect::<Vec<_>>(),
            3,
        ),
        House => rounded(&[(0., -1.02), (0.98, -0.2), (0.92, 0.92), (-0.92, 0.92), (-0.98, -0.2)], 4),
        Leaf => parametric(|t| {
            let (x, y) = (t.cos(), 0.62 * t.sin() * (1. - 0.25 * t.cos().powi(2)));
            let angle = -PI / 4.;
            (1.05 * (x * angle.cos() - y * angle.sin()), 1.05 * (x * angle.sin() + y * angle.cos()))
        }),
        Pebble => polar(|t| 1. + 0.05 * (2. * t + 0.6).cos() + 0.04 * (3. * t).cos(), 1.04, 0.9),
        Pumpkin => polar(|t| 0.92 + 0.08 * (3. * t).cos().abs().sqrt(), 1.1, 0.88),
        Shield => rounded(&[(-0.92, -0.9), (0.92, -0.9), (0.92, 0.12), (0., 1.02), (-0.92, 0.12)], 4),
        Sparkle => polar(|t| 0.62 + 0.42 * (2. * t).cos().abs().powf(2.4), 1., 1.),
        Square => superellipse(9., 0.92, 0.92),
        Squircle => superellipse(4., 0.96, 0.96),
        Star => polar(|t| 0.74 + 0.3 * ((1. + (5. * t + PI / 2.).cos()) / 2.).powf(1.6), 1., 1.),
        Tablet => superellipse(6., 0.8, 1.),
        Teardrop => rounded(&[(-0.585, -1.188), (0.747, 0.007), (-0.42, 0.877), (-1.158, -0.027)], 5),
        Wedge => rounded(&[(-0.44, 1.571), (1.919, 0.536), (-0.055, -0.881)], 4),
    }
}

fn normalised(shape: Shape) -> Vec<Point> {
    let raw = raw(shape);
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let mut area = 0.;
    for index in 0..raw.len() {
        let (a, b) = (raw[index], raw[(index + 1) % raw.len()]);
        area += a.0 * b.1 - b.0 * a.1;
        min_x = min_x.min(a.0);
        min_y = min_y.min(a.1);
        max_x = max_x.max(a.0);
        max_y = max_y.max(a.1);
    }
    // Each body covers about as much as the disc; the reference draws a few a little larger.
    let relative = match shape {
        Shape::Wedge => 1.09,
        Shape::Teardrop => 0.97,
        Shape::Capsule => 0.95,
        _ => 1.,
    };
    let area_scale = (PI * relative / (area / 2.).abs()).sqrt();
    let span = (max_x - min_x).max(max_y - min_y) / 2.;
    let scale = if shape == Shape::Circle { 1. } else { area_scale.min(1.3 / span) };
    let (cx, cy) = ((min_x + max_x) / 2., (min_y + max_y) / 2.);
    // Where the reference sits a lopsided body in its slot, off the centre of its outline.
    let (shift_x, shift_y) = match shape {
        Shape::Wedge => (0.24, 0.24),
        Shape::Teardrop => (0.09, 0.06),
        _ => (0., 0.),
    };
    raw.into_iter().map(|(x, y)| ((x - cx) * scale + shift_x, (y - cy) * scale + shift_y)).collect()
}

/// One eye's look on the face, in body radii.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Eye {
    pub w: f32,
    pub h: f32,
    pub tilt: f32,
}

pub const REST_EYE: Eye = Eye { w: 0.255, h: 0.56, tilt: 0. };

/// Where the face looks and how the body stands for one drawing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    /// The point the face turns to on the unit disc (x right, y down); at most 0.66 from centre.
    pub gaze: Point,
    pub left: Eye,
    pub right: Eye,
    pub spread: f32,
    pub lift: f32,
    /// Both eyes turned together, in radians.
    pub roll: f32,
    pub sx: f32,
    pub sy: f32,
    /// Body offset in body radii.
    pub dx: f32,
    pub dy: f32,
}

impl Default for Frame {
    fn default() -> Self {
        Frame {
            gaze: (0., 0.),
            left: REST_EYE,
            right: REST_EYE,
            spread: 0.305,
            lift: -0.05,
            roll: 0.,
            sx: 1.,
            sy: 1.,
            dx: 0.,
            dy: 0.,
        }
    }
}

const MAX_GAZE: f32 = 0.66;

fn clamp_gaze((x, y): Point) -> Point {
    let length = (x * x + y * y).sqrt();
    if length > MAX_GAZE {
        (x / length * MAX_GAZE, y / length * MAX_GAZE)
    } else {
        (x, y)
    }
}

type Vec3 = [f32; 3];

fn rotation(gaze: Point) -> impl Fn(Vec3) -> Vec3 {
    let (gx, gy) = gaze;
    let gz = (1. - gx * gx - gy * gy).max(0.).sqrt();
    let sin = (gx * gx + gy * gy).sqrt();
    let (ax, ay) = if sin < 1e-6 { (0., 0.) } else { (-gy / sin, gx / sin) };
    let cos = gz;
    move |[x, y, z]: Vec3| {
        if sin < 1e-6 {
            return [x, y, z];
        }
        let dot = ax * x + ay * y;
        let (cross_x, cross_y, cross_z) = (ay * z, -ax * z, ax * y - ay * x);
        [
            x * cos + cross_x * sin + ax * dot * (1. - cos),
            y * cos + cross_y * sin + ay * dot * (1. - cos),
            z * cos + cross_z * sin,
        ]
    }
}

const EYE_SAMPLES: usize = 28;

fn eye_outline(side: f32, eye: Eye, frame: &Frame, rotate: &impl Fn(Vec3) -> Vec3) -> Option<Vec<Point>> {
    if eye.h < 0.012 {
        return None;
    }
    let roll = frame.roll;
    let x0 = side * frame.spread * roll.cos() - frame.lift * roll.sin();
    let y0 = side * frame.spread * roll.sin() + frame.lift * roll.cos();
    let z0 = (1. - x0 * x0 - y0 * y0).max(0.).sqrt();
    let center = rotate([x0, y0, z0]);
    let u = rotate([z0, 0., -x0]);
    let v = rotate([0., 1., 0.]);
    let tilt = eye.tilt * side + roll;
    let (cos_t, sin_t) = (tilt.cos(), tilt.sin());
    Some(
        (0..EYE_SAMPLES)
            .map(|index| {
                let a = index as f32 / EYE_SAMPLES as f32 * TAU;
                let (c, s) = (a.cos(), a.sin());
                let lx = c.signum() * c.abs().powf(0.8) * eye.w / 2.;
                let ly = s.signum() * s.abs().powf(0.8) * eye.h / 2.;
                let (x, y) = (lx * cos_t - ly * sin_t, lx * sin_t + ly * cos_t);
                (center[0] + u[0] * x + v[0] * y, center[1] + u[1] * x + v[1] * y)
            })
            .collect(),
    )
}

fn inside((px, py): Point, polygon: &[Point]) -> bool {
    let mut hit = false;
    let mut j = polygon.len() - 1;
    for i in 0..polygon.len() {
        let ((xi, yi), (xj, yj)) = (polygon[i], polygon[j]);
        if (yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi {
            hit = !hit;
        }
        j = i;
    }
    hit
}

/// The outlines to fill with the even-odd rule, in body radii around the body's centre: the body,
/// then each open eye. Eyes that would cross the body's edge are pulled toward the middle first.
pub fn outlines(shape: Shape, frame: &Frame) -> Vec<Vec<Point>> {
    let body = shape.body();
    let mut gaze = clamp_gaze(frame.gaze);
    let mut eyes = Vec::new();
    for attempt in 0..5 {
        // The last try looks straight ahead, which fits every body.
        if attempt == 4 {
            gaze = (0., 0.);
        }
        let rotate = rotation(gaze);
        eyes = [eye_outline(-1., frame.left, frame, &rotate), eye_outline(1., frame.right, frame, &rotate)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if eyes.iter().all(|eye| eye.iter().all(|&(x, y)| inside((x / 0.97, y / 0.97), body))) {
            break;
        }
        gaze = (gaze.0 * 0.72, gaze.1 * 0.72);
    }
    let place = |(x, y): Point| (x * frame.sx + frame.dx, y * frame.sy + frame.dy);
    std::iter::once(body.iter().copied().map(place).collect())
        .chain(eyes.into_iter().map(|eye| eye.into_iter().map(place).collect()))
        .collect()
}

/// The ink nearest a stored bot colour, or the picked one, as an RGB value. `None` is neutral:
/// black on light, white on dark.
pub fn ink(picked: Option<&str>, color: &str) -> Option<u32> {
    const INKS: [(&str, u32, f32); 9] = [
        ("red", 0xfb2b3e, 354.),
        ("orange", 0xfd690f, 23.),
        ("yellow", 0xf59312, 35.),
        ("brown", 0xa06b39, 30.),
        ("green", 0x14c16f, 151.),
        ("cyan", 0x13b7a2, 172.),
        ("blue", 0x1e86fc, 212.),
        ("purple", 0x8f59f9, 261.),
        ("magenta", 0xf93498, 327.),
    ];
    match picked {
        Some("neutral") => return None,
        Some("gray") => return Some(0x9a9a9a),
        Some(name) => {
            if let Some((_, value, _)) = INKS.iter().find(|(key, ..)| *key == name) {
                return Some(*value);
            }
        }
        None => {}
    }
    let hex = color.split("::").next().unwrap_or("").trim_start_matches('#');
    let value = u32::from_str_radix(hex.get(..6)?, 16).ok()?;
    let (r, g, b) =
        (((value >> 16) & 255) as f32 / 255., ((value >> 8) & 255) as f32 / 255., (value & 255) as f32 / 255.);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    if max - min < 0.12 {
        return if !(0.25..=0.85).contains(&max) { None } else { Some(0x9a9a9a) };
    }
    let hue = if max == r {
        ((g - b) / (max - min)).rem_euclid(6.)
    } else if max == g {
        (b - r) / (max - min) + 2.
    } else {
        (r - g) / (max - min) + 4.
    } * 60.;
    if hue > 15. && hue < 45. && max < 0.7 {
        return Some(0xa06b39);
    }
    INKS.iter()
        .filter(|(name, ..)| *name != "brown")
        .min_by(|a, b| {
            let distance = |h: f32| (hue - h).abs().min(360. - (hue - h).abs());
            distance(a.2).total_cmp(&distance(b.2))
        })
        .map(|(_, value, _)| *value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shape_is_one_body_with_two_eye_holes_inside_it() {
        for shape in Shape::ALL {
            for gaze in [(0., 0.), (0.6, 0.), (-0.4, -0.45), (0.2, 0.6)] {
                let parts = outlines(*shape, &Frame { gaze, ..Frame::default() });
                assert_eq!(parts.len(), 3, "{shape:?}");
                for eye in &parts[1..] {
                    assert!(eye.iter().all(|&point| inside(point, &parts[0])), "{shape:?} {gaze:?}");
                }
            }
        }
    }

    #[test]
    fn the_disc_has_radius_one_and_rest_eyes_sit_apart_and_upright() {
        let parts = outlines(Shape::Circle, &Frame::default());
        let radius = parts[0].iter().map(|(x, y)| (x * x + y * y).sqrt()).fold(0., f32::max);
        assert!((radius - 1.).abs() < 1e-3);
        let height = |eye: &Vec<Point>| {
            eye.iter().map(|p| p.1).fold(f32::MIN, f32::max) - eye.iter().map(|p| p.1).fold(f32::MAX, f32::min)
        };
        let width = |eye: &Vec<Point>| {
            eye.iter().map(|p| p.0).fold(f32::MIN, f32::max) - eye.iter().map(|p| p.0).fold(f32::MAX, f32::min)
        };
        assert!(height(&parts[1]) > 2. * width(&parts[1]));
    }

    #[test]
    fn looking_aside_narrows_the_eyes() {
        let width = |frame: Frame| {
            let parts = outlines(Shape::Circle, &frame);
            parts[2].iter().map(|p| p.0).fold(f32::MIN, f32::max)
                - parts[2].iter().map(|p| p.0).fold(f32::MAX, f32::min)
        };
        assert!(width(Frame { gaze: (0.6, 0.), ..Frame::default() }) < width(Frame::default()));
    }

    #[test]
    fn shapes_and_inks_match_the_web_app() {
        assert_eq!(seed("maya"), 0xc969_9ea5);
        assert_eq!(Shape::for_bot("maya", None), Shape::Star);
        assert_eq!(Shape::for_bot("bot-1", None), Shape::Blob);
        assert_eq!(Shape::for_bot("bot-1", Some("cloud")), Shape::Cloud);
        assert_eq!(Shape::for_bot("bot-1", Some("nope")), Shape::for_bot("bot-1", None));
        assert_eq!(ink(Some("green"), "#000000"), Some(0x14c16f));
        assert_eq!(ink(None, "#1e86fc"), Some(0x1e86fc));
        assert_eq!(ink(None, "#a06b39"), Some(0xa06b39));
        assert_eq!(ink(None, "#111111"), None);
        assert_eq!(ink(Some("neutral"), "#1e86fc"), None);
    }
}
