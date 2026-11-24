/**
 * Geometry for the bot mark: rotations, the eye outlines drawn on a turned body, and path text.
 * Body space has x to the right, y up and z toward the viewer; a body is seen orthographically,
 * so turning it only ever changes a flat silhouette and where the eyes sit on it.
 */

export type Point = readonly [number, number];
export type Vec3 = readonly [number, number, number];
/** A row-major 3×3 rotation. */
export type Mat3 = readonly number[];

const DEG = Math.PI / 180;

/** The rotation for a pitch (about x), then a yaw (about y), then a roll (about z), in degrees. */
export function rotationMatrix([pitch, yaw, roll]: readonly [number, number, number]): Mat3 {
  const [cx, sx] = [Math.cos(pitch * DEG), Math.sin(pitch * DEG)];
  const [cy, sy] = [Math.cos(yaw * DEG), Math.sin(yaw * DEG)];
  const [cz, sz] = [Math.cos(roll * DEG), Math.sin(roll * DEG)];
  // Rz · Ry · Rx
  return [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    -sy,
    cy * sx,
    cy * cx,
  ];
}

export function rotate(m: Mat3, [x, y, z]: Vec3): Vec3 {
  return [
    m[0]! * x + m[1]! * y + m[2]! * z,
    m[3]! * x + m[4]! * y + m[5]! * z,
    m[6]! * x + m[7]! * y + m[8]! * z,
  ];
}

// ── Eye outlines in eye space ───────────────────────────────────────────────────────────────

/**
 * One eye in its own flat space, where x points away from the face's middle and y points up.
 * It is a stroke of half-width `half` along `spine` with round ends (one spine point is a dot),
 * or an ellipse when `oval` is set. `off` moves it, `tilt` turns it and `lid` closes it.
 */
export type EyeShape = {
  spine: readonly Point[];
  half: number;
  oval: readonly [number, number] | null;
  off: Point;
  tilt: number;
  lid: number;
};

const OUTLINE = 48;

function strokeOutline(spine: readonly Point[], half: number): Point[] {
  if (spine.length < 2 || spine.every(([x, y]) => x === spine[0]![0] && y === spine[0]![1])) {
    const [cx, cy] = spine[0] ?? [0, 0];
    return Array.from({ length: OUTLINE }, (_, index) => {
      const a = (index / OUTLINE) * Math.PI * 2;
      return [cx + Math.cos(a) * half, cy + Math.sin(a) * half] as const;
    });
  }
  const normals = spine.map((_, index) => {
    const [ax, ay] = spine[Math.max(0, index - 1)]!;
    const [bx, by] = spine[Math.min(spine.length - 1, index + 1)]!;
    const length = Math.hypot(bx - ax, by - ay) || 1;
    return [-(by - ay) / length, (bx - ax) / length] as const;
  });
  const out: Point[] = [];
  const cap = (center: Point, [nx, ny]: Point) => {
    const start = Math.atan2(ny, nx);
    for (let step = 1; step < 12; step += 1) {
      const a = start - (step / 12) * Math.PI;
      out.push([center[0] + Math.cos(a) * half, center[1] + Math.sin(a) * half]);
    }
  };
  for (let index = 0; index < spine.length; index += 1) {
    const [x, y] = spine[index]!;
    const [nx, ny] = normals[index]!;
    out.push([x + nx * half, y + ny * half]);
  }
  cap(spine[spine.length - 1]!, normals[normals.length - 1]!);
  for (let index = spine.length - 1; index >= 0; index -= 1) {
    const [x, y] = spine[index]!;
    const [nx, ny] = normals[index]!;
    out.push([x - nx * half, y - ny * half]);
  }
  const [fx, fy] = normals[0]!;
  cap(spine[0]!, [-fx, -fy]);
  return out;
}

/** Evenly spaced points around a closed outline, starting where it crosses straight up. */
function resampleClosed(points: readonly Point[], count: number): Point[] {
  let cx = 0;
  for (const [x] of points) cx += x;
  cx /= points.length;
  const lengths = [0];
  for (let index = 1; index <= points.length; index += 1) {
    const [ax, ay] = points[index - 1]!;
    const [bx, by] = points[index % points.length]!;
    lengths.push(lengths[index - 1]! + Math.hypot(bx - ax, by - ay));
  }
  const total = lengths[points.length]! || 1;
  // Start at the highest point near the middle, so two outlines line up when they are blended.
  let start = 0;
  let best = -Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const [x, y] = points[index]!;
    const score = y - Math.abs(x - cx) * 0.25;
    if (score > best) {
      best = score;
      start = index;
    }
  }
  const out: Point[] = [];
  let segment = start;
  let travelled = 0;
  for (let index = 0; index < count; index += 1) {
    const at = (index / count) * total;
    while (true) {
      const from = segment % points.length;
      const span = lengths[from + 1]! - lengths[from]!;
      if (travelled + span >= at || span === 0) {
        const t = span === 0 ? 0 : (at - travelled) / span;
        const [ax, ay] = points[from]!;
        const [bx, by] = points[(from + 1) % points.length]!;
        out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
        break;
      }
      travelled += span;
      segment += 1;
    }
  }
  // Keep one winding so blended outlines never fold through themselves.
  let area = 0;
  for (let index = 0; index < out.length; index += 1) {
    const [ax, ay] = out[index]!;
    const [bx, by] = out[(index + 1) % out.length]!;
    area += ax * by - bx * ay;
  }
  return area < 0 ? [out[0]!, ...out.slice(1).reverse()] : out;
}

/** The eye's outline in eye space, `OUTLINE` points long, before `off`, `tilt` and `lid`. */
export function eyeLocalOutline(eye: EyeShape): Point[] {
  const raw = eye.oval
    ? Array.from({ length: OUTLINE }, (_, index) => {
        const a = (index / OUTLINE) * Math.PI * 2;
        return [Math.cos(a) * eye.oval![0], Math.sin(a) * eye.oval![1]] as const;
      })
    : strokeOutline(eye.spine, eye.half);
  return resampleClosed(raw, OUTLINE);
}

/** Moves a local outline by the eye's offset, tilt and lid. */
export function placeEye(outline: readonly Point[], eye: EyeShape): Point[] {
  const c = Math.cos(eye.tilt);
  const s = Math.sin(eye.tilt);
  return outline.map(([x, y]) => {
    const ly = y * eye.lid;
    return [eye.off[0] + c * x + s * ly, eye.off[1] - s * x + c * ly] as const;
  });
}

// ── Eyes on a body ──────────────────────────────────────────────────────────────────────────

/** Where an eye sits: its centre direction `m`, the outward axis `c` and the up axis `t`. */
export type EyeFrame = { m: Vec3; c: Vec3; t: Vec3 };

/**
 * Wraps a flat eye outline onto a unit sphere around `frame` (distances along the surface are
 * kept), turns it with `turn`, and clips it to the visible half, following the rim where it
 * leaves. Returns the outline in body units, x right and y up, or null when nothing shows.
 */
export function sphereEye(outline: readonly Point[], frame: EyeFrame, turn: Mat3): Point[] | null {
  const m = rotate(turn, frame.m);
  const c = rotate(turn, frame.c);
  const t = rotate(turn, frame.t);
  const surface = outline.map(([x, y]) => {
    const d = Math.hypot(x, y);
    const k = d > 1e-9 ? Math.sin(d) / d : 1;
    const cos = Math.cos(d);
    return [
      cos * m[0] + k * (x * c[0] + y * t[0]),
      cos * m[1] + k * (x * c[1] + y * t[1]),
      cos * m[2] + k * (x * c[2] + y * t[2]),
    ] as const;
  });
  return clipToFront(surface, 1);
}

/** Clips a closed 3D outline to z ≥ 0 and drops it flat, walking the rim (radius `rim`) between exits. */
export function clipToFront(points: readonly Vec3[], rim: number): Point[] | null {
  const out: Point[] = [];
  let exitAngle: number | null = null;
  const firstVisible = points.findIndex(([, , z]) => z >= 0);
  if (firstVisible < 0) return null;
  if (points.every(([, , z]) => z >= 0)) return points.map(([x, y]) => [x, y] as const);
  const n = points.length;
  for (let step = 0; step < n; step += 1) {
    const a = points[(firstVisible + step) % n]!;
    const b = points[(firstVisible + step + 1) % n]!;
    const aIn = a[2] >= 0;
    const bIn = b[2] >= 0;
    if (aIn) out.push([a[0], a[1]]);
    if (aIn !== bIn) {
      const t = a[2] / (a[2] - b[2]);
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const angle = Math.atan2(y, x);
      if (aIn) {
        out.push([x, y]);
        exitAngle = angle;
      } else if (exitAngle !== null) {
        let sweep = angle - exitAngle;
        while (sweep > Math.PI) sweep -= Math.PI * 2;
        while (sweep < -Math.PI) sweep += Math.PI * 2;
        const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 48)));
        for (let k = 1; k < steps; k += 1) {
          const at = exitAngle + (sweep * k) / steps;
          out.push([Math.cos(at) * rim, Math.sin(at) * rim]);
        }
        out.push([x, y]);
        exitAngle = null;
      }
    }
  }
  return out.length >= 3 ? out : null;
}

// ── Path text ───────────────────────────────────────────────────────────────────────────────

export const fmt = (value: number) => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

/** A closed polyline, as the reference writes its eye holes. */
export function polylinePath(points: readonly Point[]): string {
  let d = "";
  for (let index = 0; index < points.length; index += 1) {
    const [x, y] = points[index]!;
    d += `${index === 0 ? "M" : "L"}${fmt(x)} ${fmt(y)}`;
  }
  return `${d}Z`;
}

/** A closed outline smoothed with quadratic curves through its midpoints. */
export function smoothPath(points: readonly Point[]): string {
  const mid = (a: Point, b: Point) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
  const first = mid(points[points.length - 1]!, points[0]!);
  let d = `M${fmt(first[0])} ${fmt(first[1])}`;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const end = mid(point, points[(index + 1) % points.length]!);
    d += `Q${fmt(point[0])} ${fmt(point[1])} ${fmt(end[0])} ${fmt(end[1])}`;
  }
  return `${d}Z`;
}

/** An ellipse as four arcs, starting at its right end. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  const a = `A${fmt(rx)} ${fmt(ry)} 0 0 0 `;
  return (
    `M${fmt(cx + rx)} ${fmt(cy)}${a}${fmt(cx)} ${fmt(cy - ry)}${a}${fmt(cx - rx)} ${fmt(cy)}` +
    `${a}${fmt(cx)} ${fmt(cy + ry)}${a}${fmt(cx + rx)} ${fmt(cy)}Z`
  );
}

/** The convex hull of a set of points, counter-clockwise, without points along its edges. */
export function convexHull(points: readonly Point[]): Point[] {
  const sorted = points
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (ordered: readonly Point[]) => {
    const out: Point[] = [];
    for (const point of ordered) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, point) <= 0) {
        out.pop();
      }
      out.push(point);
    }
    out.pop();
    return out;
  };
  return [...chain(sorted), ...chain([...sorted].reverse())];
}

/** Polygon point test, used to keep eyes inside a body. */
export function insidePolygon([px, py]: Point, polygon: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** A cubic Bézier easing curve, as CSS writes it, evaluated at `x`. */
export function cubicEase([x1, y1, x2, y2]: readonly number[], x: number): number {
  const at = (t: number, a: number, b: number) => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  const slope = (t: number, a: number, b: number) => {
    const u = 1 - t;
    return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b);
  };
  let t = x;
  for (let step = 0; step < 8; step += 1) {
    const error = at(t, x1!, x2!) - x;
    const d = slope(t, x1!, x2!);
    if (Math.abs(error) < 1e-6 || Math.abs(d) < 1e-6) break;
    t = Math.min(1, Math.max(0, t - error / d));
  }
  return at(t, y1!, y2!);
}
