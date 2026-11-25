//! The pumpkin, the same as the web app's `packages/core/src/avatars/bot-mark-pumpkin.ts`: a
//! ribbed, squat body given by its radius in every direction, never mirrored as it turns, with its
//! eyes pressed onto its surface and a curved stem drawn in two greys over the body's ink.
//!
//! Everything here works in sprite pixels: a square `size` across, the body's middle at its centre
//! and y down, as the stem is traced from a pixel raster.

use std::collections::HashMap;
use std::f64::consts::{PI, TAU};
use std::sync::{Arc, Mutex, OnceLock};

use crate::mark_shapes::{convex_hull, rotate, turn_matrix, Turn, M3, P2, V3};

const SIZE: f64 = 1.17;
const WIDE: f64 = 1.08;
const TALL: f64 = WIDE * 0.84;
const GROOVE: f64 = 0.16;
const RAYS: usize = 256;

fn radius_toward(x: f64, y: f64, z: f64) -> f64 {
    let shell = 1. / ((x.hypot(z) / WIDE).powf(2.2) + (y.abs() / TALL).powf(2.2)).powf(1. / 2.2);
    let rib = (8. * (z.atan2(x) - PI / 2. - 19_f64.to_radians()) / 2.).cos().abs();
    let rib_fade = if y < 0. { (1. - y * y).max(0.).powf(0.2) } else { (1. - y * y).max(0.).sqrt() * (1. - 0.45 * y) };
    let ribs = 1. - GROOVE * (1. - rib.powf(0.6)) * rib_fade;
    let band = (3. * y.clamp(-1., 1.).asin()).cos().abs().powf(0.6);
    let band_fade = if y < 0. { 1. } else { (1. - 2.2 * y).max(0.) };
    let bands = 1. - GROOVE * 0.55 * 0.9 * (1. - band) * band_fade;
    let dimple = if y > 0. { 0.11 * (-(1. - y) / 0.02).exp() } else { 0.03 * (-(1. + y) / 0.03).exp() };
    shell * ribs * bands * (1. - dimple)
}

const LAT: usize = 160;
const LON: usize = 320;

struct Table {
    radii: Vec<f32>,
    least: f64,
    most: f64,
}

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut radii = vec![0_f32; (LAT + 1) * (LON + 1)];
        let (mut least, mut most) = (f64::MAX, 0_f64);
        for a in 0..=LAT {
            let lat = -PI / 2. + a as f64 / LAT as f64 * PI;
            for o in 0..=LON {
                let lon = -PI + o as f64 / LON as f64 * TAU;
                let r = radius_toward(lat.cos() * lon.cos(), lat.sin(), lat.cos() * lon.sin());
                radii[a * (LON + 1) + o] = r as f32;
                (least, most) = (least.min(r), most.max(r));
            }
        }
        Table { radii, least, most }
    })
}

fn reach_toward(x: f64, y: f64, z: f64) -> f64 {
    let values = &table().radii;
    let length = (x * x + y * y + z * z).sqrt();
    let lat = ((y / if length > 0. { length } else { 1. }).clamp(-1., 1.).asin() + PI / 2.) / PI * LAT as f64;
    let lon = (z.atan2(x) + PI) / TAU * LON as f64;
    let a = (lat.floor().max(0.) as usize).min(LAT - 1);
    let o = (lon.floor().max(0.) as usize).min(LON - 1);
    let (u, v) = (lat - a as f64, lon - o as f64);
    let at = a * (LON + 1) + o;
    let below = at + LON + 1;
    let value = |i: usize| f64::from(values[i]);
    (value(at) * (1. - v) + value(at + 1) * v) * (1. - u) + (value(below) * (1. - v) + value(below + 1) * v) * u
}

fn view(m: &M3, p: V3) -> V3 {
    rotate(m, p)
}

fn body(m: &M3, [x, y, z]: V3) -> V3 {
    [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z]
}

fn length([x, y, z]: V3) -> f64 {
    (x * x + y * y + z * z).sqrt()
}

pub(crate) fn unit(size: f64) -> f64 {
    SIZE * (0.36 * size / 1.18)
}

/// The pumpkin seen through a turn: its reach along 256 directions, its outline and its stem.
pub(crate) struct Look {
    pub reaches: Vec<f64>,
    pub outline: Vec<P2>,
    /// The whole stem, then its lighter cut end.
    pub stem: Vec<(StemTone, Vec<Vec<P2>>)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StemTone {
    Stem,
    Cap,
}

pub(crate) fn look(turn: Turn, size: f64) -> Arc<Look> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Look>>>> = OnceLock::new();
    let key = format!("{size} {} {} {}", turn.yaw, turn.pitch, turn.roll);
    let cache = CACHE.get_or_init(Default::default);
    if let Some(found) = cache.lock().unwrap_or_else(|poison| poison.into_inner()).get(&key) {
        return found.clone();
    }
    let m = turn_matrix(turn);
    let tilts = {
        let mut tilts: Vec<(f64, f64)> = (0..49)
            .map(|k| {
                let a = (k as f64 - 24.) / 24. * 1.25;
                (a.cos(), a.sin())
            })
            .collect();
        tilts.sort_by(|p, q| q.0.total_cmp(&p.0));
        tilts
    };
    let (centre, scale, most) = (size / 2., unit(size), table().most);
    let mut reaches = Vec::with_capacity(RAYS);
    let mut outline = Vec::with_capacity(RAYS);
    for k in 0..RAYS {
        let (dy, dx) = (TAU * k as f64 / RAYS as f64).sin_cos();
        let mut reach: f64 = 0.;
        for &(lean, depth) in &tilts {
            if lean * most < reach {
                break;
            }
            let [x, y, z] = body(&m, [dx * lean, dy * lean, depth]);
            reach = reach.max(reach_toward(x, y, z) * lean);
        }
        reaches.push(reach);
        outline.push((centre + scale * reach * dx, centre - scale * reach * dy));
    }
    let stem = trace_stem(&m, size, &reaches);
    let found = Arc::new(Look { reaches, outline, stem });
    let mut cache = cache.lock().unwrap_or_else(|poison| poison.into_inner());
    if cache.len() > 64 {
        cache.clear();
    }
    cache.insert(key, found.clone());
    found
}

// ── Eyes ───────────────────────────────────────────────────────────────────────────────────────

fn surface_at(m: &M3, direction: V3) -> V3 {
    let l = length(direction).max(1e-12);
    let d = direction.map(|v| v / l);
    let [x, y, z] = body(m, d);
    let r = reach_toward(x, y, z) * 1.002;
    d.map(|v| v * r)
}

fn seen(m: &M3, direction: V3) -> bool {
    if direction[2] / length(direction).max(1e-12) < -0.35 {
        return false;
    }
    let (least, most) = (table().least, table().most);
    let [x, y, z] = surface_at(m, direction);
    for k in 1..=48 {
        let p = [x, y, z + 0.01 + k as f64 / 48. * 2.2];
        let d = length(p);
        if d > 2.2 {
            break;
        }
        if d > most {
            if p[2] >= 0. {
                break;
            }
            continue;
        }
        if d < least {
            return false;
        }
        let [bx, by, bz] = body(m, p.map(|v| v / d));
        if d < reach_toward(bx, by, bz) {
            return false;
        }
    }
    true
}

fn wrap_point(x: f64, y: f64) -> V3 {
    let d = x.hypot(y);
    if d < 1e-8 {
        return [0., 0., 1.];
    }
    [x / d * d.sin(), y / d * d.sin(), d.cos()]
}

fn inside((px, py): P2, polygon: &[P2]) -> bool {
    let mut hit = false;
    let mut j = polygon.len().wrapping_sub(1);
    for i in 0..polygon.len() {
        let ((xi, yi), (xj, yj)) = (polygon[i], polygon[j]);
        if (yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi {
            hit = !hit;
        }
        j = i;
    }
    hit
}

fn area(points: &[P2]) -> f64 {
    (0..points.len())
        .map(|i| {
            let (a, b) = (points[i], points[(i + 1) % points.len()]);
            a.0 * b.1 - b.0 * a.1
        })
        .sum::<f64>()
        / 2.
}

/// The pumpkin's eyes (outline and centre each, in eye space) pressed onto its surface and trimmed
/// where it hides them, in sprite pixels.
pub(crate) fn eyes(turn: Turn, size: f64, look: &Look, eyes: &[(Vec<P2>, P2)]) -> Vec<Vec<P2>> {
    let m = turn_matrix(turn);
    let (centre, scale) = (size / 2., unit(size));
    let project = |p: V3| (centre + scale * p[0], centre - scale * p[1]);
    let (normal, up, right) = (view(&m, [0., 0., 1.]), view(&m, [0., 1., 0.]), view(&m, [1., 0., 0.]));
    let dot = |a: V3, b: V3| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let mut pieces = Vec::new();
    for (index, (outline, (ox, oy))) in eyes.iter().enumerate() {
        let side = if index == 0 { -1. } else { 1. };
        let (cx, cy) = (side * (0.32 + ox) + 0.04_f64.sin(), -(0.12_f64.sin()) + oy);
        let face: Vec<P2> = outline.iter().map(|&(x, y)| (cx + side * (x - ox), cy + (y - oy))).collect();
        let directions: Vec<V3> = face.iter().map(|&(x, y)| view(&m, wrap_point(x, y))).collect();
        let covers = |direction: V3| {
            let n = dot(direction, normal);
            if n <= 0.02 {
                return false;
            }
            let a = n.clamp(-1., 1.).acos();
            let s = a.sin();
            let point = if s < 1e-8 { (0., 0.) } else { (a * dot(direction, right) / s, a * dot(direction, up) / s) };
            inside(point, &face)
        };
        if let Some(piece) = press(&m, &directions, &covers, &look.reaches, &project, centre, scale) {
            pieces.push(piece);
        }
    }
    trim_to_rim(pieces, &look.reaches, centre, scale)
}

fn press(
    m: &M3,
    directions: &[V3],
    covers: &dyn Fn(V3) -> bool,
    reaches: &[f64],
    project: &dyn Fn(V3) -> P2,
    centre: f64,
    scale: f64,
) -> Option<Vec<P2>> {
    let visible: Vec<bool> = directions.iter().map(|&d| seen(m, d)).collect();
    if visible.iter().all(|v| !v) {
        return None;
    }
    if visible.iter().all(|v| *v) {
        return Some(directions.iter().map(|&d| project(surface_at(m, d))).collect());
    }
    let lerp = |a: V3, b: V3, t: f64| [0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t);
    let edge = |from: V3, to: V3| {
        let (mut low, mut high) = (0., 1.);
        for _ in 0..14 {
            let mid = (low + high) / 2.;
            if seen(m, lerp(from, to, mid)) {
                low = mid;
            } else {
                high = mid;
            }
        }
        surface_at(m, lerp(from, to, low))
    };
    let rim = |angle: f64| {
        let t = (angle / TAU * RAYS as f64).rem_euclid(RAYS as f64);
        let (k, f) = (t.floor() as usize % RAYS, t - t.floor());
        let reach = (reaches[k] * (1. - f) + reaches[(k + 1) % RAYS] * f) * scale;
        (centre + reach * angle.cos(), centre - reach * angle.sin())
    };
    let count = directions.len();
    let start = visible.iter().position(|v| !v).unwrap_or(0);
    let mut out: Vec<Vec<P2>> = Vec::new();
    let mut piece: Option<Vec<P2>> = None;
    let mut entered = 0.;
    for step in 0..count {
        let i = (start + step) % count;
        let j = (i + 1) % count;
        if !visible[i] && visible[j] {
            let p = edge(directions[j], directions[i]);
            entered = p[1].atan2(p[0]);
            piece = Some(vec![project(p)]);
        }
        if visible[i] {
            piece.get_or_insert_with(Vec::new).push(project(surface_at(m, directions[i])));
        }
        if visible[i] && !visible[j] {
            if let Some(mut current) = piece.take() {
                let p = edge(directions[i], directions[j]);
                current.push(project(p));
                let left = p[1].atan2(p[0]);
                let sweep = (entered - left + PI).rem_euclid(TAU) - PI;
                let sweep = if sweep <= -PI { sweep + TAU } else { sweep };
                let middle = left + sweep / 2.;
                if covers([middle.cos(), middle.sin(), 0.]) {
                    let steps = ((sweep.abs() / 0.03).ceil() as usize).max(2);
                    for k in 1..steps {
                        current.push(rim(left + sweep * k as f64 / steps as f64));
                    }
                }
                if current.len() > 2 {
                    out.push(current);
                }
            }
        }
    }
    out.into_iter().max_by(|a, b| area(a).abs().total_cmp(&area(b).abs()))
}

fn trim_to_rim(eyes: Vec<Vec<P2>>, reaches: &[f64], centre: f64, scale: f64) -> Vec<Vec<P2>> {
    if eyes.is_empty() {
        return eyes;
    }
    let ring: Vec<P2> = (0..RAYS)
        .map(|k| {
            let a = TAU * k as f64 / RAYS as f64;
            let r = (reaches[k] - 0.015).max(0.05) * scale;
            (centre + r * a.cos(), centre - r * a.sin())
        })
        .collect();
    let hull = convex_hull(&ring);
    let (a, b) = (hull[0], hull[1]);
    let turn = if (b.0 - a.0) * (centre - a.1) - (b.1 - a.1) * (centre - a.0) > 0. { 1. } else { -1. };
    let mut out = Vec::new();
    for eye in eyes {
        if eye.iter().all(|&p| inside(p, &hull)) {
            out.push(eye);
            continue;
        }
        let mut cut = eye;
        for k in 0..hull.len() {
            if cut.len() <= 2 {
                break;
            }
            let (p, q) = (hull[k], hull[(k + 1) % hull.len()]);
            let keep = |(x, y): P2| turn * ((q.0 - p.0) * (y - p.1) - (q.1 - p.1) * (x - p.0));
            let mut next = Vec::new();
            for i in 0..cut.len() {
                let (c, d) = (cut[i], cut[(i + 1) % cut.len()]);
                let (kc, kd) = (keep(c), keep(d));
                if kc >= 0. {
                    next.push(c);
                }
                if (kc >= 0.) != (kd >= 0.) {
                    let t = kc / (kc - kd);
                    next.push((c.0 + t * (d.0 - c.0), c.1 + t * (d.1 - c.1)));
                }
            }
            cut = next;
        }
        if cut.len() > 2 && area(&cut).abs() > 0.012 * scale * scale {
            out.push(cut);
        }
    }
    out
}

// ── Stem ───────────────────────────────────────────────────────────────────────────────────────

const SPINE: usize = 72;
const AROUND: usize = 48;

struct Mesh {
    points: Vec<V3>,
    /// Corner indices and paint: 1 for the side, 2 for the cut end.
    triangles: Vec<[usize; 4]>,
}

fn stem_mesh() -> &'static Mesh {
    static MESH: OnceLock<Mesh> = OnceLock::new();
    MESH.get_or_init(|| {
        let top = radius_toward(0., 1., 0.);
        let bend = |t: f64| (-65_f64).to_radians() * t.powf(2.2);
        let mut spine = Vec::new();
        let (mut x, mut y) = (0., top - 0.08);
        for k in 0..=SPINE {
            let t = k as f64 / SPINE as f64;
            spine.push((x, y, bend(t)));
            if k == SPINE {
                break;
            }
            for s in 0..8 {
                let a = bend(t + (s as f64 + 0.5) / 8. / SPINE as f64);
                x += a.sin() * (0.68 / SPINE as f64 / 8.);
                y += a.cos() * (0.68 / SPINE as f64 / 8.);
            }
        }
        let mut crown = top;
        for k in 1..=24 {
            let polar = k as f64 / 24. * 0.6;
            for j in 0..32 {
                let around = j as f64 * PI / 16.;
                let h =
                    radius_toward(polar.sin() * around.cos(), polar.cos(), polar.sin() * around.sin()) * polar.cos();
                crown = crown.max(h);
            }
        }
        let mut points = Vec::new();
        for (k, &(sx, sy, angle)) in spine.iter().enumerate() {
            let t = k as f64 / SPINE as f64;
            let flare = (1. - (sy - (crown + 0.01)) / 0.09).clamp(0., 1.);
            let r = 0.115 + 0.055 * (1. - t) * (1. - t) + 0.06 * flare * flare;
            let (nx, ny) = (angle.cos(), -angle.sin());
            for j in 0..AROUND {
                let a = TAU * j as f64 / AROUND as f64;
                points.push([sx + r * a.cos() * nx, sy + r * a.cos() * ny, r * a.sin()]);
            }
        }
        let tip = points.len();
        let (lx, ly, _) = spine[SPINE];
        points.push([lx, ly, 0.]);
        let mut triangles = Vec::new();
        for k in 0..SPINE {
            for j in 0..AROUND {
                let n = (j + 1) % AROUND;
                let (a, b) = (k * AROUND, (k + 1) * AROUND);
                triangles.push([a + j, a + n, b + n, 1]);
                triangles.push([a + j, b + n, b + j, 1]);
            }
        }
        let last = SPINE * AROUND;
        for j in 0..AROUND {
            triangles.push([tip, last + j, last + (j + 1) % AROUND, 2]);
        }
        Mesh { points, triangles }
    })
}

fn hidden_behind<'a>(m: &'a M3, reaches: &'a [f64]) -> impl Fn(f64, f64, f64) -> bool + 'a {
    let (least, most) = (table().least, table().most);
    let ahead = body(m, [0., 0., 1.]);
    move |x, y, z| {
        let across = x * x + y * y;
        if across >= WIDE * WIDE {
            return false;
        }
        let k = ((y.atan2(x) / TAU * RAYS as f64).floor() as i64).rem_euclid(RAYS as i64) as usize;
        let edge = reaches[k].max(reaches[(k + 1) % RAYS]) * 1.01;
        if across > edge * edge {
            return false;
        }
        let base = body(m, [x, y, 0.]);
        let mut depth = z + 0.012;
        while depth <= WIDE {
            let d = (across + depth * depth).sqrt();
            if d < least {
                return true;
            }
            if d > most {
                if depth >= 0. {
                    return false;
                }
                depth += 0.02;
                continue;
            }
            let p = [0, 1, 2].map(|i| base[i] + depth * ahead[i]);
            if d <= reach_toward(p[0], p[1], p[2]) {
                return true;
            }
            depth += 0.02;
        }
        false
    }
}

struct Raster {
    left: i64,
    top: i64,
    width: usize,
    height: usize,
    paint: Vec<u8>,
}

fn raster_stem(m: &M3, size: f64, reaches: &[f64]) -> Option<Raster> {
    let mesh = stem_mesh();
    let (centre, scale) = (size / 2., unit(size));
    let in_view: Vec<V3> = mesh.points.iter().map(|&p| view(m, p)).collect();
    struct Screen {
        x: f64,
        y: f64,
        top: i64,
        bottom: i64,
        left: i64,
        right: i64,
    }
    let screen: Vec<Screen> = in_view
        .iter()
        .map(|p| {
            let (x, y) = (centre + scale * p[0], centre - scale * p[1]);
            Screen {
                x,
                y,
                top: (y - 0.05 - 0.5).floor() as i64 + 1,
                bottom: (y + 0.05 - 0.5).ceil() as i64 - 1,
                left: (x - 0.05 - 0.5).floor() as i64 + 1,
                right: (x + 0.05 - 0.5).ceil() as i64 - 1,
            }
        })
        .collect();
    let (mut x0, mut y0, mut x1, mut y1) = (size, size, 0_f64, 0_f64);
    for p in &screen {
        (x0, y0, x1, y1) = (x0.min(p.x - 1.), y0.min(p.y - 1.), x1.max(p.x + 1.), y1.max(p.y + 1.));
    }
    let (x0, y0) = (x0.floor().max(0.) as i64, y0.floor().max(0.) as i64);
    let (x1, y1) = (x1.ceil().min(size) as i64, y1.ceil().min(size) as i64);
    let (width, height) = ((x1 - x0).max(1) as usize, (y1 - y0).max(1) as usize);
    if width < 2 || height < 2 {
        return None;
    }
    let mut paint = vec![0_u8; width * height];
    let mut depth = vec![-1e9_f64; width * height];
    let hidden = hidden_behind(m, reaches);
    for &[ia, ib, ic, tone] in &mesh.triangles {
        let (a, b, c) = (&screen[ia], &screen[ib], &screen[ic]);
        let row_from = y0.max(a.top.min(b.top).min(c.top));
        let row_to = (y1 - 1).min(a.bottom.max(b.bottom).max(c.bottom));
        if row_from > row_to {
            continue;
        }
        let (col_from, col_to) = (a.left.min(b.left).min(c.left), a.right.max(b.right).max(c.right));
        if col_from > col_to {
            continue;
        }
        let det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
        if det.abs() < 1e-8 {
            continue;
        }
        let (pa, pb, pc) = (in_view[ia], in_view[ib], in_view[ic]);
        let mut sorted = [(a.x, a.y), (b.x, b.y), (c.x, c.y)];
        sorted.sort_by(|p, q| p.1.total_cmp(&q.1));
        let [first, middle, last] = sorted;
        let along =
            |p: P2, q: P2, y: f64| if q.1 - p.1 < 1e-9 { q.0 } else { p.0 + (q.0 - p.0) * (y - p.1) / (q.1 - p.1) };
        for row in row_from..=row_to {
            let cy = row as f64 + 0.5;
            let yy = cy.clamp(first.1, last.1);
            let long = along(first, last, yy);
            let short = if yy <= middle.1 { along(first, middle, yy) } else { along(middle, last, yy) };
            let from = x0.max((long.min(short).floor() as i64) - 1).max(col_from);
            let to = (x1 - 1).min((long.max(short).ceil() as i64) + 1).min(col_to);
            for col in from..=to {
                let cx = col as f64 + 0.5;
                let wa = ((b.y - c.y) * (cx - c.x) + (c.x - b.x) * (cy - c.y)) / det;
                let wb = ((c.y - a.y) * (cx - c.x) + (a.x - c.x) * (cy - c.y)) / det;
                let wc = 1. - wa - wb;
                if wa < 0. || wb < 0. || wc < 0. {
                    continue;
                }
                let z = wa * pa[2] + wb * pb[2] + wc * pc[2];
                let at = (row - y0) as usize * width + (col - x0) as usize;
                if z <= depth[at] {
                    continue;
                }
                let x = wa * pa[0] + wb * pb[0] + wc * pc[0];
                let y = wa * pa[1] + wb * pb[1] + wc * pc[1];
                if hidden(x, y, z) {
                    continue;
                }
                depth[at] = z;
                paint[at] = tone as u8;
            }
        }
    }
    Some(Raster { left: x0, top: y0, width, height, paint })
}

fn blur(values: &[f64], width: usize, height: usize) -> Vec<f64> {
    let pass = |input: &[f64], step: usize| {
        let mut out = vec![0.; input.len()];
        for y in 1..height.saturating_sub(1) {
            for x in 1..width.saturating_sub(1) {
                let at = y * width + x;
                out[at] = (input[at - step] + 2. * input[at] + input[at + step]) / 4.;
            }
        }
        out
    };
    pass(&pass(values, 1), width)
}

fn grow(mask: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut across = vec![0_u8; mask.len()];
    for y in 0..height {
        for x in 0..width {
            if (-2_i64..=2).any(|k| {
                let xx = x as i64 + k;
                xx >= 0 && (xx as usize) < width && mask[y * width + xx as usize] == 1
            }) {
                across[y * width + x] = 1;
            }
        }
    }
    let mut out = vec![0_u8; mask.len()];
    for y in 0..height {
        for x in 0..width {
            if (-2_i64..=2).any(|k| {
                let yy = y as i64 + k;
                yy >= 0 && (yy as usize) < height && across[yy as usize * width + x] == 1
            }) {
                out[y * width + x] = 1;
            }
        }
    }
    out
}

fn trace_stem(m: &M3, size: f64, reaches: &[f64]) -> Vec<(StemTone, Vec<Vec<P2>>)> {
    const PAD: usize = 4;
    let Some(raster) = raster_stem(m, size, reaches) else { return Vec::new() };
    let (width, height) = (raster.width + PAD * 2, raster.height + PAD * 2);
    let mut padded = vec![0_u8; width * height];
    for y in 0..raster.height {
        let row = &raster.paint[y * raster.width..(y + 1) * raster.width];
        padded[(y + PAD) * width + PAD..(y + PAD) * width + PAD + raster.width].copy_from_slice(row);
    }
    let any = blur(&padded.iter().map(|&v| f64::from(u8::from(v != 0))).collect::<Vec<_>>(), width, height);
    let origin = (raster.left as f64 - PAD as f64 + 0.5, raster.top as f64 - PAD as f64 + 0.5);
    let mut out = Vec::new();
    for (tone, paints) in [(StemTone::Stem, &[1_u8, 2][..]), (StemTone::Cap, &[2_u8][..])] {
        let all = padded.iter().all(|v| *v == 0 || paints.contains(v));
        let field = if all {
            any.clone()
        } else {
            let own: Vec<u8> = padded.iter().map(|v| u8::from(paints.contains(v))).collect();
            let near = grow(&own, width, height);
            let mask: Vec<f64> =
                (0..own.len()).map(|i| f64::from(if padded[i] == 0 { own[i] | near[i] } else { own[i] })).collect();
            blur(&mask, width, height)
        };
        let values: Vec<f64> = (0..field.len()).map(|i| 0.5 - field[i].min(any[i])).collect();
        let loops: Vec<Vec<P2>> = contours(&values, width, height)
            .into_iter()
            .map(|l| simplify(&l.into_iter().map(|(x, y)| (origin.0 + x, origin.1 + y)).collect::<Vec<_>>()))
            .filter(|l| l.len() >= 3)
            .collect();
        if !loops.is_empty() {
            out.push((tone, loops));
        }
    }
    out
}

fn contours(values: &[f64], width: usize, height: usize) -> Vec<Vec<P2>> {
    let mut next = vec![usize::MAX; 2 * width * height];
    let place = |edge: usize| {
        let node = edge >> 1;
        let other = if edge & 1 == 1 { node + width } else { node + 1 };
        let t = values[node] / (values[node] - values[other]);
        let (x, y) = ((node % width) as f64, (node / width) as f64);
        if edge & 1 == 1 {
            (x, y + t)
        } else {
            (x + t, y)
        }
    };
    for y in 0..height.saturating_sub(1) {
        for x in 0..width.saturating_sub(1) {
            let i = y * width + x;
            let corners = [i, i + 1, i + 1 + width, i + width];
            let edges = [2 * i, 2 * (i + 1) + 1, 2 * (i + width), 2 * i + 1];
            let mut crossings = [(0_usize, false); 4];
            let mut count = 0;
            for k in 0..4 {
                let here = values[corners[k]] < 0.;
                if here != (values[corners[(k + 1) & 3]] < 0.) {
                    crossings[count] = (edges[k], here);
                    count += 1;
                }
            }
            if count == 2 {
                let from = usize::from(crossings[0].1);
                next[crossings[from].0] = crossings[1 - from].0;
            } else if count == 4 {
                let middle = corners.iter().map(|&c| values[c]).sum::<f64>() / 4. < 0.;
                for k in 0..4 {
                    if crossings[k].1 {
                        next[crossings[k].0] = crossings[(k + if middle { 1 } else { 3 }) & 3].0;
                    }
                }
            }
        }
    }
    let mut seen = vec![false; next.len()];
    let mut loops = Vec::new();
    for start in 0..next.len() {
        if next[start] == usize::MAX || seen[start] {
            continue;
        }
        let mut current = Vec::new();
        let mut edge = start;
        while edge != usize::MAX && !seen[edge] {
            seen[edge] = true;
            current.push(place(edge));
            edge = next[edge];
        }
        if edge == start {
            loops.push(current);
        }
    }
    loops
}

fn simplify(points: &[P2]) -> Vec<P2> {
    let count = points.len();
    if count < 4 {
        return points.to_vec();
    }
    let mut keep = vec![false; count];
    let distance2 = |a: P2, b: P2| (a.0 - b.0).powi(2) + (a.1 - b.1).powi(2);
    let far = (1..count)
        .max_by(|&a, &b| distance2(points[a], points[0]).total_cmp(&distance2(points[b], points[0])))
        .unwrap_or(1);
    keep[0] = true;
    keep[far] = true;
    let off_line = |p: P2, a: P2, b: P2| {
        let (ex, ey) = (b.0 - a.0, b.1 - a.1);
        let (px, py) = (p.0 - a.0, p.1 - a.1);
        let length = ex * ex + ey * ey;
        let t = if length > 0. { ((px * ex + py * ey) / length).clamp(0., 1.) } else { 0. };
        (px - ex * t).hypot(py - ey * t)
    };
    fn split(points: &[P2], keep: &mut [bool], from: usize, to: usize, off_line: &dyn Fn(P2, P2, P2) -> f64) {
        if to - from < 2 {
            return;
        }
        let (a, b) = (points[from], points[to % points.len()]);
        let (mut worst, mut at) = (-1., from);
        for (index, &p) in points.iter().enumerate().take(to).skip(from + 1) {
            let d = off_line(p, a, b);
            if d > worst {
                (worst, at) = (d, index);
            }
        }
        let bent = worst > 0.25;
        if !bent && (b.0 - a.0).hypot(b.1 - a.1) <= 4. {
            return;
        }
        if !bent {
            at = (from + to) / 2;
        }
        keep[at] = true;
        split(points, keep, from, at, off_line);
        split(points, keep, at, to, off_line);
    }
    split(points, &mut keep, 0, far, &off_line);
    split(points, &mut keep, far, count, &off_line);
    points.iter().zip(keep).filter_map(|(p, k)| k.then_some(*p)).collect()
}
