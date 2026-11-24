//! The bot mark, the same drawing the web app makes (`packages/core/src/avatars/bot-mark.ts`):
//! a 3D body seen orthographically, drawn as one flat silhouette with two eye holes under the
//! even-odd rule. The default body is a sphere whose eyes are wrapped onto its surface; shaped
//! bodies are lofted solids (turned profiles or rounded slabs) whose outline changes as they
//! turn. Nothing is shaded or layered. Outlines are in resting-body radii, y down.

use std::collections::HashMap;
use std::f32::consts::{PI, TAU};
use std::sync::{Mutex, OnceLock};

use crate::mark_bodies::{spec, Kind, Mount, Spec};

pub type Point = (f32, f32);
type Vec3 = [f32; 3];
type Mat3 = [f32; 9];

/// The resting body takes this share of the avatar slot, as in the web app.
pub const BODY_FILL: f32 = 0.92;
/// The resting pose: turned up and to the right (pitch, yaw, roll in degrees).
pub const REST_ROTATION: [f32; 3] = [-15.9, 33.3, 25.4];
const REST_ZOOM: f32 = 0.6;

macro_rules! shapes {
    ($($name:ident => $key:literal),* $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Shape { Circle, $($name),* }
        impl Shape {
            /// Every body a person can pick; `Circle` is the older name of the sphere (`Blob`).
            pub const ALL: &'static [Shape] = &[$(Shape::$name),*];
            pub fn key(self) -> &'static str { match self { Shape::Circle => "blob", $(Shape::$name => $key),* } }
            pub fn named(name: &str) -> Option<Shape> {
                match name { "circle" | "sphere" => Some(Shape::Blob), $($key => Some(Shape::$name),)* _ => None }
            }
        }
    };
}

shapes! {
    Blob => "blob", Pebble => "pebble", Bean => "bean", Egg => "egg", Squircle => "squircle",
    Tablet => "tablet", Capsule => "capsule", Cylinder => "cylinder", Hex => "hex", Gem => "gem",
    Crystal => "crystal", Wedge => "wedge", Shield => "shield", Dome => "dome", Arch => "arch",
    Cloud => "cloud", Teardrop => "teardrop", Leaf => "leaf", Square => "square",
    Sparkle => "sparkle", Clover => "clover", Flower => "flower", Heart => "heart",
    House => "house", Star => "star", Pumpkin => "pumpkin",
}

/// The bodies a bot gets when nobody picked one.
const DEFAULT_SHAPES: [Shape; 8] = [
    Shape::Blob,
    Shape::Pebble,
    Shape::Squircle,
    Shape::Tablet,
    Shape::Wedge,
    Shape::Hex,
    Shape::Cloud,
    Shape::Teardrop,
];

/// The same 32-bit FNV-1a hash the web app uses, so a bot gets the same body everywhere.
pub fn seed(identity: &str) -> u32 {
    let mut hash: u32 = 2166136261;
    for unit in identity.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(16777619);
    }
    hash
}

fn mix_seed(identity: &str) -> u32 {
    let mut hash = seed(identity);
    hash = (hash ^ (hash >> 16)).wrapping_mul(73244475);
    hash = (hash ^ (hash >> 13)).wrapping_mul(3266489909);
    hash ^ (hash >> 16)
}

impl Shape {
    /// The picked body when it is one of ours, else one of the everyday bodies by identity.
    pub fn for_bot(identity: &str, picked: Option<&str>) -> Shape {
        picked
            .and_then(Shape::named)
            .unwrap_or_else(|| DEFAULT_SHAPES[(mix_seed(identity) as usize) % DEFAULT_SHAPES.len()])
    }
}

// ── Rotations ───────────────────────────────────────────────────────────────────────────────

/// Rz · Ry · Rx for pitch, yaw and roll in degrees.
fn rotation_matrix([pitch, yaw, roll]: [f32; 3]) -> Mat3 {
    let (sx, cx) = pitch.to_radians().sin_cos();
    let (sy, cy) = yaw.to_radians().sin_cos();
    let (sz, cz) = roll.to_radians().sin_cos();
    [
        cz * cy,
        cz * sy * sx - sz * cx,
        cz * sy * cx + sz * sx,
        sz * cy,
        sz * sy * sx + cz * cx,
        sz * sy * cx - cz * sx,
        -sy,
        cy * sx,
        cy * cx,
    ]
}

fn rotate(m: &Mat3, [x, y, z]: Vec3) -> Vec3 {
    [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z]
}

/// Shaped bodies take the rotation apart into pitch, yaw and roll and rebuild it yaw first
/// (Rz · Rx · Ry); a body turned past halfway is drawn from its front again, mirrored.
fn body_matrix(rotation: [f32; 3]) -> Mat3 {
    let mut m = rotation_matrix(rotation);
    if m[8] < 0. {
        m = [-m[0], m[1], -m[2], -m[3], m[4], -m[5], -m[6], m[7], -m[8]];
    }
    let s = (-m[6]).clamp(-1., 1.);
    let yaw = s.asin();
    let (pitch, roll) = if s.abs() > 0.999999 {
        (f32::atan2(-m[5], m[4]), 0.)
    } else {
        (f32::atan2(m[7], m[8]), f32::atan2(m[3], m[0]))
    };
    let (sx, cx) = pitch.sin_cos();
    let (sy, cy) = yaw.sin_cos();
    let (sz, cz) = roll.sin_cos();
    [
        cz * cy - sz * sx * sy,
        -sz * cx,
        cz * sy + sz * sx * cy,
        sz * cy + cz * sx * sy,
        cz * cx,
        sz * sy - cz * sx * cy,
        -cx * sy,
        sx,
        cx * cy,
    ]
}

// ── Faces ───────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Face {
    Neutral,
    Happy,
    Surprised,
    Sad,
    Sleepy,
    Squinted,
    Calm,
    Inspecting,
    Confused,
}

struct EyeShape {
    spine: Vec<Point>,
    half: f32,
    oval: Option<(f32, f32)>,
    off: Point,
}

fn pill(width: f32, height: f32, angle: f32, off_x: f32) -> EyeShape {
    let reach = ((height - width) / 2.).max(0.);
    let (s, c) = angle.to_radians().sin_cos();
    EyeShape {
        spine: vec![(-s * reach, -c * reach), (s * reach, c * reach)],
        half: width / 2.,
        oval: None,
        off: (off_x, 0.),
    }
}

fn curve(off: Point, half: f32, p0: Point, p1: Point, p2: Point, arc: bool) -> EyeShape {
    let steps = 20;
    let mut spine = Vec::with_capacity(steps + 1);
    if arc {
        let ((ax, ay), (bx, by), (cx, cy)) = (p0, p1, p2);
        let d = 2. * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        let ux =
            ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
        let uy =
            ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
        let r = (ax - ux).hypot(ay - uy);
        let start = (ay - uy).atan2(ax - ux);
        let end = (cy - uy).atan2(cx - ux);
        let mid = (by - uy).atan2(bx - ux);
        let sweep_end = (end - start).rem_euclid(TAU);
        let sweep_mid = (mid - start).rem_euclid(TAU);
        let sweep = if sweep_mid <= sweep_end { sweep_end } else { sweep_end - TAU };
        for index in 0..=steps {
            let a = start + sweep * index as f32 / steps as f32;
            spine.push((ux + a.cos() * r, uy + a.sin() * r));
        }
    } else {
        for index in 0..=steps {
            let t = index as f32 / steps as f32;
            let u = 1. - t;
            spine.push((
                u * u * p0.0 + 2. * u * t * p1.0 + t * t * p2.0,
                u * u * p0.1 + 2. * u * t * p1.1 + t * t * p2.1,
            ));
        }
    }
    EyeShape { spine, half, oval: None, off }
}

fn face_eyes(face: Face) -> [EyeShape; 2] {
    const REST_WIDTH: f32 = 0.26;
    const ROUND: f32 = 0.1305;
    let both = |make: &dyn Fn() -> EyeShape| [make(), make()];
    match face {
        Face::Neutral => both(&|| pill(REST_WIDTH, 0.57, 0., 0.)),
        Face::Happy => both(&|| curve((0.03, 0.03), ROUND, (0.16, -0.04), (0., 0.12), (-0.16, -0.04), true)),
        Face::Surprised => both(&|| pill(0.42, 0.86, 0., 0.03)),
        Face::Inspecting => [pill(0.54, 0.54, 0., 0.04), pill(0.36, 0.36, 0., 0.04)],
        Face::Sad => both(&|| pill(REST_WIDTH, 0.5, -28., -0.05)),
        Face::Sleepy => both(&|| curve((0.01, 0.), REST_WIDTH / 2., (-0.11, 0.025), (0., -0.05), (0.11, 0.025), false)),
        Face::Squinted => both(&|| pill(REST_WIDTH, 0.5, 90., 0.01)),
        Face::Calm => {
            both(&|| EyeShape { spine: vec![(0., 0.)], half: 0., oval: Some((0.296, 0.247)), off: (0.05, 0.) })
        }
        Face::Confused => both(&|| curve((-0.1, 0.), ROUND, (0.01, 0.16), (-0.17, 0.), (0.01, -0.16), false)),
    }
}

const OUTLINE: usize = 48;

fn stroke_outline(spine: &[Point], half: f32) -> Vec<Point> {
    if spine.len() < 2 || spine.iter().all(|p| *p == spine[0]) {
        let (cx, cy) = spine.first().copied().unwrap_or((0., 0.));
        return (0..OUTLINE)
            .map(|i| {
                let a = i as f32 / OUTLINE as f32 * TAU;
                (cx + a.cos() * half, cy + a.sin() * half)
            })
            .collect();
    }
    let normals: Vec<Point> = (0..spine.len())
        .map(|i| {
            let (ax, ay) = spine[i.saturating_sub(1)];
            let (bx, by) = spine[(i + 1).min(spine.len() - 1)];
            let length = (bx - ax).hypot(by - ay).max(1e-9);
            (-(by - ay) / length, (bx - ax) / length)
        })
        .collect();
    let mut out = Vec::new();
    let cap = |out: &mut Vec<Point>, (cx, cy): Point, (nx, ny): Point| {
        let start = ny.atan2(nx);
        for step in 1..12 {
            let a = start - step as f32 / 12. * PI;
            out.push((cx + a.cos() * half, cy + a.sin() * half));
        }
    };
    for (i, (x, y)) in spine.iter().enumerate() {
        out.push((x + normals[i].0 * half, y + normals[i].1 * half));
    }
    cap(&mut out, spine[spine.len() - 1], normals[normals.len() - 1]);
    for i in (0..spine.len()).rev() {
        out.push((spine[i].0 - normals[i].0 * half, spine[i].1 - normals[i].1 * half));
    }
    cap(&mut out, spine[0], (-normals[0].0, -normals[0].1));
    out
}

/// Evenly spaced points around a closed outline, from its highest point near the middle,
/// counter-clockwise, so two outlines line up when blended.
fn resample_closed(points: &[Point], count: usize) -> Vec<Point> {
    let cx = points.iter().map(|p| p.0).sum::<f32>() / points.len() as f32;
    let mut lengths = vec![0.];
    for i in 1..=points.len() {
        let (a, b) = (points[i - 1], points[i % points.len()]);
        lengths.push(lengths[i - 1] + (b.0 - a.0).hypot(b.1 - a.1));
    }
    let total = lengths[points.len()].max(1e-9);
    let start = (0..points.len())
        .max_by(|&a, &b| {
            let score = |i: usize| points[i].1 - (points[i].0 - cx).abs() * 0.25;
            score(a).total_cmp(&score(b))
        })
        .unwrap_or(0);
    let mut out = Vec::with_capacity(count);
    let (mut segment, mut travelled) = (start, 0.);
    for i in 0..count {
        let at = i as f32 / count as f32 * total;
        loop {
            let from = segment % points.len();
            let span = lengths[from + 1] - lengths[from];
            if travelled + span >= at || span == 0. {
                let t = if span == 0. { 0. } else { (at - travelled) / span };
                let (a, b) = (points[from], points[(from + 1) % points.len()]);
                out.push((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t));
                break;
            }
            travelled += span;
            segment += 1;
        }
    }
    let area: f32 = (0..out.len())
        .map(|i| {
            let (a, b) = (out[i], out[(i + 1) % out.len()]);
            a.0 * b.1 - b.0 * a.1
        })
        .sum();
    if area < 0. {
        out[1..].reverse();
    }
    out
}

fn eye_outline(eye: &EyeShape) -> Vec<Point> {
    let raw = match eye.oval {
        Some((rx, ry)) => (0..OUTLINE)
            .map(|i| {
                let a = i as f32 / OUTLINE as f32 * TAU;
                (a.cos() * rx, a.sin() * ry)
            })
            .collect(),
        None => stroke_outline(&eye.spine, eye.half),
    };
    resample_closed(&raw, OUTLINE).into_iter().map(|(x, y)| (x + eye.off.0, y + eye.off.1)).collect()
}

/// A face's two eye outlines in eye space (x away from the face's middle, y up). Cached.
pub fn face_outlines(face: Face) -> [Vec<Point>; 2] {
    static CACHE: OnceLock<Mutex<HashMap<Face, [Vec<Point>; 2]>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let mut cache = cache.lock().unwrap_or_else(|poison| poison.into_inner());
    cache
        .entry(face)
        .or_insert_with(|| {
            let [left, right] = face_eyes(face);
            [eye_outline(&left), eye_outline(&right)]
        })
        .clone()
}

/// Flattens an eye toward a horizontal pill as wide as it is and 0.42 of that width tall.
fn blink_eye(outline: &[Point], amount: f32) -> Vec<Point> {
    if amount <= 0. {
        return outline.to_vec();
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for &(x, y) in outline {
        (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
    }
    let w = (x1 - x0).max(1e-4);
    let h = (y1 - y0).max(w);
    let tall = h + (w * 0.42 - h) * amount.min(1.);
    let mut eye = if tall >= w { pill(w, tall, 0., 0.) } else { pill(tall, w, 90., 0.) };
    eye.off = ((x0 + x1) / 2., (y0 + y1) / 2.);
    eye_outline(&eye)
}

// ── Frames ──────────────────────────────────────────────────────────────────────────────────

/// One drawn moment: how the body turns, moves and squashes, and the face it makes.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    /// Pitch, yaw and roll in degrees from facing straight ahead.
    pub rotation: [f32; 3],
    /// Offset in body radii, y up.
    pub offset: Point,
    pub squash: Point,
    pub zoom: f32,
    pub face: Face,
    /// How far a blink has the eyes flattened (0 open, 1 flat).
    pub lids: f32,
    /// Eye size multipliers across and up, around each eye's middle.
    pub eye_scale: Point,
}

impl Default for Frame {
    /// The resting pose: turned up and aside, eyes open, nothing moving.
    fn default() -> Self {
        Frame {
            rotation: REST_ROTATION,
            offset: (0., 0.),
            squash: (1., 1.),
            zoom: REST_ZOOM,
            face: Face::Neutral,
            lids: 0.,
            eye_scale: (1., 1.),
        }
    }
}

impl Frame {
    /// The resting pose turned toward a gaze (x right, y up, each ±1) held by `hold` (0 to 1).
    pub fn facing(shape: Shape, gaze: Point, hold: f32) -> Frame {
        let (pitch, yaw, dx, dy) = match spec(shape) {
            None => (14., 18., 0.03, 0.024),
            Some(spec) => (19. * spec.gaze_scale, 26. * spec.gaze_scale, 0.07, 0.055),
        };
        let target = [-pitch * gaze.1, yaw * gaze.0, 0.];
        let h = hold.clamp(0., 1.);
        let mut frame = Frame::default();
        for k in 0..3 {
            frame.rotation[k] += (target[k] - frame.rotation[k]) * h;
        }
        frame.offset = (dx * gaze.0 * h, dy * gaze.1 * h);
        frame
    }
}

// ── Bodies ──────────────────────────────────────────────────────────────────────────────────

const RING_POINTS: usize = 48;
const RAYS: usize = 120;
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn decode_outline(packed: &str) -> Vec<Point> {
    let bytes = packed.as_bytes();
    let count = bytes.len() / 2;
    let digit = |b: u8| ALPHABET.iter().position(|c| *c == b).unwrap_or(0) as f32;
    (0..count)
        .map(|i| {
            let radius = (digit(bytes[i * 2]) * 64. + digit(bytes[i * 2 + 1])) / 2000.;
            let angle = i as f32 / count as f32 * TAU;
            (angle.cos() * radius, angle.sin() * radius)
        })
        .collect()
}

fn span(outline: &[Point], y: f32) -> Option<Point> {
    let (mut low, mut high) = (f32::MAX, f32::MIN);
    for i in 0..outline.len() {
        let ((ax, ay), (bx, by)) = (outline[i], outline[(i + 1) % outline.len()]);
        if (ay <= y) == (by <= y) {
            continue;
        }
        let x = ax + (bx - ax) * (y - ay) / (by - ay);
        low = low.min(x);
        high = high.max(x);
    }
    (low <= high).then_some((low, high))
}

fn evenly(outline: &[Point], count: usize) -> Vec<Point> {
    let mut lengths = vec![0.];
    for i in 1..=outline.len() {
        let (a, b) = (outline[i - 1], outline[i % outline.len()]);
        lengths.push(lengths[i - 1] + (b.0 - a.0).hypot(b.1 - a.1));
    }
    let total = lengths[outline.len()];
    let top = (0..outline.len()).max_by(|&a, &b| outline[a].1.total_cmp(&outline[b].1)).unwrap_or(0);
    let mut segment = top;
    (0..count)
        .map(|i| {
            let at = (lengths[top] + i as f32 / count as f32 * total) % total;
            while !(lengths[segment] <= at && at <= lengths[segment + 1]) {
                segment = (segment + 1) % outline.len();
            }
            let (a, b) = (outline[segment], outline[(segment + 1) % outline.len()]);
            let t = (at - lengths[segment]) / (lengths[segment + 1] - lengths[segment]).max(1e-9);
            (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
        })
        .collect()
}

fn rings(spec: &Spec) -> Vec<Vec<Vec3>> {
    let outline = decode_outline(spec.outline);
    match spec.kind {
        Kind::Lathe { sideways, squeeze } => {
            let profile: Vec<Point> = if sideways { outline.iter().map(|&(x, y)| (y, x)).collect() } else { outline };
            let low = profile.iter().map(|p| p.1).fold(f32::MAX, f32::min);
            let high = profile.iter().map(|p| p.1).fold(f32::MIN, f32::max);
            let steps = 18;
            (0..=steps)
                .map(|step| {
                    let y = low + (high - low) * (0.5 - 0.5 * (PI * step as f32 / steps as f32).cos());
                    let (left, right) = span(&profile, y.clamp(low + 1e-6, high - 1e-6)).unwrap_or((0., 0.));
                    let (middle, radius) = ((left + right) / 2., (right - left) / 2.);
                    (0..RING_POINTS)
                        .map(|i| {
                            let a = i as f32 / RING_POINTS as f32 * TAU;
                            let across = middle + a.cos() * radius;
                            let depth = a.sin() * radius * squeeze;
                            if sideways {
                                [y, across, depth]
                            } else {
                                [across, y, depth]
                            }
                        })
                        .collect()
                })
                .collect()
        }
        Kind::Slab { depth, bevel } => {
            let base = evenly(&outline, RING_POINTS);
            let steps = 10;
            (0..=steps)
                .map(|step| {
                    let z = -depth / 2. + depth * (0.5 - 0.5 * (PI * step as f32 / steps as f32).cos());
                    let over = z.abs() - (depth / 2. - bevel);
                    let inset = if over > 0. && bevel > 0. {
                        bevel * (1. - (1. - (over / bevel).powi(2)).max(0.).sqrt())
                    } else {
                        0.
                    };
                    base.iter()
                        .map(|&(x, y)| {
                            let factor = (1. - inset / x.hypot(y).max(1e-9)).max(0.);
                            [x * factor, y * factor, z]
                        })
                        .collect()
                })
                .collect()
        }
    }
}

/// The body's outline seen through `turn`, in body radii (y up): the far edge of everything
/// between neighbouring rings, found along evenly spaced rays from the centre.
fn silhouette(shape: Shape, spec: &Spec, turn: &Mat3) -> Vec<Point> {
    static RINGS: OnceLock<Mutex<HashMap<Shape, Vec<Vec<Vec3>>>>> = OnceLock::new();
    let cache = RINGS.get_or_init(Default::default);
    let projected: Vec<Vec<Point>> = {
        let mut cache = cache.lock().unwrap_or_else(|poison| poison.into_inner());
        cache
            .entry(shape)
            .or_insert_with(|| rings(spec))
            .iter()
            .map(|ring| {
                ring.iter()
                    .map(|&p| {
                        let [x, y, _] = rotate(turn, p);
                        (x, y)
                    })
                    .collect()
            })
            .collect()
    };
    let mut edges = Vec::new();
    for (k, ring) in projected.iter().enumerate() {
        for i in 0..ring.len() {
            let a = ring[i];
            let b = ring[(i + 1) % ring.len()];
            edges.push((a, (b.0 - a.0, b.1 - a.1)));
            if let Some(next) = projected.get(k + 1) {
                edges.push((a, (next[i].0 - a.0, next[i].1 - a.1)));
            }
        }
    }
    (0..RAYS)
        .map(|ray| {
            let (dy, dx) = (ray as f32 / RAYS as f32 * TAU).sin_cos();
            let mut far = 0.;
            for &((ax, ay), (ex, ey)) in &edges {
                let den = dx * ey - dy * ex;
                if den.abs() < 1e-12 {
                    continue;
                }
                let t = (ax * ey - ay * ex) / den;
                if t <= far {
                    continue;
                }
                let u = (ax * dy - ay * dx) / den;
                if (0. ..=1.).contains(&u) {
                    far = t;
                }
            }
            (dx * far, dy * far)
        })
        .collect()
}

/// Eye outlines laid on a shaped body's seat, turned with it and dropped flat; an eye facing
/// away is left out and a wrapped eye is cut where the side turns away.
fn body_eyes(spec: &Spec, eyes: &[Vec<Point>; 2], turn: &Mat3) -> Vec<Vec<Point>> {
    let seat = &spec.seat;
    let mut out = Vec::new();
    for (index, outline) in eyes.iter().enumerate() {
        let side = if index == 0 { -1. } else { 1. };
        let placed: Vec<(Vec3, f32)> = outline
            .iter()
            .map(|&(x, y)| {
                let u = side * (seat.gap + x * seat.scale_x);
                let v = seat.y + y * seat.scale_y;
                match seat.mount {
                    Mount::Wrap(r) => {
                        let (s, c) = (u / r).sin_cos();
                        (rotate(turn, [r * s, v, r * c]), rotate(turn, [s, 0., c])[2])
                    }
                    Mount::Front(z) => (rotate(turn, [u, v, z]), turn[8]),
                }
            })
            .collect();
        let mut visible = Vec::new();
        for k in 0..placed.len() {
            let (a, fa) = placed[k];
            let (b, fb) = placed[(k + 1) % placed.len()];
            if fa >= 0. {
                visible.push((a[0], a[1]));
            }
            if (fa >= 0.) != (fb >= 0.) {
                let t = fa / (fa - fb);
                visible.push((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
            }
        }
        if visible.len() >= 3 {
            out.push(visible);
        }
    }
    out
}

/// Keeps eyes inside a ray-cast silhouette: a point past the edge moves in along its ray, as the
/// reference's mask trims an eye reaching over the body's side.
fn keep_inside(eyes: Vec<Vec<Point>>, silhouette: &[Point]) -> Vec<Vec<Point>> {
    let count = silhouette.len();
    let reach: Vec<f32> = silhouette.iter().map(|(x, y)| x.hypot(*y)).collect();
    eyes.into_iter()
        .map(|eye| {
            eye.into_iter()
                .map(|(x, y)| {
                    let at = (y.atan2(x) / TAU).rem_euclid(1.) * count as f32;
                    let (index, t) = (at.floor() as usize, at.fract());
                    let edge = (reach[index % count] * (1. - t) + reach[(index + 1) % count] * t) * 0.985;
                    let distance = x.hypot(y);
                    if distance > edge {
                        (x / distance * edge, y / distance * edge)
                    } else {
                        (x, y)
                    }
                })
                .collect()
        })
        .collect()
}

/// The sphere's eyes: centres 18.4° either side of the front, wrapped onto the surface keeping
/// distances along it, turned, and clipped to the visible half along the rim.
fn sphere_eyes(eyes: &[Vec<Point>; 2], turn: &Mat3) -> Vec<Vec<Point>> {
    let s = 0.31535_f32;
    let c = (1. - s * s).sqrt();
    let frames = [([-s, 0., c], [-c, 0., -s]), ([s, 0., c], [c, 0., -s])];
    let mut out = Vec::new();
    for (outline, (m, across)) in eyes.iter().zip(frames) {
        let (m, across, up) = (rotate(turn, m), rotate(turn, across), rotate(turn, [0., 1., 0.]));
        let surface: Vec<Vec3> = outline
            .iter()
            .map(|&(x, y)| {
                let d = x.hypot(y);
                let k = if d > 1e-9 { d.sin() / d } else { 1. };
                let cos = d.cos();
                [0, 1, 2].map(|i| cos * m[i] + k * (x * across[i] + y * up[i]))
            })
            .collect();
        if let Some(eye) = clip_to_front(&surface) {
            out.push(eye);
        }
    }
    out
}

fn clip_to_front(points: &[Vec3]) -> Option<Vec<Point>> {
    let first = points.iter().position(|p| p[2] >= 0.)?;
    if points.iter().all(|p| p[2] >= 0.) {
        return Some(points.iter().map(|p| (p[0], p[1])).collect());
    }
    let n = points.len();
    let mut out = Vec::new();
    let mut exit: Option<f32> = None;
    for step in 0..n {
        let a = points[(first + step) % n];
        let b = points[(first + step + 1) % n];
        let (a_in, b_in) = (a[2] >= 0., b[2] >= 0.);
        if a_in {
            out.push((a[0], a[1]));
        }
        if a_in != b_in {
            let t = a[2] / (a[2] - b[2]);
            let (x, y) = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
            let angle = y.atan2(x);
            if a_in {
                out.push((x, y));
                exit = Some(angle);
            } else if let Some(from) = exit.take() {
                let sweep = (angle - from + PI).rem_euclid(TAU) - PI;
                let steps = ((sweep.abs() / (PI / 48.)).ceil() as usize).max(1);
                for k in 1..steps {
                    let at = from + sweep * k as f32 / steps as f32;
                    out.push((at.cos(), at.sin()));
                }
                out.push((x, y));
            }
        }
    }
    (out.len() >= 3).then_some(out)
}

/// The outlines to fill with the even-odd rule, in resting-body radii around the slot's centre
/// with y down: the body, then each visible eye.
pub fn outlines(shape: Shape, frame: &Frame) -> Vec<Vec<Point>> {
    let mut eyes = face_outlines(frame.face);
    if frame.lids > 0.
        && !matches!(frame.face, Face::Sad | Face::Happy | Face::Confused | Face::Squinted | Face::Sleepy | Face::Calm)
    {
        eyes = [blink_eye(&eyes[0], frame.lids), blink_eye(&eyes[1], frame.lids)];
    }
    if frame.eye_scale != (1., 1.) {
        for eye in &mut eyes {
            let cx = eye.iter().map(|p| p.0).sum::<f32>() / eye.len() as f32;
            let cy = eye.iter().map(|p| p.1).sum::<f32>() / eye.len() as f32;
            for p in eye.iter_mut() {
                *p = (cx + (p.0 - cx) * frame.eye_scale.0, cy + (p.1 - cy) * frame.eye_scale.1);
            }
        }
    }
    let scale = frame.zoom / REST_ZOOM;
    let (sx, sy) = (frame.squash.0.abs(), frame.squash.1.abs());
    let place = |(x, y): Point| ((x * sx + frame.offset.0) * scale, -(y * sy + frame.offset.1) * scale);
    let (body, holes) = match spec(shape) {
        None => {
            let turn = rotation_matrix(frame.rotation);
            let body = (0..96)
                .map(|i| {
                    let (s, c) = (i as f32 / 96. * TAU).sin_cos();
                    (c, s)
                })
                .collect();
            (body, sphere_eyes(&eyes, &turn))
        }
        Some(spec) => {
            let turn = body_matrix(frame.rotation);
            let body = silhouette(shape, &spec, &turn);
            let holes = keep_inside(body_eyes(&spec, &eyes, &turn), &body);
            (body, holes)
        }
    };
    std::iter::once(body).chain(holes).map(|outline| outline.into_iter().map(place).collect()).collect()
}

/// The ink nearest a stored bot colour, or the picked one, as an RGB value for the light theme.
/// `None` is neutral: black on light, white on dark.
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
    const GRAY: u32 = 0x959595;
    match picked {
        Some("neutral" | "black") => return None,
        Some("gray") => return Some(GRAY),
        Some("violet") => return Some(0x8f59f9),
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
        return if !(0.25..=0.85).contains(&max) { None } else { Some(GRAY) };
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

    fn centre(outline: &[Point]) -> Point {
        let n = outline.len() as f32;
        (outline.iter().map(|p| p.0).sum::<f32>() / n, outline.iter().map(|p| p.1).sum::<f32>() / n)
    }

    #[test]
    fn every_shape_rests_as_one_body_with_two_eye_holes_inside_it() {
        for shape in Shape::ALL {
            for frame in [Frame::default(), Frame::facing(*shape, (0.6, -0.4), 1.)] {
                let parts = outlines(*shape, &frame);
                assert_eq!(parts.len(), 3, "{shape:?}");
                for eye in &parts[1..] {
                    assert!(eye.iter().filter(|&&p| !inside(p, &parts[0])).count() <= 2, "{shape:?}");
                }
            }
        }
    }

    #[test]
    fn the_sphere_rests_turned_aside_and_faces_a_held_gaze_head_on() {
        let rest = outlines(Shape::Blob, &Frame::default());
        let radius = rest[0].iter().map(|(x, y)| x.hypot(*y)).fold(0., f32::max);
        assert!((radius - 1.).abs() < 1e-3);
        let (left, right) = (centre(&rest[1]), centre(&rest[2]));
        assert!(left.0 > 0. && right.1 < left.1, "eyes sit up and to the right at rest");
        let facing = outlines(Shape::Blob, &Frame::facing(Shape::Blob, (0., 0.), 1.));
        let (left, right) = (centre(&facing[1]), centre(&facing[2]));
        // The same spot the web app draws: 78.4 and 113.6 of a 192 box whose body radius is 57.6.
        assert!((left.0 + (96. - 78.4) / 57.6).abs() < 0.02, "{left:?}");
        assert!((right.0 - (113.6 - 96.) / 57.6).abs() < 0.02, "{right:?}");
    }

    #[test]
    fn shaped_bodies_turn_as_solids() {
        let width = |rotation| {
            let parts = outlines(Shape::Square, &Frame { rotation, ..Frame::default() });
            parts[0].iter().map(|p| p.0).fold(f32::MIN, f32::max)
                - parts[0].iter().map(|p| p.0).fold(f32::MAX, f32::min)
        };
        assert!(width([0., 90., 0.]) < width([0., 0., 0.]) * 0.5);
    }

    #[test]
    fn a_blink_flattens_the_eyes_and_sleeping_eyes_lie_flat() {
        let height = |eye: &Vec<Point>| {
            eye.iter().map(|p| p.1).fold(f32::MIN, f32::max) - eye.iter().map(|p| p.1).fold(f32::MAX, f32::min)
        };
        let open = outlines(Shape::Blob, &Frame::facing(Shape::Blob, (0., 0.), 1.));
        let shut = outlines(Shape::Blob, &Frame { lids: 1., ..Frame::facing(Shape::Blob, (0., 0.), 1.) });
        assert!(height(&shut[1]) < height(&open[1]) * 0.5);
        let asleep = outlines(Shape::Blob, &Frame { face: Face::Sleepy, ..Frame::facing(Shape::Blob, (0., 0.), 1.) });
        assert!(height(&asleep[1]) < height(&open[1]) * 0.6);
    }

    #[test]
    fn shapes_and_inks_match_the_web_app() {
        assert_eq!(seed("maya"), 0xc969_9ea5);
        assert_eq!(Shape::for_bot("bot-1", Some("cloud")), Shape::Cloud);
        assert_eq!(Shape::for_bot("bot-1", Some("circle")), Shape::Blob);
        assert_eq!(Shape::for_bot("bot-1", Some("nope")), Shape::for_bot("bot-1", None));
        assert!(DEFAULT_SHAPES.contains(&Shape::for_bot("maya", None)));
        assert_eq!(ink(Some("green"), "#000000"), Some(0x14c16f));
        assert_eq!(ink(None, "#1e86fc"), Some(0x1e86fc));
        assert_eq!(ink(None, "#a06b39"), Some(0xa06b39));
        assert_eq!(ink(None, "#111111"), None);
        assert_eq!(ink(Some("neutral"), "#1e86fc"), None);
        assert_eq!(ink(Some("gray"), "#1e86fc"), Some(0x959595));
    }
}
