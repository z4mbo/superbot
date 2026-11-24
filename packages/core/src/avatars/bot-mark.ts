/**
 * The bot mark: a 3D body seen orthographically and drawn as one flat silhouette with two eye
 * holes, written as a single even-odd path in a 192-unit box. The default body is a sphere whose
 * eyes are decals on its surface, so turning it slides them toward the rim and narrows them;
 * shaped bodies turn as solids, so their outline changes as they turn. Nothing is shaded,
 * extruded on screen or layered: depth only ever shows through the outline and the eyes.
 *
 * Every function here is pure. This module draws a mark resting, as still pictures and the first
 * paint of an avatar show it; `bot-mark-animation.ts` adds the frames of every other moment, and
 * a renderer loads it once something on screen moves.
 */

import { bodyEyes, bodySilhouette, bodyTurn, turnStep } from "./bot-mark-bodies.js";
import type { BotMarkBodyShape } from "./bot-mark-body-data.js";
import { BOT_MARK_BODY_SPECS } from "./bot-mark-body-data.js";
import { faceOffsets, faceOutlines } from "./bot-mark-faces.js";
import type { EyeFrame, Point } from "./bot-mark-geometry.js";
import {
  ellipsePath,
  fmt,
  insidePolygon,
  polylinePath,
  rotationMatrix,
  sphereEye,
} from "./bot-mark-geometry.js";
import type { BotMarkMorph } from "./bot-mark-morph.js";
import { pumpkinEyes, pumpkinShape } from "./bot-mark-pumpkin.js";
import { REST_POSE, REST_ZOOM } from "./bot-mark-rest.js";

export type { BotMarkFace } from "./bot-mark-faces.js";
export { BOT_MARK_FACES } from "./bot-mark-faces.js";
export type { BotMarkPoke, BotMarkPokeKind } from "./bot-mark-motion.js";

export const BOT_MARK_BOX = 192;
const CENTER = BOT_MARK_BOX / 2;
/** The body's radius in box units when it rests: a disc 60% of the box. */
export const BOT_MARK_RADIUS = BOT_MARK_BOX * (REST_ZOOM / 2);
/** The part of the box an avatar shows: the resting body fills 92% of the avatar. */
export const BOT_MARK_VIEWBOX = "33.39 33.39 125.22 125.22";

export const BOT_MARK_SHAPES = [
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "tablet",
  "capsule",
  "cylinder",
  "hex",
  "gem",
  "crystal",
  "wedge",
  "shield",
  "dome",
  "arch",
  "cloud",
  "teardrop",
  "leaf",
  "square",
  "sparkle",
  "clover",
  "flower",
  "heart",
  "house",
  "star",
  "pumpkin",
] as const;

export type BotMarkShape = (typeof BOT_MARK_SHAPES)[number];

/** The bodies a bot gets when nobody picked one, chosen by its identity. */
const DEFAULT_SHAPES: readonly BotMarkShape[] = [
  "blob",
  "pebble",
  "squircle",
  "tablet",
  "wedge",
  "hex",
  "cloud",
  "teardrop",
];

export const BOT_MARK_STATES = [
  "idle",
  "working",
  "thinking",
  "waiting",
  "blocked",
  "done",
  "error",
  "asleep",
  "waking",
] as const;

export type BotMarkState = (typeof BOT_MARK_STATES)[number];

export const BOT_MARK_EMOTIONS = [
  "playful",
  "excited",
  "listening",
  "proud",
  "laughing",
  "shy",
  "curious",
  "happy",
] as const;

export type BotMarkEmotion = (typeof BOT_MARK_EMOTIONS)[number];

/** Older names for a body, kept so a saved pick still draws. */
const SHAPE_ALIASES: Record<string, BotMarkShape> = { circle: "blob", sphere: "blob" };

export function isBotMarkShape(value: string | null | undefined): value is BotMarkShape {
  return (BOT_MARK_SHAPES as readonly string[]).includes(value ?? "");
}

/** A stable 32-bit hash, so a bot keeps its body, clip order and blink rhythm everywhere. */
export function botMarkSeed(identity: string): number {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mixSeed(identity: string): number {
  let hash = botMarkSeed(identity) | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 73244475);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * The picked body when it is one of ours, then an Avatar Studio pick (the `::shape_N` index on
 * the bot's colour), else one of the everyday bodies, chosen by the bot's identity.
 */
export function botMarkShapeFor(
  identity: string,
  picked?: string | null,
  studioIndex?: number,
): BotMarkShape {
  if (isBotMarkShape(picked)) return picked;
  const alias = SHAPE_ALIASES[picked ?? ""];
  if (alias) return alias;
  if (studioIndex !== undefined) {
    return BOT_MARK_SHAPES[studioIndex % BOT_MARK_SHAPES.length] ?? "blob";
  }
  return DEFAULT_SHAPES[mixSeed(identity) % DEFAULT_SHAPES.length] ?? "blob";
}

// ── Frames ──────────────────────────────────────────────────────────────────────────────────

/** One drawn moment: how the body is turned, moved, squashed and zoomed, and its two eyes. */
export type BotMarkFrame = {
  /** Pitch, yaw and roll in degrees from facing straight ahead. */
  rotation: readonly [number, number, number];
  /** Offset in body radii, y up. */
  offset: readonly [number, number];
  squash: readonly [number, number];
  /** The point squash holds still: -1 is the bottom of the body, 0 its middle. */
  anchor: number;
  /** The body's diameter as a share of the box. */
  zoom: number;
  /** Each eye's outline in eye space (x away from the face's middle, y up), or none. */
  eyes: readonly [readonly Point[], readonly Point[]] | null;
  /** Each eye's centre in eye space; shaped bodies spread the centres apart by their own gap. */
  eyeOffsets: readonly [Point, Point];
  /** The morph the body is folding into or out of, if any. */
  morph: BotMarkMorph | null;
};

/**
 * A mark at rest: turned aside, eyes open, nothing moving. It is the animation's idle frame with
 * no gaze and no poke, so an avatar first painted with it does not change when the animation
 * takes over.
 */
export function botMarkRestFrame(): BotMarkFrame {
  const [left, right] = faceOutlines("neutral");
  return {
    rotation: [...REST_POSE.rot],
    offset: [...REST_POSE.pos],
    squash: [...REST_POSE.squash],
    anchor: REST_POSE.anchor,
    zoom: REST_POSE.zoom,
    eyes: [[...left], [...right]],
    eyeOffsets: faceOffsets("neutral"),
    morph: null,
  };
}

// ── Path ────────────────────────────────────────────────────────────────────────────────────

/** The sphere's eye frames: centres 18.4° either side of the front, up the surface, x outward. */
const SPHERE_EYES: readonly [EyeFrame, EyeFrame] = /* @__PURE__ */ (() => {
  const s = 0.31535;
  const c = Math.sqrt(1 - s * s);
  return [
    { m: [-s, 0, c], c: [-c, 0, -s], t: [0, 1, 0] },
    { m: [s, 0, c], c: [c, 0, -s], t: [0, 1, 0] },
  ];
})();

/** A drawn mark: the body's outline, and the eye holes cut out of it. */
export type BotMarkDrawing = {
  body: string;
  /** The eye holes, to cut from the body with a mask: they may reach over its edge. */
  eyes: string;
  /** The pumpkin's stem, over the body in two greys of its own: the whole stem, then its cap. */
  stem: readonly { d: string; tone: "stem" | "cap" }[];
  /** How opaque the stem is: it fades as a morph rounds the body off. */
  stemOpacity: number;
  /** How opaque the body is: a thinking body lightens between hops. */
  opacity: number;
  /** Dots a morph adds around the body, drawn behind it in the body's ink. */
  dots: readonly { cx: number; cy: number; r: number; opacity: number }[];
};

/**
 * A frame's outlines in box units, before a morph rounds them: the body (none for a sphere drawn
 * as an ellipse), the eye holes and the pumpkin's stem, with the body's centre and radius.
 */
export type BotMarkOutlines = {
  cx: number;
  cy: number;
  radius: number;
  squash: readonly [number, number];
  body: Point[] | null;
  eyes: Point[][];
  stem: { loops: Point[][]; tone: "stem" | "cap" }[];
};

/** The outlines a frame draws, or none when the body has no size. */
export function botMarkOutlines(shape: BotMarkShape, frame: BotMarkFrame): BotMarkOutlines | null {
  const radius = (frame.zoom * BOT_MARK_BOX) / 2;
  const [sx, sy] = [Math.abs(frame.squash[0]), Math.abs(frame.squash[1])];
  if (radius <= 0 || sx === 0 || sy === 0) return null;
  // Squash holds the anchor still: -1 keeps the bottom of the body where it was.
  const cx = CENTER + frame.offset[0] * radius;
  const cy = CENTER - (frame.anchor * (1 - sy) + frame.offset[1]) * radius;
  const morph = frame.morph && frame.morph.amount > 0 ? frame.morph : null;
  const eyes: Point[][] = [];
  const offsets = frame.eyeOffsets;
  const pair = frame.eyes
    ? [
        { outline: frame.eyes[0], off: offsets[0] },
        { outline: frame.eyes[1], off: offsets[1] },
      ]
    : null;
  // Shaped bodies are drawn on a whole-pixel sprite at least 144 across, then scaled to fit.
  const exact = Math.max(8, Math.round((BOT_MARK_BOX * frame.zoom) / (184 / 256)));
  const sprite = Math.max(exact, 144);
  let outline: Point[] | null = null;
  let stem: BotMarkOutlines["stem"] = [];
  if (shape === "pumpkin") {
    const k = exact / sprite;
    const toBox = ([x, y]: Point): Point => [
      cx + (x - sprite / 2) * k * sx,
      cy + (y - sprite / 2) * k * sy,
    ];
    const turn = bodyTurn(frame.rotation, turnStep(frame.zoom), false);
    const look = pumpkinShape(turn, sprite);
    outline = look.outline.map(toBox);
    if (pair) for (const eye of pumpkinEyes(turn, sprite, look, pair)) eyes.push(eye.map(toBox));
    stem = look.stem.map(({ d, tone }) => ({ loops: d.map((loop) => loop.map(toBox)), tone }));
  } else if (shape === "blob") {
    if (morph) {
      outline = Array.from({ length: 192 }, (_, index) => {
        const a = (index / 192) * Math.PI * 2;
        const [c, s] = [Math.cos(a), Math.sin(a)];
        const r = 1 / Math.hypot(c / (sx * radius), s / (sy * radius));
        return [cx + c * r, cy + s * r] as const;
      });
    }
    if (frame.eyes) {
      const turn = rotationMatrix(frame.rotation);
      frame.eyes.forEach((eyeOutline, side) => {
        const eye = sphereEye(eyeOutline, SPHERE_EYES[side]!, turn);
        if (eye)
          eyes.push(eye.map(([x, y]) => [cx + x * sx * radius, cy - y * sy * radius] as const));
      });
    }
  } else {
    const body3d = shape as BotMarkBodyShape;
    const spec = BOT_MARK_BODY_SPECS[body3d];
    // A body of size 1 is 1.18 body units across the sphere's radius.
    const unit = (spec.size * 0.36 * exact) / 1.18;
    const toBox = ([x, y]: Point): Point => [cx + x * sx * unit, cy - y * sy * unit];
    const turn = bodyTurn(frame.rotation, turnStep(frame.zoom));
    outline = bodySilhouette(body3d, turn).map(toBox);
    if (pair) for (const eye of bodyEyes(body3d, pair, turn)) eyes.push(eye.map(toBox));
  }
  return { cx, cy, radius, squash: [sx, sy], body: outline, eyes, stem };
}

const NO_MORPH = { stemOpacity: 1, opacity: 1, dots: [] } as const;

/** Writes outlines as a drawing's paths, with what a morph adds around them. */
export function botMarkDrawingOf(
  outlines: BotMarkOutlines | null,
  extra: Pick<BotMarkDrawing, "opacity" | "stemOpacity" | "dots"> = NO_MORPH,
): BotMarkDrawing {
  if (!outlines) return { body: "", eyes: "", ...NO_MORPH, stem: [] };
  const { cx, cy, radius, squash, body, eyes, stem } = outlines;
  return {
    body: body ? polylinePath(body) : ellipsePath(cx, cy, squash[0] * radius, squash[1] * radius),
    eyes: eyes.map(polylinePath).join(""),
    stem: stem
      .map(({ loops, tone }) => ({ d: loops.map(polylinePath).join(""), tone }))
      .filter(({ d }) => d !== ""),
    ...extra,
  };
}

/**
 * The drawing of a mark resting, in box units. A renderer fills the body and cuts the eyes out
 * of it with a mask, as the reference does, so an eye reaching over the body's edge only ever
 * removes ink.
 */
export function botMarkRestDrawing(shape: BotMarkShape): BotMarkDrawing {
  return botMarkDrawingOf(botMarkOutlines(shape, botMarkRestFrame()));
}

/**
 * A drawing as one even-odd path, for still pictures drawn without a mask: the body, then each
 * eye as a hole. Eyes that reach over the body's edge are left out of it.
 */
export function botMarkDrawingPath(shape: BotMarkShape, drawing: BotMarkDrawing): string {
  // The sphere's eyes always stay on its disc.
  if (shape === "blob") return drawing.body + drawing.eyes;
  const outline = pathPoints(drawing.body)[0] ?? [];
  const inside = pathPoints(drawing.eyes).filter((eye) =>
    eye.every((point) => insidePolygon(point, outline)),
  );
  return drawing.body + inside.map(polylinePath).join("");
}

function pathPoints(d: string): Point[][] {
  return d
    .split("M")
    .slice(1)
    .map((part) => {
      const numbers = part.match(/-?[\d.]+/g)?.map(Number) ?? [];
      const out: Point[] = [];
      for (let index = 0; index + 1 < numbers.length; index += 2) {
        out.push([numbers[index]!, numbers[index + 1]!]);
      }
      return out;
    });
}

/** The mark resting with open eyes, for still pictures such as pickers and notifications. */

/** The mark resting with open eyes, for still pictures such as pickers and notifications. */
export function botMarkRestPath(shape: BotMarkShape): string {
  return botMarkDrawingPath(shape, botMarkRestDrawing(shape));
}

export { fmt as botMarkNumber };

// ── Ink ─────────────────────────────────────────────────────────────────────────────────────

/** Ink names a mark can take; `neutral` is black on light and white on dark. */
export const BOT_MARK_INKS = [
  "blue",
  "cyan",
  "green",
  "magenta",
  "orange",
  "purple",
  "red",
  "yellow",
  "brown",
  "gray",
  "neutral",
] as const;

export type BotMarkInk = (typeof BOT_MARK_INKS)[number];

const INK_HUES: [Exclude<BotMarkInk, "neutral" | "gray">, number][] = [
  ["red", 354],
  ["orange", 23],
  ["yellow", 35],
  ["brown", 30],
  ["green", 151],
  ["cyan", 172],
  ["blue", 212],
  ["purple", 261],
  ["magenta", 327],
];

/** The picked ink when it is one of ours; else the ink nearest the bot's colour. */
export function botMarkInkFor(picked: string | null | undefined, colorHex: string): BotMarkInk {
  if ((BOT_MARK_INKS as readonly string[]).includes(picked ?? "")) return picked as BotMarkInk;
  if (picked === "violet") return "purple";
  if (picked === "black") return "neutral";
  const match = /^#?([0-9a-f]{6})/i.exec(colorHex);
  if (!match) return "neutral";
  const value = Number.parseInt(match[1]!, 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.12) return max < 0.25 || max > 0.85 ? "neutral" : "gray";
  let hue =
    max === r
      ? ((g - b) / (max - min)) % 6
      : max === g
        ? (b - r) / (max - min) + 2
        : (r - g) / (max - min) + 4;
  hue = (hue * 60 + 360) % 360;
  // Dark oranges read as brown.
  if (hue > 15 && hue < 45 && max < 0.7) return "brown";
  let best: BotMarkInk = "blue";
  let distance = Infinity;
  for (const [ink, inkHue] of INK_HUES) {
    if (ink === "brown") continue;
    const delta = Math.min(Math.abs(hue - inkHue), 360 - Math.abs(hue - inkHue));
    if (delta < distance) {
      distance = delta;
      best = ink;
    }
  }
  return best;
}

/**
 * Maps a status Superbot knows to the look that shows it. A bot whose computer sleeps, or that
 * cannot be reached, shows the sleeping look.
 */
export function botMarkStateFor(status: string | null | undefined): BotMarkState {
  switch (status) {
    case "queued":
    case "leased":
    case "running":
      return "working";
    case "waiting_input":
    case "waiting_takeover":
      return "waiting";
    case "failed":
      return "error";
    case "blocked":
      return "blocked";
    case "succeeded":
    case "completed":
      return "done";
    case "asleep":
    case "sleeping":
    case "hibernated":
    case "offline":
      return "asleep";
    case "waking":
    case "starting":
      return "waking";
    default:
      return "idle";
  }
}
