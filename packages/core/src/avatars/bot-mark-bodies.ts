/**
 * The 3D bodies behind the bot mark. A body is a loft through rings: a turned profile (stacked
 * circles under its front outline) or a slab (the outline pushed back to a depth, with rounded
 * edges). Seen from any angle it is drawn as its flat silhouette, which is how a capsule shows
 * its rounded side as it turns and a square shows its edge when it spins.
 */
import type { BotMarkBodyShape, BotMarkBodySpec } from "./bot-mark-body-data.js";
import { BOT_MARK_BODY_SPECS } from "./bot-mark-body-data.js";
import type { Mat3, Point, Vec3 } from "./bot-mark-geometry.js";
import { rotate, rotationMatrix } from "./bot-mark-geometry.js";

const RING_POINTS = 48;
const RAYS = 120;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const outlines = new Map<BotMarkBodyShape, Point[]>();

/** A body's front outline in body radii (y up), from its packed polar radii. */
export function bodyOutline(shape: BotMarkBodyShape): readonly Point[] {
  const cached = outlines.get(shape);
  if (cached) return cached;
  const packed = BOT_MARK_BODY_SPECS[shape].outline;
  const count = packed.length / 2;
  const outline: Point[] = [];
  for (let index = 0; index < count; index += 1) {
    const value =
      ALPHABET.indexOf(packed[index * 2]!) * 64 + ALPHABET.indexOf(packed[index * 2 + 1]!);
    const radius = value / 2000;
    const angle = (index / count) * Math.PI * 2;
    outline.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  outlines.set(shape, outline);
  return outline;
}

/** Where a horizontal line crosses an outline: its leftmost and rightmost points. */
function span(outline: readonly Point[], y: number): [number, number] | null {
  let low = Infinity;
  let high = -Infinity;
  for (let index = 0; index < outline.length; index += 1) {
    const [ax, ay] = outline[index]!;
    const [bx, by] = outline[(index + 1) % outline.length]!;
    if (ay <= y === by <= y) continue;
    const x = ax + ((bx - ax) * (y - ay)) / (by - ay);
    low = Math.min(low, x);
    high = Math.max(high, x);
  }
  return low <= high ? [low, high] : null;
}

/** The outline resampled to `count` evenly spaced points, starting at its top. */
function evenly(outline: readonly Point[], count: number): Point[] {
  const lengths = [0];
  for (let index = 1; index <= outline.length; index += 1) {
    const [ax, ay] = outline[index - 1]!;
    const [bx, by] = outline[index % outline.length]!;
    lengths.push(lengths[index - 1]! + Math.hypot(bx - ax, by - ay));
  }
  const total = lengths[outline.length]!;
  let top = 0;
  for (let index = 1; index < outline.length; index += 1) {
    if (outline[index]![1] > outline[top]![1]) top = index;
  }
  const out: Point[] = [];
  let segment = top;
  for (let index = 0; index < count; index += 1) {
    const at = (lengths[top]! + (index / count) * total) % total;
    while (!(lengths[segment]! <= at && at <= lengths[segment + 1]!)) {
      segment = (segment + 1) % outline.length;
    }
    const [ax, ay] = outline[segment]!;
    const [bx, by] = outline[(segment + 1) % outline.length]!;
    const t = (at - lengths[segment]!) / (lengths[segment + 1]! - lengths[segment]! || 1);
    out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
  }
  return out;
}

const rings = new Map<BotMarkBodyShape, Vec3[][]>();

/** The body's rings in body space; neighbouring rings bound the body between them. */
export function bodyRings(shape: BotMarkBodyShape): readonly (readonly Vec3[])[] {
  const cached = rings.get(shape);
  if (cached) return cached;
  const spec: BotMarkBodySpec = BOT_MARK_BODY_SPECS[shape];
  const outline = bodyOutline(shape);
  const out: Vec3[][] = [];
  if (spec.kind.type === "lathe") {
    const sideways = spec.kind.axis === "x";
    const profile = sideways ? outline.map(([x, y]) => [y, x] as const) : outline;
    let low = Infinity;
    let high = -Infinity;
    for (const [, y] of profile) {
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
    const steps = 18;
    for (let step = 0; step <= steps; step += 1) {
      const y = low + (high - low) * (0.5 - 0.5 * Math.cos((Math.PI * step) / steps));
      const [left, right] = span(profile, Math.min(high - 1e-6, Math.max(low + 1e-6, y))) ?? [0, 0];
      const middle = (left + right) / 2;
      const radius = (right - left) / 2;
      const ring: Vec3[] = [];
      for (let index = 0; index < RING_POINTS; index += 1) {
        const a = (index / RING_POINTS) * Math.PI * 2;
        const across = middle + Math.cos(a) * radius;
        const depth = Math.sin(a) * radius * spec.kind.squeeze;
        ring.push(sideways ? [y, across, depth] : [across, y, depth]);
      }
      out.push(ring);
    }
  } else {
    const { depth, bevel } = spec.kind;
    const base = evenly(outline, RING_POINTS);
    const steps = 10;
    for (let step = 0; step <= steps; step += 1) {
      const z = -depth / 2 + depth * (0.5 - 0.5 * Math.cos((Math.PI * step) / steps));
      const over = Math.abs(z) - (depth / 2 - bevel);
      const inset =
        over > 0 && bevel > 0 ? bevel * (1 - Math.sqrt(Math.max(0, 1 - (over / bevel) ** 2))) : 0;
      out.push(
        base.map(([x, y]) => {
          const factor = Math.max(0, 1 - inset / (Math.hypot(x, y) || 1));
          return [x * factor, y * factor, z] as const;
        }),
      );
    }
  }
  rings.set(shape, out);
  return out;
}

/**
 * The turn a body is drawn with. Bodies take the frame's rotation apart into pitch, yaw and roll
 * and put it back together yaw first, and a body turned more than halfway round is drawn from its
 * front again, mirrored: the same way the reference turns its shaped bodies.
 */
export function bodyMatrix(rotation: readonly [number, number, number]): Mat3 {
  let m = rotationMatrix(rotation);
  if (m[8]! < 0) m = [-m[0]!, m[1]!, -m[2]!, -m[3]!, m[4]!, -m[5]!, -m[6]!, m[7]!, -m[8]!];
  const s = Math.max(-1, Math.min(1, -m[6]!));
  const yaw = Math.asin(s);
  const [pitch, roll] =
    Math.abs(s) > 0.999999
      ? [Math.atan2(-m[5]!, m[4]!), 0]
      : [Math.atan2(m[7]!, m[8]!), Math.atan2(m[3]!, m[0]!)];
  const [cx, sx] = [Math.cos(pitch), Math.sin(pitch)];
  const [cy, sy] = [Math.cos(yaw), Math.sin(yaw)];
  const [cz, sz] = [Math.cos(roll), Math.sin(roll)];
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

const silhouettes = new Map<string, Point[]>();
const SILHOUETTE_CACHE = 256;

/**
 * The body's outline as seen through `turn`, in body radii around the body's centre: the far
 * edge of everything between neighbouring rings, found along evenly spaced rays.
 */
export function bodySilhouette(shape: BotMarkBodyShape, turn: Mat3): readonly Point[] {
  const key = `${shape}:${turn.map((value) => value.toFixed(3)).join(",")}`;
  const cached = silhouettes.get(key);
  if (cached) {
    silhouettes.delete(key);
    silhouettes.set(key, cached);
    return cached;
  }
  const projected = bodyRings(shape).map((ring) =>
    ring.map((point) => {
      const [x, y] = rotate(turn, point);
      return [x, y] as const;
    }),
  );
  const edges: number[] = [];
  for (let k = 0; k < projected.length; k += 1) {
    const ring = projected[k]!;
    const next = projected[k + 1];
    for (let index = 0; index < ring.length; index += 1) {
      const [ax, ay] = ring[index]!;
      const [bx, by] = ring[(index + 1) % ring.length]!;
      edges.push(ax, ay, bx - ax, by - ay);
      if (next) {
        const [cx, cy] = next[index]!;
        edges.push(ax, ay, cx - ax, cy - ay);
      }
    }
  }
  const out: Point[] = [];
  for (let ray = 0; ray < RAYS; ray += 1) {
    const angle = (ray / RAYS) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let far = 0;
    for (let index = 0; index < edges.length; index += 4) {
      const ax = edges[index]!;
      const ay = edges[index + 1]!;
      const ex = edges[index + 2]!;
      const ey = edges[index + 3]!;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (ax * ey - ay * ex) / den;
      if (t <= far) continue;
      const u = (ax * dy - ay * dx) / den;
      if (u >= 0 && u <= 1) far = t;
    }
    out.push([dx * far, dy * far]);
  }
  silhouettes.set(key, out);
  if (silhouettes.size > SILHOUETTE_CACHE) {
    const oldest = silhouettes.keys().next().value;
    if (oldest !== undefined) silhouettes.delete(oldest);
  }
  return out;
}

/**
 * Lays a pair of eye outlines (eye space, x pointing away from the middle) onto a body's face,
 * turns them with the body and drops them flat. An eye facing away is left out, and a wrapped
 * eye that crosses the body's side is cut where the side turns away.
 */
export function bodyEyes(
  shape: BotMarkBodyShape,
  eyes: readonly (readonly Point[])[],
  turn: Mat3,
): Point[][] {
  const { seat }: BotMarkBodySpec = BOT_MARK_BODY_SPECS[shape];
  const out: Point[][] = [];
  eyes.forEach((outline, index) => {
    const side = index === 0 ? -1 : 1;
    const placed: { point: Vec3; facing: number }[] = outline.map(([x, y]) => {
      const u = side * (seat.gap + x * seat.scaleX);
      const v = seat.y + y * seat.scaleY;
      if (seat.wrap !== undefined) {
        const a = u / seat.wrap;
        const point: Vec3 = [seat.wrap * Math.sin(a), v, seat.wrap * Math.cos(a)];
        const normal = rotate(turn, [Math.sin(a), 0, Math.cos(a)]);
        return { point: rotate(turn, point), facing: normal[2] };
      }
      return { point: rotate(turn, [u, v, seat.front ?? 0]), facing: turn[8]! };
    });
    const visible: Point[] = [];
    for (let k = 0; k < placed.length; k += 1) {
      const a = placed[k]!;
      const b = placed[(k + 1) % placed.length]!;
      if (a.facing >= 0) visible.push([a.point[0], a.point[1]]);
      if (a.facing >= 0 !== b.facing >= 0) {
        const t = a.facing / (a.facing - b.facing);
        visible.push([
          a.point[0] + (b.point[0] - a.point[0]) * t,
          a.point[1] + (b.point[1] - a.point[1]) * t,
        ]);
      }
    }
    if (visible.length >= 3) out.push(visible);
  });
  return out;
}

/**
 * Keeps eye outlines inside a silhouette made by `bodySilhouette` (evenly spaced rays from the
 * centre): a point past the edge moves in along its ray to just inside it, as the reference's
 * mask trims an eye that reaches over the body's side.
 */
export function keepInside(eyes: readonly Point[][], silhouette: readonly Point[]): Point[][] {
  const count = silhouette.length;
  const reach = silhouette.map(([x, y]) => Math.hypot(x, y));
  return eyes.map((eye) =>
    eye.map(([x, y]) => {
      const at = ((Math.atan2(y, x) / (Math.PI * 2) + 1) % 1) * count;
      const index = Math.floor(at);
      const t = at - index;
      const edge = (reach[index % count]! * (1 - t) + reach[(index + 1) % count]! * t) * 0.985;
      const distance = Math.hypot(x, y);
      return distance > edge
        ? ([(x / distance) * edge, (y / distance) * edge] as const)
        : ([x, y] as const);
    }),
  );
}

/** How far a held gaze turns a body (degrees) and moves it (radii), per unit of gaze. */
export function bodyGaze(shape: BotMarkBodyShape | "sphere") {
  if (shape === "sphere") return { pitch: 14, yaw: 18, x: 0.03, y: 0.024 };
  const spec: BotMarkBodySpec = BOT_MARK_BODY_SPECS[shape];
  const k = spec.gazeScale ?? 1;
  return { pitch: 19 * k, yaw: 26 * k, x: 0.07, y: 0.055 };
}
