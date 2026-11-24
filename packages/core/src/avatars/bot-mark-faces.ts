/**
 * The faces a bot mark can make: each is a pair of eye shapes in eye space, in units of the
 * body's radius. Switching faces blends the outlines; a blink flattens an eye into a short
 * horizontal pill for a moment instead of shutting it.
 */
import type { EyeShape, Point } from "./bot-mark-geometry.js";
import { cubicEase, eyeLocalOutline, placeEye } from "./bot-mark-geometry.js";

export const BOT_MARK_FACES = [
  "neutral",
  "happy",
  "surprised",
  "sad",
  "sleepy",
  "squinted",
  "calm",
  "inspecting",
  "confused",
] as const;

export type BotMarkFace = (typeof BOT_MARK_FACES)[number];

/** Other names motion clips use for a face. */
const FACE_ALIASES: Record<string, BotMarkFace> = {
  thinking: "sad",
  strange: "inspecting",
  angry: "neutral",
  inspect: "inspecting",
  squint: "squinted",
  idle: "neutral",
  smile: "happy",
  sleep: "sleepy",
};

export function botMarkFaceNamed(name: string): BotMarkFace {
  const key = name.trim().toLowerCase();
  const face = FACE_ALIASES[key] ?? key;
  return (BOT_MARK_FACES as readonly string[]).includes(face) ? (face as BotMarkFace) : "neutral";
}

/** A pill `width` across and `height` tall, leaning `angle` degrees from upright. */
function pill(width: number, height: number, angle: number, offX: number): EyeShape {
  const reach = Math.max(0, (height - width) / 2);
  const s = Math.sin((angle * Math.PI) / 180) * reach;
  const c = Math.cos((angle * Math.PI) / 180) * reach;
  return {
    spine: [
      [-s, -c],
      [s, c],
    ],
    half: width / 2,
    oval: null,
    off: [offX, 0],
    tilt: 0,
    lid: 1,
  };
}

/** A curved stroke through three points: a circular arc, or the parabola they span. */
function curve(off: Point, half: number, p0: Point, p1: Point, p2: Point, arc: boolean): EyeShape {
  const spine: Point[] = [];
  const steps = 20;
  if (arc) {
    const [ax, ay] = p0;
    const [bx, by] = p1;
    const [cx, cy] = p2;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const ux =
      ((ax * ax + ay * ay) * (by - cy) +
        (bx * bx + by * by) * (cy - ay) +
        (cx * cx + cy * cy) * (ay - by)) /
      d;
    const uy =
      ((ax * ax + ay * ay) * (cx - bx) +
        (bx * bx + by * by) * (ax - cx) +
        (cx * cx + cy * cy) * (bx - ax)) /
      d;
    const r = Math.hypot(ax - ux, ay - uy);
    const start = Math.atan2(ay - uy, ax - ux);
    const end = Math.atan2(cy - uy, cx - ux);
    const mid = Math.atan2(by - uy, bx - ux);
    const full = Math.PI * 2;
    const sweepEnd = (((end - start) % full) + full) % full;
    const sweepMid = (((mid - start) % full) + full) % full;
    const sweep = sweepMid <= sweepEnd ? sweepEnd : sweepEnd - full;
    for (let index = 0; index <= steps; index += 1) {
      const a = start + (sweep * index) / steps;
      spine.push([ux + Math.cos(a) * r, uy + Math.sin(a) * r]);
    }
  } else {
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const u = 1 - t;
      spine.push([
        u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
        u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
      ]);
    }
  }
  return { spine, half, oval: null, off, tilt: 0, lid: 1 };
}

const REST_WIDTH = 0.26;
const ROUND = 0.1305;

/** Each face's eyes, in eye space (x points away from the middle of the face). */
export const BOT_MARK_FACE_EYES: Record<BotMarkFace, readonly [EyeShape, EyeShape]> = (() => {
  const both = (eye: EyeShape) => [eye, eye] as const;
  const dot = (size: number, offX: number) => pill(size, size, 0, offX);
  return {
    neutral: both(pill(REST_WIDTH, 0.57, 0, 0)),
    happy: both(curve([0.03, 0.03], ROUND, [0.16, -0.04], [0, 0.12], [-0.16, -0.04], true)),
    surprised: both(pill(0.42, 0.86, 0, 0.03)),
    inspecting: [dot(0.54, 0.04), dot(0.36, 0.04)],
    sad: both(pill(REST_WIDTH, 0.5, -28, -0.05)),
    sleepy: both(
      curve([0.01, 0], REST_WIDTH / 2, [-0.11, 0.025], [0, -0.05], [0.11, 0.025], false),
    ),
    squinted: both(pill(REST_WIDTH, 0.5, 90, 0.01)),
    calm: both({ spine: [[0, 0]], half: 0, oval: [0.296, 0.247], off: [0.05, 0], tilt: 0, lid: 1 }),
    confused: both(curve([-0.1, 0], ROUND, [0.01, 0.16], [-0.17, 0], [0.01, -0.16], false)),
  };
})();

const outlines = new Map<BotMarkFace, readonly [Point[], Point[]]>();

/** A face's two eye outlines in eye space, ready to wrap onto a body. */
export function faceOutlines(face: BotMarkFace): readonly [Point[], Point[]] {
  const cached = outlines.get(face);
  if (cached) return cached;
  const [left, right] = BOT_MARK_FACE_EYES[face];
  const pair = [
    placeEye(eyeLocalOutline(left), left),
    placeEye(eyeLocalOutline(right), right),
  ] as const;
  outlines.set(face, pair);
  return pair;
}

/** Faces a blink skips: their eyes are already narrow or curved. */
const NO_BLINK = new Set<BotMarkFace>(["sad", "happy", "confused", "squinted", "sleepy", "calm"]);

export const FACE_MORPH_SECONDS = 0.28;
const FACE_EASE = [0.4, 0.06, 0.18, 1] as const;

/** The eyes partway from one face to another. */
export function morphFaces(
  from: BotMarkFace,
  to: BotMarkFace,
  progress: number,
): readonly [Point[], Point[]] {
  if (progress >= 1 || from === to) return faceOutlines(to);
  const t = cubicEase(FACE_EASE, Math.max(0, progress));
  const a = faceOutlines(from);
  const b = faceOutlines(to);
  const blend = (p: Point[], q: Point[]) =>
    p.map(([x, y], index) => [x + (q[index]![0] - x) * t, y + (q[index]![1] - y) * t] as const);
  return [blend(a[0], b[0]), blend(a[1], b[1])];
}

/** How far a blink has the eyes closed, for faces that blink. */
export function canBlink(face: BotMarkFace): boolean {
  return !NO_BLINK.has(face);
}

/** Flattens an eye toward a horizontal pill as wide as it is, 0.42 of that width tall. */
export function blinkEye(outline: readonly Point[], amount: number): Point[] {
  if (amount <= 0) return [...outline];
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of outline) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const w = Math.max(x1 - x0, 1e-4);
  const h = Math.max(y1 - y0, w);
  const tall = h + (w * 0.42 - h) * Math.min(1, amount);
  const eye: EyeShape =
    tall >= w
      ? { ...pill(w, tall, 0, 0), off: [(x0 + x1) / 2, (y0 + y1) / 2] }
      : { ...pill(tall, w, 90, 0), off: [(x0 + x1) / 2, (y0 + y1) / 2] };
  return placeEye(eyeLocalOutline(eye), eye);
}
