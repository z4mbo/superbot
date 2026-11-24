/**
 * Morphs: a thinking bot folds its body into the middle one of three bouncing dots, and a waiting
 * bot folds into a small dot with five more circling it. The body's outline rounds into a disc
 * and shrinks; the face goes once the body is half way there; the extra dots grow out beside it.
 *
 * Positions here are on the reference's mark layout, centred at `MORPH_MARK_CENTRE` with the
 * resting body's radius 0.6 of that, which a renderer scales onto its box.
 */
import type { Point } from "./bot-mark-geometry.js";

export type BotMarkMorphKind = "dots" | "orbit";

/** A morph at one moment: how far in it is (0 to 1) and how long it has run. */
export type BotMarkMorph = {
  kind: BotMarkMorphKind;
  amount: number;
  /** Seconds since the morph began. */
  clock: number;
  reducedMotion?: boolean;
};

/** A filled dot beside the body, on the morph layout. */
export type BotMarkMorphDot = { cx: number; cy: number; r: number; opacity: number };

/** The middle of the morph layout; the resting body's radius is 0.6 of it. */
export const MORPH_MARK_CENTRE = 114.2705;
const MARK = MORPH_MARK_CENTRE;
/** Springs that carry a morph in and out: critically damped, reaching 95% in about a third of a second. */
const STIFFNESS = 14;

const STEP = 1 / 120;
const SETTLED = 4;

/**
 * A morph's progress `seconds` after it began: how far the spring has carried it (0 to 1), and how
 * many seconds of its clip have played, as the morph slows the clip to a stop. The spring is
 * critically damped and stepped every 1/120s, as the reference steps it.
 */
export function morphProgress(seconds: number, stiffness = STIFFNESS) {
  const end = Math.min(Math.max(0, seconds), SETTLED);
  let [x, v, clip, at] = [0, 0, 0, 0];
  while (at < end - 1e-9) {
    const dt = Math.min(STEP, end - at);
    clip += dt * (1 - x);
    v += (-2 * stiffness * v - stiffness * stiffness * (x - 1)) * dt;
    x += v * dt;
    at += dt;
  }
  return { amount: x, clipSeconds: clip };
}

/** The share of the way the outline has rounded into a disc. */
export function morphRound(amount: number): number {
  const t = Math.min(1, Math.max(0, amount / 0.62));
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const overshoot = (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const smooth = (t: number) => t * t * (3 - 2 * t);
const wrap = (value: number) => ((value % 1) + 1) % 1;

/** The body's disc radius once folded, and how much the whole mark grows on small avatars. */
const CORE = { dots: 22, orbit: 19 } as const;
const GROW = { dots: 1.5, orbit: 1.14 } as const;

/** One of the three thinking dots at a moment: how high it hops, how big it swells, how dark it is. */
function hop(clock: number, index: number, amount: number, reduced: boolean) {
  const phase = wrap((clock * 1000) / 1400 + 0.119);
  const from = Math.abs(phase - index / 3);
  const gap = Math.min(from, 1 - from);
  const near = reduced ? 1 : Math.exp(-(gap * gap) / 0.045);
  const moving = reduced ? 0 : 1;
  return {
    lift: near * 9 * amount * moving,
    pop: 1 + moving * (0.84 + 0.22 * near - 1),
    tone: 1 - moving * 0.5 * (1 - near),
  };
}

/** The folded body: its scale against the unfolded body, how far it is lifted (256 units, up), and its opacity. */
export function morphCore(morph: BotMarkMorph) {
  const amount = clamp(morph.amount, 0, 1);
  const reduced = morph.reducedMotion ?? false;
  const middle =
    morph.kind === "dots" ? hop(morph.clock, 1, amount, reduced) : { lift: 0, pop: 1, tone: 1 };
  const size = (CORE[morph.kind] / MARK) * middle.pop;
  return {
    /** Scale of the folded disc against the body's own radius, once fully folded. */
    disc: size,
    lift: middle.lift * amount,
    opacity: 1 - (1 - middle.tone) * amount,
    round: morphRound(amount),
  };
}

/** The dots a morph adds around the body, on the morph layout. */
export function morphDots(morph: BotMarkMorph): BotMarkMorphDot[] {
  const amount = clamp(morph.amount, 0, 1);
  const reduced = morph.reducedMotion ?? false;
  const out: BotMarkMorphDot[] = [];
  if (morph.kind === "dots") {
    const across = [MARK - 62, MARK + 62];
    for (let side = 0; side < 2; side += 1) {
      const t = clamp((amount - side * 0.12) / (1 - side * 0.12), 0, 1);
      if (t <= 4e-3) continue;
      const grown = easeOut(t);
      const spread = overshoot(t);
      const bounce = hop(morph.clock, side === 0 ? 0 : 2, amount, reduced);
      out.push({
        cx: MARK + (across[side]! - MARK) * spread,
        cy: MARK - bounce.lift,
        r: 22 * grown * bounce.pop * 1.02,
        opacity: grown * bounce.tone,
      });
    }
  } else {
    const grown = easeOut(amount);
    const reach = 52 * overshoot(amount);
    const turn = morph.clock * 1000 * 0.0017;
    for (let index = 0; index < 5; index += 1) {
      const a = turn + (index * Math.PI * 2) / 5;
      const ahead = Math.cos(a);
      const near = 0.5 + 0.5 * clamp(ahead, 0, 1);
      out.push({
        cx: MARK + reach * Math.sin(a),
        cy: MARK - reach * 0.42 * ahead,
        r: Math.max(12 * near * grown, 0.3),
        opacity: clamp((ahead + 0.4) / 0.6, 0.18, 1) * grown,
      });
    }
  }
  return out.filter((dot) => dot.opacity > 0);
}

/**
 * How much the whole mark grows while morphed, for an avatar `pixels` across: fully on avatars
 * up to 44px, fading out by 134px, so the dots stay legible where the mark is small.
 */
export function morphZoom(morph: BotMarkMorph | null, pixels: number): number {
  if (!morph) return 1;
  const fade = 1 - smooth(clamp((pixels - 44) / 90, 0, 1));
  return 1 + (GROW[morph.kind] - 1) * clamp(morph.amount, 0, 1) * fade;
}

/** The point on the morph layout the morph grows about. */
export const MORPH_ZOOM_ORIGIN = 114.5;

/** Where a ray from `centre` at `angle` last leaves an outline, or NaN when it misses. */
function reachAlong(outline: readonly Point[], [cx, cy]: Point, angle: number): number {
  const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
  let far = Number.NaN;
  for (let index = 0; index < outline.length; index += 1) {
    const [ax, ay] = outline[index]!;
    const [bx, by] = outline[(index + 1) % outline.length]!;
    const [ex, ey] = [bx - ax, by - ay];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const [rx, ry] = [ax - cx, ay - cy];
    const t = (rx * ey - ry * ex) / den;
    const u = (rx * dy - ry * dx) / den;
    if (t >= 0 && u >= -1e-9 && u <= 1.000000001 && !(t <= far)) far = t;
  }
  return far;
}

const TAU = Math.PI * 2;

/**
 * The outline partway to a disc of radius `radius` about `centre`: both are read off along the
 * same rays (192 even ones and one through every corner of the outline) and blended by `round`.
 */
export function roundOutline(
  outline: readonly Point[],
  centre: Point,
  radius: number,
  round: number,
): Point[] {
  if (round <= 0) return [...outline];
  const angleOf = ([x, y]: Point) => {
    const a = Math.atan2(y - centre[1], x - centre[0]);
    return a < 0 ? a + TAU : a;
  };
  const sorted = [
    ...Array.from({ length: 192 }, (_, index) => (index / 192) * TAU),
    ...outline.map(angleOf),
  ].sort((a, b) => a - b);
  const angles = sorted.filter((a, index) => index === 0 || a - sorted[index - 1]! > 1e-7);
  const reaches = angles.map((a) => reachAlong(outline, centre, a));
  const known = reaches.flatMap((r, index) => (Number.isNaN(r) ? [] : [index]));
  const count = reaches.length;
  const filled = reaches.map((r, index) => {
    if (!Number.isNaN(r) || known.length === 0) return Number.isNaN(r) ? 0 : r;
    const after = known.find((k) => k > index) ?? known[0]! + count;
    const before = [...known].reverse().find((k) => k < index) ?? known[known.length - 1]! - count;
    const t = (index - before) / (after - before);
    return reaches[(before + count) % count]! * (1 - t) + reaches[after % count]! * t;
  });
  return angles.map((a, index) => {
    const r = filled[index]! + (radius - filled[index]!) * round;
    return [centre[0] + Math.cos(a) * r, centre[1] + Math.sin(a) * r] as const;
  });
}
