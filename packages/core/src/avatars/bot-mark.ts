/**
 * The bot mark: a 3D body seen orthographically and drawn as one flat silhouette with two eye
 * holes, written as a single even-odd path in a 192-unit box. The default body is a sphere whose
 * eyes are decals on its surface, so turning it slides them toward the rim and narrows them;
 * shaped bodies turn as solids, so their outline changes as they turn. Nothing is shaded,
 * extruded on screen or layered: depth only ever shows through the outline and the eyes.
 *
 * Every function here is pure. A renderer asks for the frame of a state at a time and writes the
 * path it returns, once per bot, wherever that bot appears.
 */

import { bodyEyes, bodySilhouette, bodyTurn, turnStep } from "./bot-mark-bodies.js";
import type { BotMarkBodyShape } from "./bot-mark-body-data.js";
import { BOT_MARK_BODY_SPECS } from "./bot-mark-body-data.js";
import type { BotMarkFace } from "./bot-mark-faces.js";
import {
  blinkEye,
  canBlink,
  FACE_MORPH_SECONDS,
  faceOffsets,
  faceOutlines,
  morphFaces,
  morphOffsets,
} from "./bot-mark-faces.js";
import type { EyeFrame, Point } from "./bot-mark-geometry.js";
import {
  ellipsePath,
  fmt,
  insidePolygon,
  polylinePath,
  rotationMatrix,
  sphereEye,
} from "./bot-mark-geometry.js";
import type { BotMarkPlaylistName, BotMarkPoke, BotMarkPose } from "./bot-mark-motion.js";
import {
  BOT_MARK_PLAYLISTS,
  blendPose,
  clipFace,
  clipPose,
  playlistAt,
  pokeEffect,
  REST_ROTATION,
  REST_ZOOM,
} from "./bot-mark-motion.js";
import { pumpkinEyes, pumpkinShape } from "./bot-mark-pumpkin.js";

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
};

/** Where the pointer holds the face: x right and y up, each -1 to 1, and how firmly (0 to 1). */
export type BotMarkGaze = { x: number; y: number; hold: number };

export type BotMarkFrameInput = {
  state: BotMarkState;
  /** Milliseconds since the mark entered this state. */
  time: number;
  seed: number;
  /** The body, so a held gaze turns it as far as that body turns. */
  shape?: BotMarkShape;
  gaze?: BotMarkGaze | null;
  pokes?: readonly BotMarkPoke[];
  emotion?: BotMarkEmotion | null;
};

/** The resting pose: turned up and to the side, eyes open, nothing moving. */
const REST_POSE: BotMarkPose = {
  rot: [...REST_ROTATION],
  pos: [0, 0],
  squash: [1, 1],
  zoom: REST_ZOOM,
  lids: 0,
  anchor: 0,
};

/** A blocked bot dozes off after two minutes; a waking one settles into idle after 1.6s. */
const DOZE_AFTER = 120;
const WAKE_FOR = 1.6;

function playlistFor(
  state: BotMarkState,
  emotion: BotMarkEmotion | null | undefined,
  seconds: number,
) {
  if (emotion) return { name: emotion as BotMarkPlaylistName, seconds };
  if (state === "blocked" && seconds >= DOZE_AFTER) {
    return { name: "drowsy" as const, seconds: seconds - DOZE_AFTER };
  }
  if (state === "waking" && seconds >= WAKE_FOR) return null;
  if (state === "idle") return null;
  return { name: state as BotMarkPlaylistName, seconds };
}

/** How far a held gaze turns a body (degrees) and moves it (body radii), per unit of gaze. */
function gazeTurn(shape: BotMarkShape | undefined) {
  if (shape === undefined || shape === "blob") return { pitch: 14, yaw: 18, x: 0.03, y: 0.024 };
  const k = GAZE_SCALE[shape] ?? 1;
  return { pitch: 19 * k, yaw: 26 * k, x: 0.07, y: 0.055 };
}

/** Bodies that turn less toward a gaze. */
const GAZE_SCALE: Partial<Record<BotMarkShape, number>> = { heart: 0.6, wedge: 0.55 };

function eyesFor(face: { from: BotMarkFace; to: BotMarkFace; since: number }, lids: number) {
  const [left, right] = morphFaces(face.from, face.to, face.since / FACE_MORPH_SECONDS);
  const settled = face.since >= FACE_MORPH_SECONDS;
  if (lids <= 0 || !settled || !canBlink(face.to)) return [left, right] as const;
  return [blinkEye(left, lids), blinkEye(right, lids)] as const;
}

/**
 * The frame for a state `time` ms after it began. An idle mark rests turned aside, and turns to
 * face a held gaze; every other state plays its clips. Pokes (clicks) add a spin, a bounce or a
 * nod on top of either.
 */
export function botMarkFrame(input: BotMarkFrameInput): BotMarkFrame {
  const seconds = Math.max(0, input.time / 1000);
  const play = playlistFor(input.state, input.emotion, seconds);
  let pose: BotMarkPose;
  let eyes: readonly [readonly Point[], readonly Point[]];
  let eyeOffsets: readonly [Point, Point];
  if (!play) {
    pose = REST_POSE;
    const gaze = input.gaze;
    if (gaze && gaze.hold > 0) {
      const turn = gazeTurn(input.shape);
      const h = Math.min(1, gaze.hold);
      const target: [number, number, number] = [-turn.pitch * gaze.y, turn.yaw * gaze.x, 0];
      pose = {
        ...REST_POSE,
        rot: [0, 1, 2].map((k) => REST_POSE.rot[k]! + (target[k]! - REST_POSE.rot[k]!) * h) as [
          number,
          number,
          number,
        ],
        pos: [turn.x * gaze.x * h, turn.y * gaze.y * h],
      };
    }
    eyes = faceOutlines("neutral");
    eyeOffsets = faceOffsets("neutral");
  } else {
    const playlist = BOT_MARK_PLAYLISTS[play.name];
    const step = playlistAt(playlist.clips, play.seconds, input.seed);
    pose = clipPose(step.clip, step.time);
    if (step.bridge) pose = blendPose(step.bridge.from, pose, step.bridge.progress);
    const held = "face" in playlist ? (playlist.face as BotMarkFace) : null;
    const face = held
      ? { from: "neutral" as BotMarkFace, to: held, since: play.seconds }
      : clipFace(step.clip, step.time);
    eyes = eyesFor(face, pose.lids);
    eyeOffsets = morphOffsets(face.from, face.to, face.since / FACE_MORPH_SECONDS);
  }
  const poke = pokeEffect(input.pokes ?? []);
  return {
    rotation: [pose.rot[0] + poke.pitch, pose.rot[1] + poke.yaw, pose.rot[2]],
    offset: [pose.pos[0], pose.pos[1] + poke.lift],
    squash: [pose.squash[0] * poke.squash[0], pose.squash[1] * poke.squash[1]],
    anchor: pose.anchor,
    zoom: pose.zoom,
    eyes,
    eyeOffsets,
  };
}

/** Blends two frames, as a mark moves out of one state into the next. */
export function botMarkBlend(from: BotMarkFrame, to: BotMarkFrame, progress: number): BotMarkFrame {
  const pose = (frame: BotMarkFrame): BotMarkPose => ({
    rot: [...frame.rotation],
    pos: [...frame.offset],
    squash: [...frame.squash],
    zoom: frame.zoom,
    lids: 0,
    anchor: frame.anchor,
  });
  const blended = blendPose(pose(from), pose(to), progress);
  const t = Math.min(1, Math.max(0, progress));
  const eyes =
    from.eyes && to.eyes
      ? ([0, 1].map((side) =>
          from.eyes![side]!.map(
            ([x, y], index) =>
              [
                x + ((to.eyes![side]![index]?.[0] ?? x) - x) * t,
                y + ((to.eyes![side]![index]?.[1] ?? y) - y) * t,
              ] as const,
          ),
        ) as unknown as readonly [Point[], Point[]])
      : to.eyes;
  const eyeOffsets = [0, 1].map((side) => {
    const [ax, ay] = from.eyeOffsets[side]!;
    const [bx, by] = to.eyeOffsets[side]!;
    return [ax + (bx - ax) * t, ay + (by - ay) * t] as const;
  }) as unknown as readonly [Point, Point];
  return {
    rotation: blended.rot,
    offset: blended.pos,
    squash: blended.squash,
    anchor: blended.anchor,
    zoom: blended.zoom,
    eyes,
    eyeOffsets,
  };
}

/** The welcome showcase: each emotion for 1200ms, then 1200ms of rest, round and round. */
export function botMarkShowcaseEmotion(time: number): BotMarkEmotion | null {
  const step = Math.floor(time / 1200);
  if (step % 2 === 1) return null;
  return BOT_MARK_EMOTIONS[(step / 2) % BOT_MARK_EMOTIONS.length] ?? null;
}

// ── Path ────────────────────────────────────────────────────────────────────────────────────

/** The sphere's eye frames: centres 18.4° either side of the front, up the surface, x outward. */
const SPHERE_EYES: readonly [EyeFrame, EyeFrame] = (() => {
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
};

/**
 * The body's outline and its eye holes for a frame, in box units. A renderer fills the body and
 * cuts the eyes out of it with a mask, as the reference does, so an eye reaching over the body's
 * edge only ever removes ink.
 */
export function botMarkDrawing(shape: BotMarkShape, frame: BotMarkFrame): BotMarkDrawing {
  const radius = (frame.zoom * BOT_MARK_BOX) / 2;
  const [sx, sy] = [Math.abs(frame.squash[0]), Math.abs(frame.squash[1])];
  if (radius <= 0 || sx === 0 || sy === 0) return { body: "", eyes: "", stem: [] };
  // Squash holds the anchor still: -1 keeps the bottom of the body where it was.
  const cx = CENTER + frame.offset[0] * radius;
  const cy = CENTER - (frame.anchor * (1 - sy) + frame.offset[1]) * radius;
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
  let body: string;
  let stem: BotMarkDrawing["stem"] = [];
  if (shape === "pumpkin") {
    const k = exact / sprite;
    const toBox = ([x, y]: Point): Point => [
      cx + (x - sprite / 2) * k * sx,
      cy + (y - sprite / 2) * k * sy,
    ];
    const turn = bodyTurn(frame.rotation, turnStep(frame.zoom), false);
    const look = pumpkinShape(turn, sprite);
    body = polylinePath(look.outline.map(toBox));
    if (pair) for (const eye of pumpkinEyes(turn, sprite, look, pair)) eyes.push(eye.map(toBox));
    stem = look.stem.map(({ d, tone }) => ({
      d: d.map((loop) => polylinePath(loop.map(toBox))).join(""),
      tone,
    }));
  } else if (shape === "blob") {
    body = ellipsePath(cx, cy, sx * radius, sy * radius);
    if (frame.eyes) {
      const turn = rotationMatrix(frame.rotation);
      frame.eyes.forEach((outline, side) => {
        const eye = sphereEye(outline, SPHERE_EYES[side]!, turn);
        if (eye)
          eyes.push(eye.map(([x, y]) => [cx + x * sx * radius, cy - y * sy * radius] as const));
      });
    }
  } else {
    const body3d = shape as BotMarkBodyShape;
    const spec = BOT_MARK_BODY_SPECS[body3d];
    // A body of size 1 is 1.18 body units across the sphere's radius, drawn on a whole-pixel sprite.
    const unit = (spec.size * 0.36 * exact) / 1.18;
    const toBox = ([x, y]: Point): Point => [cx + x * sx * unit, cy - y * sy * unit];
    const turn = bodyTurn(frame.rotation, turnStep(frame.zoom));
    body = polylinePath(bodySilhouette(body3d, turn).map(toBox));
    if (pair) for (const eye of bodyEyes(body3d, pair, turn)) eyes.push(eye.map(toBox));
  }
  return { body, eyes: eyes.map(polylinePath).join(""), stem };
}

/**
 * The mark as one even-odd path, for still pictures drawn without a mask: the body, then each eye
 * as a hole. Eyes that reach over the body's edge are left out of it.
 */
export function botMarkPath(shape: BotMarkShape, frame: BotMarkFrame): string {
  const drawing = botMarkDrawing(shape, frame);
  // The sphere's eyes always stay on its disc.
  if (shape === "blob") return drawing.body + drawing.eyes;
  const outline = pathPoints(drawing.body)[0] ?? [];
  const inside = pathPoints(drawing.eyes).filter((eye) =>
    eye.every((point) => insidePolygon(point, outline)),
  );
  return drawing.body + inside.map(polylinePath).join("");
}

/** The corner points of each closed run in a path written as straight lines. */
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
export function botMarkRestPath(shape: BotMarkShape): string {
  return botMarkPath(shape, botMarkFrame({ state: "idle", time: 0, seed: 0, shape }));
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
