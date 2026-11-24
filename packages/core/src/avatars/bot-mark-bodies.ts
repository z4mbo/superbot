/**
 * The 3D bodies behind the bot mark, built the way the reference builds them: a profile turned on
 * a lathe, an outline pushed back with bevelled edges, an outline lofted into a pillow, a row or
 * cluster of balls, a rounded slab, or a rounded gem. Seen from any angle a body is drawn as its
 * flat silhouette; its eyes sit on its front face or wrap around it, and an eye on a part that
 * faces away is left out.
 *
 * Body units: x right, y up, z toward the viewer. A body of size 1 is 1.18 of these across the
 * sphere's radius, so `size / 1.18` scales a body against the sphere.
 */
import type { BotMarkBodyShape, BotMarkBodySpec } from "./bot-mark-body-data.js";
import { BOT_MARK_BODY_SPECS, unpackBodyNumbers } from "./bot-mark-body-data.js";
import type { Mat3, Point, Vec3 } from "./bot-mark-geometry.js";
import { convexHull, rotate, rotationMatrix } from "./bot-mark-geometry.js";

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;

// ── Turning ────────────────────────────────────────────────────────────────────────────────────

/** A body's turn: yaw about y, then pitch about x, then roll about z, in degrees. */
export type BodyTurn = { yaw: number; pitch: number; roll: number };

/**
 * The turn a shaped body is drawn with. The frame's rotation is taken apart into yaw, pitch and
 * roll; a body turned more than halfway round is drawn from its front again, mirrored; and the
 * angles are rounded to `step` degrees, never landing exactly edge-on.
 */
export function bodyTurn(
  rotation: readonly [number, number, number],
  step: number,
  mirror = true,
): BodyTurn {
  let m = rotationMatrix(rotation);
  if (mirror && m[8]! < 0)
    m = [-m[0]!, m[1]!, -m[2]!, -m[3]!, m[4]!, -m[5]!, -m[6]!, m[7]!, -m[8]!];
  const s = Math.max(-1, Math.min(1, -m[6]!));
  const yaw = Math.asin(s);
  const [pitch, roll] =
    Math.abs(s) > 0.999999
      ? [Math.atan2(-m[5]!, m[4]!), 0]
      : [Math.atan2(m[7]!, m[8]!), Math.atan2(m[3]!, m[0]!)];
  const round = (value: number) => (step > 0 ? Math.round(value / step) * step : value);
  return {
    yaw: offEdge(round(yaw * DEG)),
    pitch: offEdge(round(pitch * DEG)),
    roll: round(roll * DEG),
  };
}

/** Moves an angle within half a degree of edge-on to half a degree away from it. */
function offEdge(angle: number): number {
  const t = ((angle % 180) + 180) % 180;
  return Math.abs(t - 90) >= 0.5 ? angle : angle + (t <= 90 ? 89.5 - t : 90.5 - t);
}

/** The rotation for a turn: yaw about y, then pitch about x, then roll about z. */
export function turnMatrix({ yaw, pitch, roll }: BodyTurn): Mat3 {
  const [cy, sy] = [Math.cos(yaw / DEG), Math.sin(yaw / DEG)];
  const [cx, sx] = [Math.cos(pitch / DEG), Math.sin(pitch / DEG)];
  const [cz, sz] = [Math.cos(roll / DEG), Math.sin(roll / DEG)];
  // Rz · Rx · Ry
  return [
    cz * cy - sz * sx * sy,
    -sz * cx,
    cz * sy + sz * sx * cy,
    sz * cy + cz * sx * sy,
    cz * cx,
    sz * sy - cz * sx * cy,
    -cx * sy,
    sx,
    cx * cy,
  ];
}

/** The angle step a body's turn is rounded to, for a body `zoom` of a 192-unit box. */
export function turnStep(zoom: number): number {
  const step = (0.6 / Math.max((192 * zoom) / 2, 1)) * DEG;
  return 2 ** Math.floor(Math.log2(step));
}

// ── Building ───────────────────────────────────────────────────────────────────────────────────

type Built =
  | { type: "lathe"; levels: readonly (readonly [number, number])[] }
  | { type: "hull"; points: readonly Vec3[] }
  | { type: "edges"; rings: readonly (readonly Vec3[])[]; loft: boolean }
  | { type: "balls"; balls: readonly (readonly [number, number, number, number])[] };

const LEVELS = 96;

function points2(packed: string): Point[] {
  const values = unpackBodyNumbers(packed);
  const out: Point[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    out.push([values[index]!, values[index + 1]!]);
  }
  return out;
}

/** Profile heights, closer together near the ends, with the radius at each. */
function profile(top: number, bottom: number, packed: string): [number, number][] {
  const radii = unpackBodyNumbers(packed);
  return radii.map((radius, index) => {
    const t = (1 - Math.cos((index / (LEVELS - 1)) * Math.PI)) / 2;
    return [top + (bottom - top) * t, Math.max(0, radius)];
  });
}

function bounds(points: readonly Point[]) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** A flower: a middle disc ringed by six petals, read off along 240 rays from the middle. */
function flowerOutline(): Point[] {
  const discs: [number, number, number][] = [[0, 0, 0.36]];
  for (let k = 0; k < 6; k += 1) {
    const a = -Math.PI / 2 + (k * TAU) / 6;
    discs.push([0.58 * Math.cos(a), 0.58 * Math.sin(a), 0.33]);
  }
  return Array.from({ length: 240 }, (_, index) => {
    const a = (index / 240) * TAU;
    const [dx, dy] = [Math.cos(a), Math.sin(a)];
    let low = 0;
    let high = 0.91;
    for (let step = 0; step < 22; step += 1) {
      const mid = (low + high) / 2;
      const [x, y] = [mid * dx, mid * dy];
      if (discs.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r)) low = mid;
      else high = mid;
    }
    return [low * dx, low * dy] as const;
  });
}

/** An outline pushed back `halfDepth` either way, its edges rounded over `bevel`. */
function extrude(outline: readonly Point[], halfDepth: number, bevel: number): Vec3[][] {
  const { x0, y0, x1, y1, cx, cy } = bounds(outline);
  const half = Math.max(1e-4, Math.min((x1 - x0) / 2, (y1 - y0) / 2));
  const round = bevel;
  const steps = Array.from({ length: 5 }, (_, k) => {
    const a = (k / 4) * (Math.PI / 2);
    return {
      z: halfDepth - round + round * Math.sin(a),
      scale: 1 - (round / half) * (1 - Math.cos(a)),
    };
  });
  const layers = [
    ...steps.map(({ z, scale }) => ({ z: -z, scale })).reverse(),
    ...steps.map(({ z, scale }) => ({ z, scale })),
  ];
  return layers.map(({ z, scale }) =>
    outline.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale, z] as const),
  );
}

/** An outline puffed into a pillow `depth` deep, rounder toward its middle. */
function loft(outline: readonly Point[], depth: number): Vec3[][] {
  const { cx, cy } = bounds(outline);
  return Array.from({ length: 17 }, (_, k) => {
    const a = -Math.PI / 2 + (Math.PI * k) / 16;
    const scale = Math.max(0, Math.cos(a)) ** 0.72;
    const z = depth * Math.sin(a);
    return outline.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale, z] as const);
  });
}

/** A slab with rounded edges: the outline moved in along its normals as it rounds over. */
function roundedSlab(outline: readonly Point[], halfDepth: number, edge: number): Vec3[] {
  const out: Vec3[] = [];
  const count = outline.length;
  outline.forEach(([x, y], index) => {
    const [px, py] = outline[(index - 1 + count) % count]!;
    const [nx, ny] = outline[(index + 1) % count]!;
    let [ux, uy] = [ny - py, -(nx - px)];
    const length = Math.hypot(ux, uy) || 1;
    [ux, uy] = [ux / length, uy / length];
    if (ux * x + uy * y < 0) [ux, uy] = [-ux, -uy];
    for (let k = 0; k <= 4; k += 1) {
      const a = (k / 4) * (Math.PI / 2);
      const inset = edge * (1 - Math.cos(a));
      const z = halfDepth - edge + edge * Math.sin(a);
      out.push([x - ux * inset, y - uy * inset, z], [x - ux * inset, y - uy * inset, -z]);
    }
  });
  return out;
}

/** The gem: a hexagonal bipyramid with every corner rounded by a small ball. */
function crystal(): Vec3[] {
  const corners: Vec3[] = [
    [0, 1.04, 0],
    [0, -1.04, 0],
  ];
  for (const side of [-1, 1]) {
    for (let k = 0; k < 6; k += 1) {
      const a = (k / 6) * TAU;
      corners.push([0.52 * Math.cos(a), side * 0.51, 0.52 * Math.sin(a)]);
    }
  }
  const out: Vec3[] = [];
  for (const [x, y, z] of corners) {
    for (let k = 0; k <= 8; k += 1) {
      const polar = (k / 8) * Math.PI;
      const ring = k === 0 || k === 8 ? 1 : 14;
      for (let j = 0; j < ring; j += 1) {
        const a = (j / ring) * TAU;
        out.push([
          x + 0.12 * Math.sin(polar) * Math.sin(a),
          y + 0.12 * Math.cos(polar),
          z + 0.12 * Math.sin(polar) * Math.cos(a),
        ]);
      }
    }
  }
  return out;
}

function pillBalls(axis: "x" | "y", reach: number, radius: number) {
  return Array.from({ length: 33 }, (_, k) => {
    const at = -reach + 2 * reach * (k / 32);
    return (axis === "x" ? [at, 0, 0, radius] : [0, at, 0, radius]) as [
      number,
      number,
      number,
      number,
    ];
  });
}

const built = new Map<BotMarkBodyShape, Built>();

function build(shape: BotMarkBodyShape): Built {
  const cached = built.get(shape);
  if (cached) return cached;
  const spec: BotMarkBodySpec = BOT_MARK_BODY_SPECS[shape];
  let body: Built;
  switch (spec.kind) {
    case "revolve":
      body = { type: "lathe", levels: profile(spec.top, spec.bottom, spec.radii) };
      break;
    case "extrusion": {
      const outline = spec.outline ? points2(spec.outline) : flowerOutline();
      const rings = extrude(outline, spec.halfDepth, spec.bevel);
      body = spec.convex
        ? { type: "hull", points: rings.flat() }
        : { type: "edges", rings, loft: false };
      break;
    }
    case "loft":
      body = { type: "edges", rings: loft(points2(spec.outline), spec.depth), loft: true };
      break;
    case "slab":
      body = {
        type: "hull",
        points: roundedSlab(points2(spec.outline), spec.halfDepth, spec.edge),
      };
      break;
    case "crystal":
      body = { type: "hull", points: crystal() };
      break;
    case "pill":
      body = { type: "balls", balls: pillBalls(spec.axis, spec.reach, spec.radius) };
      break;
    case "balls": {
      const values = unpackBodyNumbers(spec.balls);
      const balls: [number, number, number, number][] = [];
      for (let index = 0; index + 2 < values.length; index += 3) {
        balls.push([values[index]!, values[index + 1]!, 0, values[index + 2]!]);
      }
      body = { type: "balls", balls };
      break;
    }
  }
  built.set(shape, body);
  return body;
}

// ── Silhouettes ────────────────────────────────────────────────────────────────────────────────

const LATHE_DIRECTIONS = 180;
const EDGE_RAYS = 480;
const BALL_RAYS = 160;

/** The outline of a turned profile: the hull of its rings, each seen as an ellipse. */
function latheSilhouette(levels: readonly (readonly [number, number])[], m: Mat3): Point[] {
  const out: Point[] = [];
  // Each ring is y + r·(cos a·X + sin a·Z); seen through m it is c + r·(cos a·p + sin a·q).
  const [px, py] = [m[0]!, m[3]!];
  const [qx, qy] = [m[2]!, m[5]!];
  const [ux, uy] = [m[1]!, m[4]!];
  for (let k = 0; k < LATHE_DIRECTIONS; k += 1) {
    const a = (k / LATHE_DIRECTIONS) * TAU;
    const [dx, dy] = [Math.cos(a), Math.sin(a)];
    const dp = px * dx + py * dy;
    const dq = qx * dx + qy * dy;
    const spread = Math.hypot(dp, dq);
    let best = -Infinity;
    let point: Point = [0, 0];
    for (const [y, r] of levels) {
      const reach = y * (ux * dx + uy * dy) + r * spread;
      if (reach <= best) continue;
      best = reach;
      const [cp, cq] = spread > 1e-12 ? [dp / spread, dq / spread] : [1, 0];
      point = [y * ux + r * (cp * px + cq * qx), y * uy + r * (cp * py + cq * qy)];
    }
    const last = out[out.length - 1];
    if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) > 1e-9) out.push(point);
  }
  return out;
}

/** The far edge of a set of segments along evenly spaced rays from the body's middle. */
function farEdge(segments: readonly number[], rays: number): Point[] {
  const out: Point[] = [];
  for (let ray = 0; ray < rays; ray += 1) {
    const angle = (ray / rays) * TAU;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let far = 0;
    for (let index = 0; index < segments.length; index += 4) {
      const ax = segments[index]!;
      const ay = segments[index + 1]!;
      const ex = segments[index + 2]!;
      const ey = segments[index + 3]!;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (ax * ey - ay * ex) / den;
      if (t <= far) continue;
      const u = (ax * dy - ay * dx) / den;
      if (u >= 0 && u <= 1) far = t;
    }
    if (far > 0) out.push([dx * far, dy * far]);
  }
  return out;
}

function edgesSilhouette(rings: readonly (readonly Vec3[])[], loft: boolean, m: Mat3): Point[] {
  const projected = rings.map((ring) =>
    ring.map((point) => {
      const [x, y] = rotate(m, point);
      return [x, y] as const;
    }),
  );
  if (loft) {
    // Facing straight on, the pillow's two tips meet in the middle: its widest ring is the outline.
    const centre = (ring: readonly Point[]) => {
      let [x, y] = [0, 0];
      for (const point of ring) [x, y] = [x + point[0], y + point[1]];
      return [x / ring.length, y / ring.length] as const;
    };
    const a = centre(projected[0]!);
    const b = centre(projected[projected.length - 1]!);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) {
      let widest = projected[0]!;
      let most = 0;
      for (const ring of projected) {
        let area = 0;
        for (let index = 0; index < ring.length; index += 1) {
          const [x0, y0] = ring[index]!;
          const [x1, y1] = ring[(index + 1) % ring.length]!;
          area += x0 * y1 - x1 * y0;
        }
        if (Math.abs(area) > most) [widest, most] = [ring, Math.abs(area)];
      }
      return [...widest];
    }
  }
  const segments: number[] = [];
  for (let k = 0; k < projected.length; k += 1) {
    const ring = projected[k]!;
    const next = projected[k + 1];
    for (let index = 0; index < ring.length; index += 1) {
      const [ax, ay] = ring[index]!;
      const [bx, by] = ring[(index + 1) % ring.length]!;
      segments.push(ax, ay, bx - ax, by - ay);
      if (next) {
        const [cx, cy] = next[index]!;
        segments.push(ax, ay, cx - ax, cy - ay);
      }
    }
  }
  return farEdge(segments, EDGE_RAYS);
}

/** The outline of overlapping balls: each seen as a disc, read off along rays from their middle. */
function ballsSilhouette(balls: readonly (readonly number[])[], m: Mat3): Point[] {
  const discs = balls.map(([x, y, z, r]) => {
    const [px, py] = rotate(m, [x!, y!, z!]);
    return [px, py, r!] as const;
  });
  let [ox, oy] = [0, 0];
  for (const [x, y] of discs) [ox, oy] = [ox + x, oy + y];
  [ox, oy] = [ox / discs.length, oy / discs.length];
  const out: Point[] = [];
  for (let ray = 0; ray < BALL_RAYS; ray += 1) {
    const a = (ray / BALL_RAYS) * TAU;
    const [dx, dy] = [Math.cos(a), Math.sin(a)];
    let far = 0;
    for (const [x, y, r] of discs) {
      const [rx, ry] = [x - ox, y - oy];
      const along = dx * rx + dy * ry;
      const q = along * along - (rx * rx + ry * ry) + r * r;
      if (q <= 0) continue;
      far = Math.max(far, along + Math.sqrt(q));
    }
    if (far > 0) out.push([ox + dx * far, oy + dy * far]);
  }
  return out;
}

const silhouettes = new Map<string, Point[]>();
const SILHOUETTE_CACHE = 256;

/** The body's outline seen through a turn, in body units around the body's middle. */
export function bodySilhouette(shape: BotMarkBodyShape, turn: BodyTurn): readonly Point[] {
  const key = `${shape} ${turn.yaw} ${turn.pitch} ${turn.roll}`;
  const cached = silhouettes.get(key);
  if (cached) {
    silhouettes.delete(key);
    silhouettes.set(key, cached);
    return cached;
  }
  const m = turnMatrix(turn);
  const body = build(shape);
  let out: Point[];
  switch (body.type) {
    case "lathe":
      out = latheSilhouette(body.levels, m);
      break;
    case "hull":
      out = convexHull(
        body.points.map((point) => {
          const [x, y] = rotate(m, point);
          return [x, y] as const;
        }),
      );
      break;
    case "edges":
      out = edgesSilhouette(body.rings, body.loft, m);
      break;
    case "balls":
      out = ballsSilhouette(body.balls, m);
      break;
  }
  silhouettes.set(key, out);
  if (silhouettes.size > SILHOUETTE_CACHE) {
    const oldest = silhouettes.keys().next().value;
    if (oldest !== undefined) silhouettes.delete(oldest);
  }
  return out;
}

// ── Eyes ───────────────────────────────────────────────────────────────────────────────────────

/** One eye: its outline in eye space (x away from the face's middle, y up) and its centre. */
export type BodyEye = { outline: readonly Point[]; off: Point };

/** The sphere's eye layout the per-body placements scale from. */
const EYE_WIDTH = 0.26;
const EYE_HEIGHT = 0.57;
const EYE_GAP = 0.64;

/**
 * The eyes laid flat on a body's face: each eye's centre is spread by the body's gap and
 * height, its shape scaled by the body's eye width, and both moved down by the body's shift.
 */
export function faceLoops(shape: BotMarkBodyShape, eyes: readonly BodyEye[]): Point[][] {
  const [width, height, gap, shift] = BOT_MARK_BODY_SPECS[shape].eyes;
  const size = width / EYE_WIDTH;
  const spread = gap / EYE_GAP;
  const lift = height / EYE_HEIGHT;
  const down = -Math.sin(shift);
  return eyes.map(({ outline, off: [ox, oy] }, index) => {
    const side = index === 0 ? -1 : 1;
    const cx = side * (EYE_GAP / 2 + ox) * spread;
    const cy = down + oy * lift;
    return outline.map(([x, y]) => [cx + side * (x - ox) * size, cy + (y - oy) * size] as const);
  });
}

const facing = (m: Mat3, [x, y, z]: Vec3) => m[6]! * x + m[7]! * y + m[8]! * z;
const flat = (m: Mat3, point: Vec3): Point => {
  const [x, y] = rotate(m, point);
  return [x, y];
};

/** Linear lookup of a profile's radius at height `y` (profiles run top to bottom). */
function radiusAt(levels: readonly (readonly [number, number])[], y: number): number {
  const top = levels[0]![0];
  const bottom = levels[levels.length - 1]![0];
  if (y >= top) return Math.max(0.02, levels[0]![1]);
  if (y <= bottom) return Math.max(0.02, levels[levels.length - 1]![1]);
  let low = 0;
  let high = levels.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (levels[mid]![0] >= y) low = mid;
    else high = mid;
  }
  const [ya, ra] = levels[low]!;
  const [yb, rb] = levels[high]!;
  return Math.max(0.02, ra + ((rb - ra) * (y - ya)) / (yb - ya || 1));
}

/** Keeps every loop's height inside `[low, high]` around `centre` when they fit, moving them all together. */
function fitHeights(loops: Point[][], centre: number, low: number, high: number): Point[][] {
  let [y0, y1] = [Infinity, -Infinity];
  for (const loop of loops) for (const [, y] of loop) [y0, y1] = [Math.min(y0, y), Math.max(y1, y)];
  let move = 0;
  if (y1 - y0 <= high - low) {
    if (centre + y0 < low) move = low - (centre + y0);
    else if (centre + y1 > high) move = high - (centre + y1);
  }
  return move === 0 ? loops : loops.map((loop) => loop.map(([x, y]) => [x, y + move] as const));
}

/** Eyes wrapped round a body's height, following its radius at each height. */
function wrapEyes(
  loops: Point[][],
  m: Mat3,
  [y0, y1, eyeY]: readonly [number, number, number],
  radius: ((y: number) => number) | number,
): Point[][] {
  const margin = typeof radius === "number" ? 0.06 : 0.02;
  const centre = Math.min(y1 - margin, Math.max(y0 + margin, eyeY));
  const clampY = (y: number) => Math.min(y1, Math.max(y0, y));
  return fitHeights(loops, centre, y0, y1)
    .map((loop) => {
      const out: Point[] = [];
      for (const [x, y] of loop) {
        const at = clampY(centre + y);
        const r = typeof radius === "number" ? radius : radius(at);
        const a = Math.max(-2.6, Math.min(2.6, x / Math.max(0.12, r)));
        const slope =
          typeof radius === "number"
            ? 0
            : -(radius(Math.min(y1, at + 0.012)) - radius(Math.max(y0, at - 0.012))) / 0.024;
        if (facing(m, [Math.sin(a), slope, Math.cos(a)]) >= 0.05) {
          out.push(flat(m, [r * Math.sin(a), at, r * Math.cos(a)]));
        }
      }
      return out;
    })
    .filter((loop) => loop.length > 2);
}

/** The ball a point on the bean's face sits on: the one whose front is nearest the viewer there. */
function ballUnder(balls: readonly (readonly number[])[], x: number, y: number) {
  let chosen = balls[0]!;
  let front = -Infinity;
  let gap = Infinity;
  let inside = false;
  for (const ball of balls) {
    const d = Math.hypot(x - ball[0]!, y - ball[1]!);
    if (d < ball[3]!) {
      const z = ball[2]! + Math.sqrt(ball[3]! ** 2 - d * d);
      if (!inside || z > front) [inside, front, chosen] = [true, z, ball];
    } else if (!inside && d - ball[3]! < gap) [gap, chosen] = [d - ball[3]!, ball];
  }
  return chosen;
}

/** Eyes on the bean: each laid over the ball beneath it, kept on the part that faces the viewer. */
function puffEyes(
  loops: Point[][],
  m: Mat3,
  balls: readonly (readonly number[])[],
  [y0, y1, eyeY]: readonly [number, number, number],
): Point[][] {
  const centre = Math.min(y1 - 0.02, Math.max(y0 + 0.02, eyeY));
  const clampY = (y: number) => Math.min(y1, Math.max(y0, y));
  const ahead = m[8]!;
  return fitHeights(loops, centre, y0, y1)
    .map((loop) => {
      if (loop.length === 0) return [];
      let [sx, sy] = [0, 0];
      for (const [x, y] of loop) [sx, sy] = [sx + x, sy + y];
      const [bx, by, bz, br] = ballUnder(
        balls,
        sx / loop.length,
        clampY(centre + sy / loop.length),
      ) as [number, number, number, number];
      const out: Point[] = [];
      for (const [x, y] of loop) {
        const ex = x - bx;
        const ey = clampY(centre + y) - by;
        const d = Math.hypot(ex, ey);
        let arc = Math.min(d / br, Math.PI - 0.02);
        const [ux, uy] = d > 1e-9 ? [ex / d, ey / d] : [1, 0];
        const side = facing(m, [ux, uy, 0]);
        const lean = (a: number) => side * Math.sin(a) + ahead * Math.cos(a);
        if (lean(arc) < 0.06 && ahead > 0.06) {
          let [low, high] = [0, arc];
          for (let step = 0; step < 20; step += 1) {
            const mid = (low + high) / 2;
            if (lean(mid) >= 0.06) low = mid;
            else high = mid;
          }
          arc = low;
        }
        const out3: Vec3 = [ux * Math.sin(arc), uy * Math.sin(arc), Math.cos(arc)];
        if (facing(m, out3) >= 0.05) {
          const reach = br * Math.sin(arc);
          out.push(flat(m, [bx + ux * reach, by + uy * reach, bz + br * Math.cos(arc)]));
        }
      }
      return out;
    })
    .filter((loop) => loop.length > 2);
}

/** Eyes wrapped round a lying pill, along its length. */
function wrapXEyes(
  loops: Point[][],
  m: Mat3,
  [x0, x1]: readonly [number, number],
  reach: number,
  radius: number,
): Point[][] {
  const radiusAt = (x: number) => {
    const t = Math.abs(x) - reach;
    return t <= 0 ? radius : Math.sqrt(Math.max(0, radius * radius - t * t));
  };
  let [low, high] = [Infinity, -Infinity];
  for (const loop of loops)
    for (const [x] of loop) [low, high] = [Math.min(low, x), Math.max(high, x)];
  let move = 0;
  if (high - low <= x1 - x0) {
    if (low < x0) move = x0 - low;
    else if (high > x1) move = x1 - high;
  }
  return loops
    .map((loop) => {
      const out: Point[] = [];
      for (const [px, py] of loop) {
        const x = Math.min(x1, Math.max(x0, px + move));
        const r = radiusAt(x);
        const a = Math.max(-2.6, Math.min(2.6, py / Math.max(0.12, radius)));
        const slope =
          -(radiusAt(Math.min(x1, x + 0.012)) - radiusAt(Math.max(x0, x - 0.012))) / 0.024;
        if (facing(m, [slope, Math.sin(a), Math.cos(a)]) >= 0.05) {
          out.push(flat(m, [x, r * Math.sin(a), r * Math.cos(a)]));
        }
      }
      return out;
    })
    .filter((loop) => loop.length > 2);
}

const surfaces = new Map<BotMarkBodyShape, (x: number, y: number) => number>();

/** How far a pillow's front stands out at a point of its face. */
function pillowDepth(shape: BotMarkBodyShape, outline: readonly Point[], depth: number) {
  const cached = surfaces.get(shape);
  if (cached) return cached;
  const { cx, cy } = bounds(outline);
  const bins = 180;
  const reach = new Float64Array(bins);
  for (let k = 0; k < bins; k += 1) {
    const a = ((k + 0.5) / bins) * TAU;
    const [dx, dy] = [Math.cos(a), Math.sin(a)];
    let far = 0;
    for (let index = 0; index < outline.length; index += 1) {
      const [ax, ay] = outline[index]!;
      const [bx, by] = outline[(index + 1) % outline.length]!;
      const [ex, ey] = [bx - ax, by - ay];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const [rx, ry] = [ax - cx, ay - cy];
      const t = (rx * ey - ry * ex) / den;
      const u = (rx * dy - ry * dx) / den;
      if (t > far && u >= 0 && u <= 1) far = t;
    }
    reach[k] = far;
  }
  const surface = (x: number, y: number) => {
    const [rx, ry] = [x - cx, y - cy];
    const d = Math.hypot(rx, ry);
    let share = 0;
    if (d >= 1e-8) {
      const at = (((Math.atan2(ry, rx) + TAU) % TAU) / TAU) * bins;
      const index = Math.floor(at) % bins;
      const t = at - Math.floor(at);
      const edge = reach[index]! * (1 - t) + reach[(index + 1) % bins]! * t;
      share = Math.min(1, d / Math.max(1e-8, edge));
    }
    return depth * Math.sqrt(Math.max(0, 1 - share ** (2 / 0.72)));
  };
  surfaces.set(shape, surface);
  return surface;
}

/** Eyes laid on a pillow's front, each flat on the surface where its middle sits. */
function loftEyes(loops: Point[][], m: Mat3, surface: (x: number, y: number) => number): Point[][] {
  if (!(m[8]! >= 0.05)) return [];
  const out: Point[][] = [];
  for (const loop of loops) {
    if (loop.length < 3) continue;
    let [sx, sy] = [0, 0];
    for (const [x, y] of loop) [sx, sy] = [sx + x, sy + y];
    [sx, sy] = [sx / loop.length, sy / loop.length];
    const h = 4e-3;
    const gx = (surface(sx + h, sy) - surface(sx - h, sy)) / (2 * h);
    const gy = (surface(sx, sy + h) - surface(sx, sy - h)) / (2 * h);
    const length = Math.hypot(gx, gy, 1);
    if (facing(m, [-gx / length, -gy / length, 1 / length]) < 0.12) continue;
    const z = surface(sx, sy);
    out.push(loop.map(([x, y]) => flat(m, [x, y, z + (x - sx) * gx + (y - sy) * gy])));
  }
  return out;
}

const profiles = new Map<BotMarkBodyShape, readonly (readonly [number, number])[]>();

function profileOf(shape: BotMarkBodyShape, top: number, bottom: number, radii: string) {
  const cached = profiles.get(shape);
  if (cached) return cached;
  const levels = profile(top, bottom, radii);
  profiles.set(shape, levels);
  return levels;
}

/**
 * A pair of eyes seated on a body and seen through a turn, in body units: on a flat front face,
 * wrapped round the body, laid over its balls, or on a pillow's front. Eyes, or the parts of
 * them, on a side that faces away are left out.
 */
export function bodyEyes(
  shape: BotMarkBodyShape,
  eyes: readonly BodyEye[],
  turn: BodyTurn,
): Point[][] {
  const spec: BotMarkBodySpec = BOT_MARK_BODY_SPECS[shape];
  const m = turnMatrix(turn);
  const loops = faceLoops(shape, eyes);
  switch (spec.kind) {
    case "extrusion":
    case "slab":
    case "crystal":
      if (!(m[8]! > 0.03)) return [];
      return loops
        .filter((loop) => loop.length >= 3)
        .map((loop) => loop.map(([x, y]) => flat(m, [x, y, spec.face])));
    case "revolve": {
      const levels = profileOf(shape, spec.top, spec.bottom, spec.radii);
      return wrapEyes(loops, m, spec.seat.wrap, (y) => radiusAt(levels, y));
    }
    case "pill":
      if ("wrapX" in spec.seat)
        return wrapXEyes(loops, m, spec.seat.wrapX, spec.reach, spec.radius);
      return wrapEyes(loops, m, spec.seat.wrap, spec.radius);
    case "balls": {
      const body = build(shape);
      if (body.type !== "balls") return [];
      return puffEyes(loops, m, body.balls, spec.seat.wrap);
    }
    case "loft":
      return loftEyes(loops, m, pillowDepth(shape, points2(spec.outline), spec.depth));
  }
}
