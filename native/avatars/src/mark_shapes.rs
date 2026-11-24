//! The 3D bodies behind the bot mark, the same as the web app's
//! `packages/core/src/avatars/bot-mark-bodies.ts`: profiles turned on a lathe, outlines pushed back
//! with bevelled edges, pillows lofted from an outline, rows and clusters of balls, a rounded slab
//! and a rounded gem. A body is drawn as its flat silhouette; its eyes sit on its front face or
//! wrap round it, and an eye on a part that faces away is left out.
//!
//! Body units: x right, y up, z toward the viewer.

use std::collections::HashMap;
use std::f64::consts::{PI, TAU};
use std::sync::{Mutex, OnceLock};

use crate::mark::Shape;
use crate::mark_bodies::{spec, Kind, Spec};

pub(crate) type P2 = (f64, f64);
pub(crate) type V3 = [f64; 3];
pub(crate) type M3 = [f64; 9];

const DEG: f64 = 180. / PI;

/// A body's turn: yaw about y, then pitch about x, then roll about z, in degrees.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Turn {
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
}

/// Rz · Ry · Rx for pitch, yaw and roll in degrees, as frames carry them.
fn frame_matrix([pitch, yaw, roll]: [f64; 3]) -> M3 {
    let (sx, cx) = (pitch / DEG).sin_cos();
    let (sy, cy) = (yaw / DEG).sin_cos();
    let (sz, cz) = (roll / DEG).sin_cos();
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

/// The turn a body is drawn with: the frame's rotation taken apart into yaw, pitch and roll, a body
/// turned past halfway drawn from its front again (mirrored) unless `mirror` is off, and the angles
/// rounded to `step` degrees, never landing exactly edge-on.
pub(crate) fn body_turn(rotation: [f64; 3], step: f64, mirror: bool) -> Turn {
    let mut m = frame_matrix(rotation);
    if mirror && m[8] < 0. {
        m = [-m[0], m[1], -m[2], -m[3], m[4], -m[5], -m[6], m[7], -m[8]];
    }
    let s = (-m[6]).clamp(-1., 1.);
    let yaw = s.asin();
    let (pitch, roll) = if s.abs() > 0.999999 {
        (f64::atan2(-m[5], m[4]), 0.)
    } else {
        (f64::atan2(m[7], m[8]), f64::atan2(m[3], m[0]))
    };
    let round = |value: f64| if step > 0. { (value / step).round() * step } else { value };
    Turn { yaw: off_edge(round(yaw * DEG)), pitch: off_edge(round(pitch * DEG)), roll: round(roll * DEG) }
}

fn off_edge(angle: f64) -> f64 {
    let t = angle.rem_euclid(180.);
    if (t - 90.).abs() >= 0.5 {
        angle
    } else if t <= 90. {
        angle + 89.5 - t
    } else {
        angle + 90.5 - t
    }
}

/// Rz · Rx · Ry for a turn.
pub(crate) fn turn_matrix(turn: Turn) -> M3 {
    let (sy, cy) = (turn.yaw / DEG).sin_cos();
    let (sx, cx) = (turn.pitch / DEG).sin_cos();
    let (sz, cz) = (turn.roll / DEG).sin_cos();
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

/// The angle step a turn is rounded to for a body `zoom` of a 192-unit box.
pub(crate) fn turn_step(zoom: f64) -> f64 {
    let step = 0.6 / (192. * zoom / 2.).max(1.) * DEG;
    2_f64.powf(step.log2().floor())
}

pub(crate) fn rotate(m: &M3, [x, y, z]: V3) -> V3 {
    [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z]
}

fn flat(m: &M3, p: V3) -> P2 {
    let [x, y, _] = rotate(m, p);
    (x, y)
}

fn facing(m: &M3, [x, y, z]: V3) -> f64 {
    m[6] * x + m[7] * y + m[8] * z
}

// ── Packed numbers ─────────────────────────────────────────────────────────────────────────────

const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub(crate) fn unpack(packed: &str) -> Vec<f64> {
    let digit = |b: u8| ALPHABET.iter().position(|c| *c == b).unwrap_or(0) as f64;
    packed.as_bytes().chunks_exact(2).map(|pair| (digit(pair[0]) * 64. + digit(pair[1])) / 2000. - 1.024).collect()
}

fn points(packed: &str) -> Vec<P2> {
    unpack(packed).chunks_exact(2).map(|pair| (pair[0], pair[1])).collect()
}

fn profile(top: f64, bottom: f64, packed: &str) -> Vec<P2> {
    let radii = unpack(packed);
    let last = (radii.len() - 1).max(1) as f64;
    radii
        .iter()
        .enumerate()
        .map(|(i, r)| (top + (bottom - top) * (1. - (i as f64 / last * PI).cos()) / 2., r.max(0.)))
        .collect()
}

fn bounds(outline: &[P2]) -> (f64, f64, f64, f64) {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for &(x, y) in outline {
        (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
    }
    (x0, y0, x1, y1)
}

// ── Building ───────────────────────────────────────────────────────────────────────────────────

enum Built {
    Lathe(Vec<P2>),
    Hull(Vec<V3>),
    Edges { rings: Vec<Vec<V3>>, loft: bool },
    Balls(Vec<[f64; 4]>),
}

fn flower_outline() -> Vec<P2> {
    let mut discs = vec![(0., 0., 0.36)];
    for k in 0..6 {
        let a = -PI / 2. + k as f64 * TAU / 6.;
        discs.push((0.58 * a.cos(), 0.58 * a.sin(), 0.33));
    }
    (0..240)
        .map(|i| {
            let (dy, dx) = (i as f64 / 240. * TAU).sin_cos();
            let (mut low, mut high) = (0., 0.91);
            for _ in 0..22 {
                let mid = (low + high) / 2.;
                let (x, y) = (mid * dx, mid * dy);
                if discs.iter().any(|&(cx, cy, r)| (x - cx).powi(2) + (y - cy).powi(2) <= r * r) {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            (low * dx, low * dy)
        })
        .collect()
}

fn extrude(outline: &[P2], half_depth: f64, bevel: f64) -> Vec<Vec<V3>> {
    let (x0, y0, x1, y1) = bounds(outline);
    let (cx, cy) = ((x0 + x1) / 2., (y0 + y1) / 2.);
    let half = ((x1 - x0) / 2.).min((y1 - y0) / 2.).max(1e-4);
    let steps: Vec<(f64, f64)> = (0..5)
        .map(|k| {
            let a = k as f64 / 4. * PI / 2.;
            (half_depth - bevel + bevel * a.sin(), 1. - bevel / half * (1. - a.cos()))
        })
        .collect();
    let layers = steps.iter().rev().map(|&(z, s)| (-z, s)).chain(steps.iter().copied());
    layers.map(|(z, s)| outline.iter().map(|&(x, y)| [cx + (x - cx) * s, cy + (y - cy) * s, z]).collect()).collect()
}

fn loft(outline: &[P2], depth: f64) -> Vec<Vec<V3>> {
    let (x0, y0, x1, y1) = bounds(outline);
    let (cx, cy) = ((x0 + x1) / 2., (y0 + y1) / 2.);
    (0..17)
        .map(|k| {
            let a = -PI / 2. + PI * k as f64 / 16.;
            let s = a.cos().max(0.).powf(0.72);
            outline.iter().map(|&(x, y)| [cx + (x - cx) * s, cy + (y - cy) * s, depth * a.sin()]).collect()
        })
        .collect()
}

fn rounded_slab(outline: &[P2], half_depth: f64, edge: f64) -> Vec<V3> {
    let n = outline.len();
    let mut out = Vec::new();
    for (i, &(x, y)) in outline.iter().enumerate() {
        let (px, py) = outline[(i + n - 1) % n];
        let (nx, ny) = outline[(i + 1) % n];
        let (mut ux, mut uy) = (ny - py, -(nx - px));
        let length = ux.hypot(uy).max(1e-12);
        (ux, uy) = (ux / length, uy / length);
        if ux * x + uy * y < 0. {
            (ux, uy) = (-ux, -uy);
        }
        for k in 0..=4 {
            let a = k as f64 / 4. * PI / 2.;
            let inset = edge * (1. - a.cos());
            let z = half_depth - edge + edge * a.sin();
            out.push([x - ux * inset, y - uy * inset, z]);
            out.push([x - ux * inset, y - uy * inset, -z]);
        }
    }
    out
}

fn crystal() -> Vec<V3> {
    let mut corners = vec![[0., 1.04, 0.], [0., -1.04, 0.]];
    for side in [-1., 1.] {
        for k in 0..6 {
            let a = k as f64 / 6. * TAU;
            corners.push([0.52 * a.cos(), side * 0.51, 0.52 * a.sin()]);
        }
    }
    let mut out = Vec::new();
    for [x, y, z] in corners {
        for k in 0..=8 {
            let polar = k as f64 / 8. * PI;
            let ring = if k == 0 || k == 8 { 1 } else { 14 };
            for j in 0..ring {
                let a = j as f64 / ring as f64 * TAU;
                out.push([x + 0.12 * polar.sin() * a.sin(), y + 0.12 * polar.cos(), z + 0.12 * polar.sin() * a.cos()]);
            }
        }
    }
    out
}

fn build(spec: &Spec) -> Built {
    match spec.kind {
        Kind::Revolve { top, bottom, radii, .. } => Built::Lathe(profile(top, bottom, radii)),
        Kind::Extrusion { half_depth, bevel, convex, outline, .. } => {
            let outline = outline.map(points).unwrap_or_else(flower_outline);
            let rings = extrude(&outline, half_depth, bevel);
            if convex {
                Built::Hull(rings.concat())
            } else {
                Built::Edges { rings, loft: false }
            }
        }
        Kind::Loft { depth, outline } => Built::Edges { rings: loft(&points(outline), depth), loft: true },
        Kind::Slab { half_depth, edge, outline, .. } => Built::Hull(rounded_slab(&points(outline), half_depth, edge)),
        Kind::Crystal { .. } => Built::Hull(crystal()),
        Kind::Pill { lying, reach, radius, .. } => Built::Balls(
            (0..33)
                .map(|k| {
                    let at = -reach + 2. * reach * k as f64 / 32.;
                    if lying {
                        [at, 0., 0., radius]
                    } else {
                        [0., at, 0., radius]
                    }
                })
                .collect(),
        ),
        Kind::Balls { balls, .. } => {
            Built::Balls(unpack(balls).chunks_exact(3).map(|b| [b[0], b[1], 0., b[2]]).collect())
        }
    }
}

fn built(shape: Shape, spec: &Spec) -> std::sync::Arc<Built> {
    static CACHE: OnceLock<Mutex<HashMap<Shape, std::sync::Arc<Built>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let mut cache = cache.lock().unwrap_or_else(|poison| poison.into_inner());
    cache.entry(shape).or_insert_with(|| std::sync::Arc::new(build(spec))).clone()
}

// ── Silhouettes ────────────────────────────────────────────────────────────────────────────────

fn lathe_silhouette(levels: &[P2], m: &M3) -> Vec<P2> {
    let ((px, py), (qx, qy), (ux, uy)) = ((m[0], m[3]), (m[2], m[5]), (m[1], m[4]));
    let mut out: Vec<P2> = Vec::new();
    for k in 0..180 {
        let (dy, dx) = (k as f64 / 180. * TAU).sin_cos();
        let (dp, dq) = (px * dx + py * dy, qx * dx + qy * dy);
        let spread = dp.hypot(dq);
        let (cp, cq) = if spread > 1e-12 { (dp / spread, dq / spread) } else { (1., 0.) };
        let (mut best, mut point) = (f64::MIN, (0., 0.));
        for &(y, r) in levels {
            let reach = y * (ux * dx + uy * dy) + r * spread;
            if reach > best {
                best = reach;
                point = (y * ux + r * (cp * px + cq * qx), y * uy + r * (cp * py + cq * qy));
            }
        }
        if out.last().is_none_or(|last| (last.0 - point.0).hypot(last.1 - point.1) > 1e-9) {
            out.push(point);
        }
    }
    out
}

pub(crate) fn convex_hull(points: &[P2]) -> Vec<P2> {
    let mut sorted: Vec<P2> = points.iter().copied().filter(|p| p.0.is_finite() && p.1.is_finite()).collect();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    if sorted.len() < 3 {
        return sorted;
    }
    let cross = |o: P2, a: P2, b: P2| (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0);
    let chain = |ordered: &mut dyn Iterator<Item = P2>| {
        let mut out: Vec<P2> = Vec::new();
        for p in ordered {
            while out.len() >= 2 && cross(out[out.len() - 2], out[out.len() - 1], p) <= 0. {
                out.pop();
            }
            out.push(p);
        }
        out.pop();
        out
    };
    let mut hull = chain(&mut sorted.iter().copied());
    hull.extend(chain(&mut sorted.iter().rev().copied()));
    hull
}

fn far_edge(segments: &[(P2, P2)], rays: usize) -> Vec<P2> {
    let mut out = Vec::new();
    for ray in 0..rays {
        let (dy, dx) = (ray as f64 / rays as f64 * TAU).sin_cos();
        let mut far = 0.;
        for &((ax, ay), (ex, ey)) in segments {
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
        if far > 0. {
            out.push((dx * far, dy * far));
        }
    }
    out
}

fn edges_silhouette(rings: &[Vec<V3>], loft: bool, m: &M3) -> Vec<P2> {
    let projected: Vec<Vec<P2>> = rings.iter().map(|ring| ring.iter().map(|&p| flat(m, p)).collect()).collect();
    if loft {
        let centre = |ring: &[P2]| {
            let n = ring.len() as f64;
            (ring.iter().map(|p| p.0).sum::<f64>() / n, ring.iter().map(|p| p.1).sum::<f64>() / n)
        };
        let (a, b) = (centre(&projected[0]), centre(&projected[projected.len() - 1]));
        if (a.0 - b.0).hypot(a.1 - b.1) < 1e-6 {
            let area = |ring: &[P2]| {
                (0..ring.len())
                    .map(|i| {
                        let (p, q) = (ring[i], ring[(i + 1) % ring.len()]);
                        p.0 * q.1 - q.0 * p.1
                    })
                    .sum::<f64>()
                    .abs()
            };
            return projected.iter().max_by(|x, y| area(x).total_cmp(&area(y))).cloned().unwrap_or_default();
        }
    }
    let mut segments = Vec::new();
    for (k, ring) in projected.iter().enumerate() {
        for i in 0..ring.len() {
            let a = ring[i];
            let b = ring[(i + 1) % ring.len()];
            segments.push((a, (b.0 - a.0, b.1 - a.1)));
            if let Some(next) = projected.get(k + 1) {
                segments.push((a, (next[i].0 - a.0, next[i].1 - a.1)));
            }
        }
    }
    far_edge(&segments, 480)
}

fn balls_silhouette(balls: &[[f64; 4]], m: &M3) -> Vec<P2> {
    let discs: Vec<(f64, f64, f64)> = balls
        .iter()
        .map(|&[x, y, z, r]| {
            let (px, py) = flat(m, [x, y, z]);
            (px, py, r)
        })
        .collect();
    let n = discs.len() as f64;
    let (ox, oy) = (discs.iter().map(|d| d.0).sum::<f64>() / n, discs.iter().map(|d| d.1).sum::<f64>() / n);
    let mut out = Vec::new();
    for ray in 0..160 {
        let (dy, dx) = (ray as f64 / 160. * TAU).sin_cos();
        let mut far: f64 = 0.;
        for &(x, y, r) in &discs {
            let (rx, ry) = (x - ox, y - oy);
            let along = dx * rx + dy * ry;
            let q = along * along - (rx * rx + ry * ry) + r * r;
            if q > 0. {
                far = far.max(along + q.sqrt());
            }
        }
        if far > 0. {
            out.push((ox + dx * far, oy + dy * far));
        }
    }
    out
}

/// The body's outline seen through a turn, in body units around the body's middle (y up).
pub(crate) fn silhouette(shape: Shape, turn: Turn) -> Vec<P2> {
    let Some(spec) = spec(shape) else { return Vec::new() };
    let m = turn_matrix(turn);
    match &*built(shape, &spec) {
        Built::Lathe(levels) => lathe_silhouette(levels, &m),
        Built::Hull(points) => convex_hull(&points.iter().map(|&p| flat(&m, p)).collect::<Vec<_>>()),
        Built::Edges { rings, loft } => edges_silhouette(rings, *loft, &m),
        Built::Balls(balls) => balls_silhouette(balls, &m),
    }
}

// ── Eyes ───────────────────────────────────────────────────────────────────────────────────────

/// The eyes laid flat on a body's face: centres spread by the body's gap and height, shapes scaled
/// by its eye width, both moved down by its shift. `eyes` pairs each outline with its centre.
fn face_loops(spec: &Spec, eyes: &[(Vec<P2>, P2)]) -> Vec<Vec<P2>> {
    let [width, height, gap, shift] = spec.eyes;
    let (size, spread, lift, down) = (width / 0.26, gap / 0.64, height / 0.57, -shift.sin());
    eyes.iter()
        .enumerate()
        .map(|(index, (outline, (ox, oy)))| {
            let side = if index == 0 { -1. } else { 1. };
            let (cx, cy) = (side * (0.32 + ox) * spread, down + oy * lift);
            outline.iter().map(|&(x, y)| (cx + side * (x - ox) * size, cy + (y - oy) * size)).collect()
        })
        .collect()
}

fn radius_at(levels: &[P2], y: f64) -> f64 {
    let (top, bottom) = (levels[0].0, levels[levels.len() - 1].0);
    if y >= top {
        return levels[0].1.max(0.02);
    }
    if y <= bottom {
        return levels[levels.len() - 1].1.max(0.02);
    }
    let (mut low, mut high) = (0, levels.len() - 1);
    while high - low > 1 {
        let mid = (low + high) / 2;
        if levels[mid].0 >= y {
            low = mid;
        } else {
            high = mid;
        }
    }
    let ((ya, ra), (yb, rb)) = (levels[low], levels[high]);
    let span = if (yb - ya).abs() > 0. { yb - ya } else { 1. };
    (ra + (rb - ra) * (y - ya) / span).max(0.02)
}

fn fit_heights(loops: Vec<Vec<P2>>, centre: f64, low: f64, high: f64) -> Vec<Vec<P2>> {
    let (mut y0, mut y1) = (f64::MAX, f64::MIN);
    for &(_, y) in loops.iter().flatten() {
        (y0, y1) = (y0.min(y), y1.max(y));
    }
    let mut shift = 0.;
    if y1 - y0 <= high - low {
        if centre + y0 < low {
            shift = low - (centre + y0);
        } else if centre + y1 > high {
            shift = high - (centre + y1);
        }
    }
    loops.into_iter().map(|l| l.into_iter().map(|(x, y)| (x, y + shift)).collect()).collect()
}

fn wrap_eyes(
    loops: Vec<Vec<P2>>,
    m: &M3,
    [y0, y1, eye_y]: [f64; 3],
    radius: &dyn Fn(f64) -> f64,
    fixed: bool,
) -> Vec<Vec<P2>> {
    let margin = if fixed { 0.06 } else { 0.02 };
    let centre = eye_y.max(y0 + margin).min(y1 - margin);
    let clamp_y = |y: f64| y.max(y0).min(y1);
    fit_heights(loops, centre, y0, y1)
        .into_iter()
        .map(|l| {
            l.into_iter()
                .filter_map(|(x, y)| {
                    let at = clamp_y(centre + y);
                    let r = radius(at);
                    let a = (x / r.max(0.12)).clamp(-2.6, 2.6);
                    let slope =
                        if fixed { 0. } else { -(radius((at + 0.012).min(y1)) - radius((at - 0.012).max(y0))) / 0.024 };
                    (facing(m, [a.sin(), slope, a.cos()]) >= 0.05).then(|| flat(m, [r * a.sin(), at, r * a.cos()]))
                })
                .collect::<Vec<_>>()
        })
        .filter(|l| l.len() > 2)
        .collect()
}

fn ball_under(balls: &[[f64; 4]], x: f64, y: f64) -> [f64; 4] {
    let (mut chosen, mut front, mut gap, mut inside) = (balls[0], f64::MIN, f64::MAX, false);
    for &ball in balls {
        let d = (x - ball[0]).hypot(y - ball[1]);
        if d < ball[3] {
            let z = ball[2] + (ball[3] * ball[3] - d * d).sqrt();
            if !inside || z > front {
                (inside, front, chosen) = (true, z, ball);
            }
        } else if !inside && d - ball[3] < gap {
            (gap, chosen) = (d - ball[3], ball);
        }
    }
    chosen
}

fn puff_eyes(loops: Vec<Vec<P2>>, m: &M3, balls: &[[f64; 4]], [y0, y1, eye_y]: [f64; 3]) -> Vec<Vec<P2>> {
    let centre = eye_y.max(y0 + 0.02).min(y1 - 0.02);
    let clamp_y = |y: f64| y.max(y0).min(y1);
    let ahead = m[8];
    fit_heights(loops, centre, y0, y1)
        .into_iter()
        .map(|l| {
            if l.is_empty() {
                return Vec::new();
            }
            let n = l.len() as f64;
            let (sx, sy) = (l.iter().map(|p| p.0).sum::<f64>() / n, l.iter().map(|p| p.1).sum::<f64>() / n);
            let [bx, by, bz, br] = ball_under(balls, sx, clamp_y(centre + sy));
            l.into_iter()
                .filter_map(|(x, y)| {
                    let (ex, ey) = (x - bx, clamp_y(centre + y) - by);
                    let d = ex.hypot(ey);
                    let mut arc = (d / br).min(PI - 0.02);
                    let (ux, uy) = if d > 1e-9 { (ex / d, ey / d) } else { (1., 0.) };
                    let side = facing(m, [ux, uy, 0.]);
                    let lean = |a: f64| side * a.sin() + ahead * a.cos();
                    if lean(arc) < 0.06 && ahead > 0.06 {
                        let (mut low, mut high) = (0., arc);
                        for _ in 0..20 {
                            let mid = (low + high) / 2.;
                            if lean(mid) >= 0.06 {
                                low = mid;
                            } else {
                                high = mid;
                            }
                        }
                        arc = low;
                    }
                    let normal = [ux * arc.sin(), uy * arc.sin(), arc.cos()];
                    let reach = br * arc.sin();
                    (facing(m, normal) >= 0.05)
                        .then(|| flat(m, [bx + ux * reach, by + uy * reach, bz + br * arc.cos()]))
                })
                .collect::<Vec<_>>()
        })
        .filter(|l| l.len() > 2)
        .collect()
}

fn wrap_x_eyes(loops: Vec<Vec<P2>>, m: &M3, (x0, x1): P2, reach: f64, radius: f64) -> Vec<Vec<P2>> {
    let radius_at = |x: f64| {
        let t = x.abs() - reach;
        if t <= 0. {
            radius
        } else {
            (radius * radius - t * t).max(0.).sqrt()
        }
    };
    let (mut low, mut high) = (f64::MAX, f64::MIN);
    for &(x, _) in loops.iter().flatten() {
        (low, high) = (low.min(x), high.max(x));
    }
    let mut shift = 0.;
    if high - low <= x1 - x0 {
        if low < x0 {
            shift = x0 - low;
        } else if high > x1 {
            shift = x1 - high;
        }
    }
    loops
        .into_iter()
        .map(|l| {
            l.into_iter()
                .filter_map(|(px, py)| {
                    let x = (px + shift).max(x0).min(x1);
                    let r = radius_at(x);
                    let a = (py / radius.max(0.12)).clamp(-2.6, 2.6);
                    let slope = -(radius_at((x + 0.012).min(x1)) - radius_at((x - 0.012).max(x0))) / 0.024;
                    (facing(m, [slope, a.sin(), a.cos()]) >= 0.05).then(|| flat(m, [x, r * a.sin(), r * a.cos()]))
                })
                .collect::<Vec<_>>()
        })
        .filter(|l| l.len() > 2)
        .collect()
}

fn pillow_surface(outline: &[P2], depth: f64) -> impl Fn(f64, f64) -> f64 {
    let (x0, y0, x1, y1) = bounds(outline);
    let (cx, cy) = ((x0 + x1) / 2., (y0 + y1) / 2.);
    let reach: Vec<f64> = (0..180)
        .map(|k| {
            let (dy, dx) = ((k as f64 + 0.5) / 180. * TAU).sin_cos();
            let mut far = 0.;
            for i in 0..outline.len() {
                let (a, b) = (outline[i], outline[(i + 1) % outline.len()]);
                let (ex, ey) = (b.0 - a.0, b.1 - a.1);
                let den = dx * ey - dy * ex;
                if den.abs() < 1e-9 {
                    continue;
                }
                let (rx, ry) = (a.0 - cx, a.1 - cy);
                let t = (rx * ey - ry * ex) / den;
                let u = (rx * dy - ry * dx) / den;
                if t > far && (0. ..=1.).contains(&u) {
                    far = t;
                }
            }
            far
        })
        .collect();
    move |x, y| {
        let (rx, ry) = (x - cx, y - cy);
        let d = rx.hypot(ry);
        let mut share = 0.;
        if d >= 1e-8 {
            let at = ry.atan2(rx).rem_euclid(TAU) / TAU * 180.;
            let (index, t) = (at.floor() as usize % 180, at - at.floor());
            let edge = reach[index] * (1. - t) + reach[(index + 1) % 180] * t;
            share = (d / edge.max(1e-8)).min(1.);
        }
        depth * (1. - share.powf(2. / 0.72)).max(0.).sqrt()
    }
}

fn loft_eyes(loops: Vec<Vec<P2>>, m: &M3, surface: &dyn Fn(f64, f64) -> f64) -> Vec<Vec<P2>> {
    if m[8] < 0.05 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for l in loops {
        if l.len() < 3 {
            continue;
        }
        let n = l.len() as f64;
        let (sx, sy) = (l.iter().map(|p| p.0).sum::<f64>() / n, l.iter().map(|p| p.1).sum::<f64>() / n);
        let h = 4e-3;
        let gx = (surface(sx + h, sy) - surface(sx - h, sy)) / (2. * h);
        let gy = (surface(sx, sy + h) - surface(sx, sy - h)) / (2. * h);
        let length = gx.hypot(gy).hypot(1.);
        if facing(m, [-gx / length, -gy / length, 1. / length]) < 0.12 {
            continue;
        }
        let z = surface(sx, sy);
        out.push(l.iter().map(|&(x, y)| flat(m, [x, y, z + (x - sx) * gx + (y - sy) * gy])).collect());
    }
    out
}

/// A pair of eyes (outline and centre each, in eye space) seated on a body and seen through a turn,
/// in body units; eyes, or the parts of them, on a side that faces away are left out.
pub(crate) fn body_eyes(shape: Shape, eyes: &[(Vec<P2>, P2)], turn: Turn) -> Vec<Vec<P2>> {
    let Some(spec) = spec(shape) else { return Vec::new() };
    let m = turn_matrix(turn);
    let loops = face_loops(&spec, eyes);
    match spec.kind {
        Kind::Extrusion { face, .. } | Kind::Slab { face, .. } | Kind::Crystal { face } => {
            if m[8] <= 0.03 {
                return Vec::new();
            }
            loops
                .into_iter()
                .filter(|l| l.len() >= 3)
                .map(|l| l.into_iter().map(|(x, y)| flat(&m, [x, y, face])).collect())
                .collect()
        }
        Kind::Revolve { top, bottom, radii, wrap } => {
            let levels = profile(top, bottom, radii);
            wrap_eyes(loops, &m, wrap, &|y| radius_at(&levels, y), false)
        }
        Kind::Pill { lying, reach, radius, seat } => {
            if lying {
                wrap_x_eyes(loops, &m, (seat[0], seat[1]), reach, radius)
            } else {
                wrap_eyes(loops, &m, seat, &|_| radius, true)
            }
        }
        Kind::Balls { wrap, .. } => match &*built(shape, &spec) {
            Built::Balls(balls) => puff_eyes(loops, &m, balls, wrap),
            _ => Vec::new(),
        },
        Kind::Loft { depth, outline } => loft_eyes(loops, &m, &pillow_surface(&points(outline), depth)),
    }
}

/// How many body units make one resting-sphere radius, for a body drawn at `zoom`.
pub(crate) fn unit(shape: Shape, zoom: f64) -> f64 {
    let size = spec(shape).map_or(1.17, |spec| spec.size);
    let exact = (192. * zoom / (184. / 256.)).round().max(8.);
    size * 0.36 * exact / 1.18 / (96. * zoom)
}
