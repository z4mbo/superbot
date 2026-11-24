/**
 * The pumpkin: a ribbed, squat body given by its radius in every direction, with a curved stem
 * growing out of its top. Unlike the other bodies it is never mirrored when it turns, its eyes
 * are pressed onto its surface (and trimmed where its own ribs or rim hide them), and its stem is
 * drawn in two greys of its own over the body's ink.
 *
 * Everything here works in sprite pixels: a square `size` pixels across with the body's middle at
 * its centre and y down, as the stem is traced from a pixel raster.
 */
import type { BodyEye, BodyTurn } from "./bot-mark-bodies.js";
import { turnMatrix } from "./bot-mark-bodies.js";
import type { Mat3, Point, Vec3 } from "./bot-mark-geometry.js";
import { convexHull, insidePolygon, rotate } from "./bot-mark-geometry.js";

const PI = Math.PI;
const TAU = PI * 2;
// One binding each, so a bundle that never draws a pumpkin can drop them.
const abs = Math.abs;
const acos = Math.acos;
const asin = Math.asin;
const atan2 = Math.atan2;
const ceil = Math.ceil;
const cos = Math.cos;
const exp = Math.exp;
const floor = Math.floor;
const hypot = Math.hypot;
const max = Math.max;
const min = Math.min;
const pow = Math.pow;
const sin = Math.sin;
const sqrt = Math.sqrt;

/** The pumpkin's size against the sphere, as for the other bodies. */
const SIZE = 1.17;
const WIDE = 1.08;
const TALL = WIDE * 0.84;
const RIBS = 8;
const RIB_TURN = (19 * PI) / 180;
const GROOVE = 0.16;

/** The pumpkin's radius toward a unit direction (x right, y up, z toward the viewer). */
function radiusToward(x: number, y: number, z: number): number {
  const shell = 1 / pow(pow(hypot(x, z) / WIDE, 2.2) + pow(abs(y) / TALL, 2.2), 1 / 2.2);
  const rib = abs(cos((RIBS * (atan2(z, x) - PI / 2 - RIB_TURN)) / 2));
  const ribFade = y < 0 ? pow(max(0, 1 - y * y), 0.2) : sqrt(max(0, 1 - y * y)) * (1 - 0.45 * y);
  const ribs = 1 - GROOVE * (1 - pow(rib, 0.6)) * ribFade;
  const band = pow(abs(cos(3 * asin(max(-1, min(1, y))))), 0.6);
  const bandFade = y < 0 ? 1 : max(0, 1 - 2.2 * y);
  const bands = 1 - GROOVE * 0.55 * 0.9 * (1 - band) * bandFade;
  const dimple = y > 0 ? 0.11 * exp(-(1 - y) / 0.02) : 0.03 * exp(-(1 + y) / 0.03);
  return shell * ribs * bands * (1 - dimple);
}

// The radius is read from a table over latitude and longitude, as the reference reads it.
const LAT = 160;
const LON = 320;
let table: { radii: Float32Array; least: number; most: number } | null = null;

function radii() {
  if (table) return table;
  const values = new Float32Array((LAT + 1) * (LON + 1));
  let least = Infinity;
  let most = 0;
  for (let a = 0; a <= LAT; a += 1) {
    const lat = -PI / 2 + (a / LAT) * PI;
    for (let o = 0; o <= LON; o += 1) {
      const lon = -PI + (o / LON) * TAU;
      const r = radiusToward(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
      values[a * (LON + 1) + o] = r;
      least = min(least, r);
      most = max(most, r);
    }
  }
  table = { radii: values, least, most };
  return table;
}

/** The radius toward any direction, interpolated from the table. */
function reachToward(x: number, y: number, z: number): number {
  const { radii: values } = radii();
  const lat = ((asin(max(-1, min(1, y / (hypot(x, y, z) || 1)))) + PI / 2) / PI) * LAT;
  const lon = ((atan2(z, x) + PI) / TAU) * LON;
  const a = min(LAT - 1, max(0, floor(lat)));
  const o = min(LON - 1, max(0, floor(lon)));
  const [u, v] = [lat - a, lon - o];
  const at = a * (LON + 1) + o;
  const below = at + LON + 1;
  return (
    (values[at]! * (1 - v) + values[at + 1]! * v) * (1 - u) +
    (values[below]! * (1 - v) + values[below + 1]! * v) * u
  );
}

const view = (m: Mat3, p: Vec3): Vec3 => rotate(m, p);
const body = (m: Mat3, [x, y, z]: Vec3): Vec3 => [
  m[0]! * x + m[3]! * y + m[6]! * z,
  m[1]! * x + m[4]! * y + m[7]! * z,
  m[2]! * x + m[5]! * y + m[8]! * z,
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function pumpkinUnit(size: number): number {
  return SIZE * ((0.36 * size) / 1.18);
}

// ── Outline ────────────────────────────────────────────────────────────────────────────────────

const RAYS = 256;
// Built in a call marked pure, so a bundle that never draws a pumpkin can drop it.
const TILTS = /* @__PURE__ */ (() =>
  Array.from({ length: 49 }, (_, k) => {
    const a = ((k - 24) / 24) * 1.25;
    return [cos(a), sin(a)] as const;
  }).sort((p, q) => q[0] - p[0]))();

export type PumpkinShape = {
  /** How far the outline reaches along each of 256 directions, in body units. */
  reaches: Float64Array;
  outline: Point[];
  stem: { d: Point[][]; tone: "stem" | "cap" }[];
};

const shapes = new Map<string, PumpkinShape>();

/** The pumpkin's outline and stem seen through a turn, in sprite pixels. */
export function pumpkinShape(turn: BodyTurn, size: number): PumpkinShape {
  const key = `${size} ${turn.yaw} ${turn.pitch} ${turn.roll}`;
  const cached = shapes.get(key);
  if (cached) {
    shapes.delete(key);
    shapes.set(key, cached);
    return cached;
  }
  const m = turnMatrix(turn);
  const { most } = radii();
  const centre = size / 2;
  const unit = pumpkinUnit(size);
  const reaches = new Float64Array(RAYS);
  const outline: Point[] = [];
  for (let k = 0; k < RAYS; k += 1) {
    const a = (TAU * k) / RAYS;
    const [dx, dy] = [cos(a), sin(a)];
    let reach = 0;
    for (const [lean, depth] of TILTS) {
      if (lean * most < reach) break;
      const [x, y, z] = body(m, [dx * lean, dy * lean, depth]);
      reach = max(reach, reachToward(x, y, z) * lean);
    }
    reaches[k] = reach;
    outline.push([centre + unit * reach * dx, centre - unit * reach * dy]);
  }
  const shape: PumpkinShape = { reaches, outline, stem: traceStem(m, size, reaches) };
  shapes.set(key, shape);
  if (shapes.size > 128) {
    const oldest = shapes.keys().next().value;
    if (oldest !== undefined) shapes.delete(oldest);
  }
  return shape;
}

// ── Eyes ───────────────────────────────────────────────────────────────────────────────────────

/** The point on the surface in a view direction, slightly proud of it. */
function surfaceAt(m: Mat3, direction: Vec3): Vec3 {
  const length = hypot(...direction) || 1;
  const unitDir: Vec3 = [direction[0] / length, direction[1] / length, direction[2] / length];
  const r = reachToward(...body(m, unitDir)) * 1.002;
  return [unitDir[0] * r, unitDir[1] * r, unitDir[2] * r];
}

/** Whether the surface point in a view direction can be seen: nothing of the body lies in front of it. */
function seen(m: Mat3, direction: Vec3): boolean {
  if (direction[2] / (hypot(...direction) || 1) < -0.35) return false;
  const { least, most } = radii();
  const [x, y, z] = surfaceAt(m, direction);
  for (let k = 1; k <= 48; k += 1) {
    const step = 0.01 + (k / 48) * 2.2;
    const p: Vec3 = [x, y, z + step];
    const d = hypot(...p);
    if (d > 2.2) break;
    if (d > most) {
      if (p[2] >= 0) break;
      continue;
    }
    if (d < least) return false;
    if (d < reachToward(...body(m, [p[0] / d, p[1] / d, p[2] / d]))) return false;
  }
  return true;
}

/** A face point to a unit direction: distances from the face's middle are kept along the surface. */
function wrapPoint(x: number, y: number): Vec3 {
  const d = hypot(x, y);
  if (d < 1e-8) return [0, 0, 1];
  return [(x / d) * sin(d), (y / d) * sin(d), cos(d)];
}

/** The pumpkin's eyes, pressed onto its surface and trimmed where it hides them, in sprite pixels. */
export function pumpkinEyes(
  turn: BodyTurn,
  size: number,
  shape: PumpkinShape,
  eyes: readonly BodyEye[],
): Point[][] {
  const m = turnMatrix(turn);
  const centre = size / 2;
  const unit = pumpkinUnit(size);
  const project = ([x, y]: Vec3 | Point): Point => [centre + unit * x, centre - unit * y];
  const normal = view(m, [0, 0, 1]);
  const up = view(m, [0, 1, 0]);
  const right = view(m, [1, 0, 0]);
  const loops = eyes.map(({ outline, off: [ox, oy] }, index) => {
    const side = index === 0 ? -1 : 1;
    const cx = side * (0.32 + ox) + sin(0.04);
    const cy = -sin(0.12) + oy;
    return outline.map(([x, y]) => [cx + side * (x - ox), cy + (y - oy)] as const);
  });
  const pieces: Point[][] = [];
  for (const loop of loops) {
    const directions = loop.map(([x, y]) => view(m, wrapPoint(x, y)));
    const covers = (direction: Vec3) => {
      const n = dot(direction, normal);
      if (n <= 0.02) return false;
      const a = acos(max(-1, min(1, n)));
      const s = sin(a);
      const point: Point =
        s < 1e-8 ? [0, 0] : [(a * dot(direction, right)) / s, (a * dot(direction, up)) / s];
      return insidePolygon(point, loop);
    };
    const piece = pressEye(m, directions, covers, shape.reaches, (p) => project(p), centre, unit);
    if (piece) pieces.push(piece);
  }
  return trimToRim(pieces, shape.reaches, centre, unit);
}

function pressEye(
  m: Mat3,
  directions: Vec3[],
  covers: (direction: Vec3) => boolean,
  reaches: Float64Array,
  project: (p: Vec3) => Point,
  centre: number,
  unit: number,
): Point[] | null {
  const visible = directions.map((direction) => seen(m, direction));
  if (visible.every((v) => !v)) return null;
  if (visible.every((v) => v)) return directions.map((d) => project(surfaceAt(m, d)));
  const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const edge = (from: Vec3, to: Vec3) => {
    let [low, high] = [0, 1];
    for (let step = 0; step < 14; step += 1) {
      const mid = (low + high) / 2;
      if (seen(m, lerp(from, to, mid))) low = mid;
      else high = mid;
    }
    return surfaceAt(m, lerp(from, to, low));
  };
  const rim = (angle: number): Point => {
    let t = (angle / TAU) * RAYS;
    t = ((t % RAYS) + RAYS) % RAYS;
    const k = floor(t) % RAYS;
    const f = t - floor(t);
    const reach = (reaches[k]! * (1 - f) + reaches[(k + 1) % RAYS]! * f) * unit;
    return [centre + reach * cos(angle), centre - reach * sin(angle)];
  };
  const count = directions.length;
  const start = visible.findIndex((v) => !v);
  const out: Point[][] = [];
  let piece: Point[] | null = null;
  let entered = 0;
  for (let step = 0; step < count; step += 1) {
    const i = (start + step) % count;
    const j = (i + 1) % count;
    if (!visible[i] && visible[j]) {
      const p = edge(directions[j]!, directions[i]!);
      entered = atan2(p[1], p[0]);
      piece = [project(p)];
    }
    if (visible[i]) {
      piece ??= [];
      piece.push(project(surfaceAt(m, directions[i]!)));
    }
    if (visible[i] && !visible[j] && piece) {
      const p = edge(directions[i]!, directions[j]!);
      piece.push(project(p));
      const left = atan2(p[1], p[0]);
      let sweep = entered - left;
      while (sweep <= -PI) sweep += TAU;
      while (sweep > PI) sweep -= TAU;
      const middle = left + sweep / 2;
      if (covers([cos(middle), sin(middle), 0])) {
        const steps = max(2, ceil(abs(sweep) / 0.03));
        for (let k = 1; k < steps; k += 1) piece.push(rim(left + (sweep * k) / steps));
      }
      if (piece.length > 2) out.push(piece);
      piece = null;
    }
  }
  if (out.length === 0) return null;
  return out.reduce((best, next) => (abs(area(next)) > abs(area(best)) ? next : best));
}

function area(points: readonly Point[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index]!;
    const [bx, by] = points[(index + 1) % points.length]!;
    total += ax * by - bx * ay;
  }
  return total / 2;
}

/** Cuts the eyes to just inside the outline's hull, dropping slivers. */
function trimToRim(
  eyes: Point[][],
  reaches: Float64Array,
  centre: number,
  unit: number,
): Point[][] {
  if (eyes.length === 0) return [];
  const ring: Point[] = [];
  for (let k = 0; k < RAYS; k += 1) {
    const a = (TAU * k) / RAYS;
    const r = max(0.05, reaches[k]! - 0.015) * unit;
    ring.push([centre + r * cos(a), centre - r * sin(a)]);
  }
  const hull = convexHull(ring);
  const [a, b] = [hull[0]!, hull[1]!];
  const turn = (b[0] - a[0]) * (centre - a[1]) - (b[1] - a[1]) * (centre - a[0]) > 0 ? 1 : -1;
  const out: Point[][] = [];
  for (const eye of eyes) {
    if (eye.every((p) => insidePolygon(p, hull))) {
      out.push(eye);
      continue;
    }
    let cut = eye;
    for (let k = 0; k < hull.length && cut.length > 2; k += 1) {
      const p = hull[k]!;
      const q = hull[(k + 1) % hull.length]!;
      const keep = ([x, y]: Point) =>
        turn * ((q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]));
      const next: Point[] = [];
      for (let index = 0; index < cut.length; index += 1) {
        const c = cut[index]!;
        const d = cut[(index + 1) % cut.length]!;
        const [kc, kd] = [keep(c), keep(d)];
        if (kc >= 0) next.push(c);
        if (kc >= 0 !== kd >= 0) {
          const t = kc / (kc - kd);
          next.push([c[0] + t * (d[0] - c[0]), c[1] + t * (d[1] - c[1])]);
        }
      }
      cut = next;
    }
    if (cut.length > 2 && abs(area(cut)) > 0.012 * unit * unit) out.push(cut);
  }
  return out;
}

// ── Stem ───────────────────────────────────────────────────────────────────────────────────────

const SPINE = 72;
const AROUND = 48;
let stemMesh: { points: Vec3[]; triangles: Int32Array } | null = null;

/**
 * The stem: a tube that grows up out of the top dimple and bends over to one side, flaring where
 * it meets the body, closed by a flat cap. Triangles carry paint 1 (side) or 2 (cap).
 */
function stem() {
  if (stemMesh) return stemMesh;
  const top = radiusToward(0, 1, 0);
  const length = 0.68;
  const bend = (t: number) => ((-65 * PI) / 180) * pow(t, 2.2);
  const spine: { x: number; y: number; angle: number }[] = [];
  let [x, y] = [0, top - 0.08];
  for (let k = 0; k <= SPINE; k += 1) {
    const t = k / SPINE;
    spine.push({ x, y, angle: bend(t) });
    if (k === SPINE) break;
    for (let s = 0; s < 8; s += 1) {
      const a = bend(t + (s + 0.5) / 8 / SPINE);
      x += sin(a) * (length / SPINE / 8);
      y += cos(a) * (length / SPINE / 8);
    }
  }
  let crown = top;
  for (let k = 1; k <= 24; k += 1) {
    const polar = (k / 24) * 0.6;
    for (let j = 0; j < 32; j += 1) {
      const around = (j * PI) / 16;
      const h =
        radiusToward(sin(polar) * cos(around), cos(polar), sin(polar) * sin(around)) * cos(polar);
      crown = max(crown, h);
    }
  }
  const points: Vec3[] = [];
  spine.forEach(({ x: sx, y: sy, angle }, k) => {
    const t = k / SPINE;
    const flare = max(0, min(1, 1 - (sy - (crown + 0.01)) / 0.09));
    const r = 0.115 + 0.055 * (1 - t) * (1 - t) + 0.06 * flare * flare;
    const [nx, ny] = [cos(angle), -sin(angle)];
    for (let j = 0; j < AROUND; j += 1) {
      const a = (TAU * j) / AROUND;
      points.push([sx + r * cos(a) * nx, sy + r * cos(a) * ny, r * sin(a)]);
    }
  });
  const tip = points.length;
  points.push([spine[SPINE]!.x, spine[SPINE]!.y, 0]);
  const triangles: number[] = [];
  for (let k = 0; k < SPINE; k += 1) {
    for (let j = 0; j < AROUND; j += 1) {
      const n = (j + 1) % AROUND;
      const [a, b] = [k * AROUND, (k + 1) * AROUND];
      triangles.push(a + j, a + n, b + n, 1, a + j, b + n, b + j, 1);
    }
  }
  const last = SPINE * AROUND;
  for (let j = 0; j < AROUND; j += 1) triangles.push(tip, last + j, last + ((j + 1) % AROUND), 2);
  stemMesh = { points, triangles: Int32Array.from(triangles) };
  return stemMesh;
}

/** Whether a stem point (view space, body units) is hidden behind the body. */
function hiddenBehind(m: Mat3, reaches: Float64Array) {
  const { least, most } = radii();
  const ahead = body(m, [0, 0, 1]);
  return (x: number, y: number, z: number) => {
    const across = x * x + y * y;
    if (across >= WIDE * WIDE) return false;
    const k = (floor((atan2(y, x) / TAU) * RAYS) + RAYS) % RAYS;
    const edge = max(reaches[k]!, reaches[(k + 1) % RAYS]!) * 1.01;
    if (across > edge * edge) return false;
    const base = body(m, [x, y, 0]);
    for (let depth = z + 0.012; depth <= WIDE; depth += 0.02) {
      const d = hypot(x, y, depth);
      if (d < least) return true;
      if (d > most) {
        if (depth >= 0) return false;
        continue;
      }
      const p: Vec3 = [
        base[0] + depth * ahead[0],
        base[1] + depth * ahead[1],
        base[2] + depth * ahead[2],
      ];
      if (d <= reachToward(...p)) return true;
    }
    return false;
  };
}

/** The visible stem as a pixel raster of paints, drawn nearest first and hidden behind the body. */
function rasterStem(m: Mat3, size: number, reaches: Float64Array) {
  const { points, triangles } = stem();
  const centre = size / 2;
  const unit = pumpkinUnit(size);
  const inView = points.map((p) => view(m, p));
  const screen = inView.map(([x, y]) => {
    const [sx, sy] = [centre + unit * x, centre - unit * y];
    return {
      x: sx,
      y: sy,
      top: floor(sy - 0.05 - 0.5) + 1,
      bottom: ceil(sy + 0.05 - 0.5) - 1,
      left: floor(sx - 0.05 - 0.5) + 1,
      right: ceil(sx + 0.05 - 0.5) - 1,
    };
  });
  let [x0, y0, x1, y1] = [size, size, 0, 0];
  for (const p of screen) {
    x0 = min(x0, p.x - 1);
    y0 = min(y0, p.y - 1);
    x1 = max(x1, p.x + 1);
    y1 = max(y1, p.y + 1);
  }
  [x0, y0, x1, y1] = [
    max(0, floor(x0)),
    max(0, floor(y0)),
    min(size, ceil(x1)),
    min(size, ceil(y1)),
  ];
  const width = max(1, x1 - x0);
  const height = max(1, y1 - y0);
  if (width < 2 || height < 2) return null;
  const paint = new Uint8Array(width * height);
  const depth = new Float32Array(width * height).fill(-1e9);
  const hidden = hiddenBehind(m, reaches);
  for (let index = 0; index < triangles.length; index += 4) {
    const [ia, ib, ic] = [triangles[index]!, triangles[index + 1]!, triangles[index + 2]!];
    const [a, b, c] = [screen[ia]!, screen[ib]!, screen[ic]!];
    const rowFrom = max(y0, min(a.top, b.top, c.top));
    const rowTo = min(y1 - 1, max(a.bottom, b.bottom, c.bottom));
    if (rowFrom > rowTo) continue;
    const colFrom = min(a.left, b.left, c.left);
    const colTo = max(a.right, b.right, c.right);
    if (colFrom > colTo) continue;
    const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (abs(det) < 1e-8) continue;
    const [pa, pb, pc] = [inView[ia]!, inView[ib]!, inView[ic]!];
    const sorted = [a, b, c].sort((p, q) => p.y - q.y);
    const [first, middle, last] = sorted as [typeof a, typeof a, typeof a];
    const along = (p: typeof a, q: typeof a, y: number) =>
      q.y - p.y < 1e-9 ? q.x : p.x + ((q.x - p.x) * (y - p.y)) / (q.y - p.y);
    for (let row = rowFrom; row <= rowTo; row += 1) {
      const cy = row + 0.5;
      const yy = max(first.y, min(last.y, cy));
      const long = along(first, last, yy);
      const short = yy <= middle.y ? along(first, middle, yy) : along(middle, last, yy);
      const from = max(x0, floor(min(long, short)) - 1, colFrom);
      const to = min(x1 - 1, ceil(max(long, short)) + 1, colTo);
      for (let col = from; col <= to; col += 1) {
        const cx = col + 0.5;
        const wa = ((b.y - c.y) * (cx - c.x) + (c.x - b.x) * (cy - c.y)) / det;
        const wb = ((c.y - a.y) * (cx - c.x) + (a.x - c.x) * (cy - c.y)) / det;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const z = wa * pa[2] + wb * pb[2] + wc * pc[2];
        const at = (row - y0) * width + (col - x0);
        if (z <= depth[at]!) continue;
        const x = wa * pa[0] + wb * pb[0] + wc * pc[0];
        const y = wa * pa[1] + wb * pb[1] + wc * pc[1];
        if (hidden(x, y, z)) continue;
        depth[at] = z;
        paint[at] = triangles[index + 3]!;
      }
    }
  }
  return { left: x0, top: y0, width, height, paint };
}

const PAD = 4;

/** A [1 2 1] blur along rows, then along columns, leaving the border at zero. */
function blur(values: Float32Array, width: number, height: number): Float32Array {
  const pass = (input: Float32Array, step: number) => {
    const out = new Float32Array(input.length);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const at = y * width + x;
        out[at] = (input[at - step]! + 2 * input[at]! + input[at + step]!) / 4;
      }
    }
    return out;
  };
  return pass(pass(values, 1), width);
}

/** Grows a mask by two pixels each way. */
function grow(mask: Uint8Array, width: number, height: number): Uint8Array {
  const across = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let k = -2; k <= 2; k += 1) {
        const xx = x + k;
        if (xx >= 0 && xx < width && mask[y * width + xx] === 1) {
          across[y * width + x] = 1;
          break;
        }
      }
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let k = -2; k <= 2; k += 1) {
        const yy = y + k;
        if (yy >= 0 && yy < height && across[yy * width + x] === 1) {
          out[y * width + x] = 1;
          break;
        }
      }
    }
  }
  return out;
}

/** The stem traced into smooth outlines: all of it in the stem grey, and its cap in a lighter grey. */
function traceStem(m: Mat3, size: number, reaches: Float64Array): PumpkinShape["stem"] {
  const raster = rasterStem(m, size, reaches);
  if (!raster) return [];
  const width = raster.width + PAD * 2;
  const height = raster.height + PAD * 2;
  const padded = new Uint8Array(width * height);
  for (let y = 0; y < raster.height; y += 1) {
    padded.set(
      raster.paint.subarray(y * raster.width, (y + 1) * raster.width),
      (y + PAD) * width + PAD,
    );
  }
  const any = blur(
    Float32Array.from(padded, (v) => (v !== 0 ? 1 : 0)),
    width,
    height,
  );
  const origin: Point = [raster.left - PAD + 0.5, raster.top - PAD + 0.5];
  const out: PumpkinShape["stem"] = [];
  for (const [tone, paints] of [
    ["stem", [1, 2]],
    ["cap", [2]],
  ] as const) {
    const all = padded.every((v) => v === 0 || (paints as readonly number[]).includes(v));
    let field = any;
    if (!all) {
      const own = Uint8Array.from(padded, (v) =>
        (paints as readonly number[]).includes(v) ? 1 : 0,
      );
      const near = grow(own, width, height);
      const mask = own.slice();
      for (let index = 0; index < mask.length; index += 1) {
        if (padded[index] === 0) mask[index]! |= near[index]!;
      }
      field = blur(Float32Array.from(mask), width, height);
    }
    const inside = (index: number) => 0.5 - min(field[index]!, any[index]!);
    const loops = contours(inside, width, height).map((loop) =>
      simplify(loop.map(([x, y]) => [origin[0] + x, origin[1] + y] as const)),
    );
    const kept = loops.filter((loop) => loop.length >= 3);
    if (kept.length > 0) out.push({ d: kept, tone });
  }
  return out;
}

/** Marching squares over a grid of values: closed outlines where the value crosses zero. */
function contours(value: (index: number) => number, width: number, height: number): Point[][] {
  const values = new Float64Array(width * height);
  for (let index = 0; index < values.length; index += 1) values[index] = value(index);
  // Edge ids: 2·i is the edge from node i to its right, 2·i + 1 the edge from node i down.
  const next = new Int32Array(2 * width * height).fill(-1);
  const where = (edge: number): Point => {
    const node = edge >> 1;
    const other = edge & 1 ? node + width : node + 1;
    const [a, b] = [values[node]!, values[other]!];
    const t = a / (a - b);
    const [x, y] = [node % width, floor(node / width)];
    return edge & 1 ? [x, y + t] : [x + t, y];
  };
  const corners = [0, 0, 0, 0];
  const edges = [0, 0, 0, 0];
  const crossings = [0, 0, 0, 0];
  const enters = [false, false, false, false];
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const i = y * width + x;
      corners[0] = i;
      corners[1] = i + 1;
      corners[2] = i + 1 + width;
      corners[3] = i + width;
      edges[0] = 2 * i;
      edges[1] = 2 * (i + 1) + 1;
      edges[2] = 2 * (i + width);
      edges[3] = 2 * i + 1;
      let count = 0;
      for (let k = 0; k < 4; k += 1) {
        const inHere = values[corners[k]!]! < 0;
        if (inHere !== values[corners[(k + 1) & 3]!]! < 0) {
          crossings[count] = edges[k]!;
          enters[count] = inHere;
          count += 1;
        }
      }
      if (count === 2) {
        const from = enters[0] ? 1 : 0;
        next[crossings[from]!] = crossings[1 - from]!;
      } else if (count === 4) {
        const middle =
          (values[corners[0]!]! +
            values[corners[1]!]! +
            values[corners[2]!]! +
            values[corners[3]!]!) /
            4 <
          0;
        for (let k = 0; k < 4; k += 1) {
          if (enters[k]) next[crossings[k]!] = crossings[(k + (middle ? 1 : 3)) & 3]!;
        }
      }
    }
  }
  const seenEdge = new Uint8Array(next.length);
  const loops: Point[][] = [];
  for (let start = 0; start < next.length; start += 1) {
    if (next[start]! < 0 || seenEdge[start]) continue;
    const loop: Point[] = [];
    let edge = start;
    while (edge >= 0 && !seenEdge[edge]) {
      seenEdge[edge] = 1;
      loop.push(where(edge));
      edge = next[edge]!;
    }
    if (edge === start) loops.push(loop);
  }
  return loops;
}

/** Drops points that lie within a quarter pixel of the line between their neighbours, keeping edges under 4px. */
function simplify(points: readonly Point[]): Point[] {
  const count = points.length;
  if (count < 4) return [...points];
  const keep = new Uint8Array(count);
  let far = 0;
  let farthest = -1;
  for (let index = 1; index < count; index += 1) {
    const d = (points[index]![0] - points[0]![0]) ** 2 + (points[index]![1] - points[0]![1]) ** 2;
    if (d > farthest) [farthest, far] = [d, index];
  }
  keep[0] = 1;
  keep[far] = 1;
  const offLine = (p: Point, a: Point, b: Point) => {
    const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
    const [px, py] = [p[0] - a[0], p[1] - a[1]];
    const length = ex * ex + ey * ey;
    const t = length > 0 ? min(1, max(0, (px * ex + py * ey) / length)) : 0;
    return hypot(px - ex * t, py - ey * t);
  };
  const split = (from: number, to: number) => {
    if (to - from < 2) return;
    const a = points[from]!;
    const b = points[to % count]!;
    let worst = -1;
    let at = from;
    for (let index = from + 1; index < to; index += 1) {
      const d = offLine(points[index]!, a, b);
      if (d > worst) [worst, at] = [d, index];
    }
    const bent = worst > 0.25;
    if (!bent && hypot(b[0] - a[0], b[1] - a[1]) <= 4) return;
    if (!bent) at = (from + to) >> 1;
    keep[at] = 1;
    split(from, at);
    split(at, to);
  };
  split(0, far);
  split(far, count);
  return points.filter((_, index) => keep[index] === 1);
}
