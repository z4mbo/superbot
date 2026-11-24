/**
 * How a bot mark moves: short keyframed clips turn, shift, squash and zoom the body and change
 * its face; each state plays its clips in a seeded order, and a click adds a spin, a bounce or a
 * nod on top. Every function is pure: it answers for a time, so any renderer can draw a frame.
 */
import type { BotMarkFace } from "./bot-mark-faces.js";
import { botMarkFaceNamed } from "./bot-mark-faces.js";
import { cubicEase } from "./bot-mark-geometry.js";

type Key = readonly number[];

/**
 * A clip: keys are `[seconds, ...values]`. `rot` is pitch, yaw and roll in degrees from facing
 * straight ahead, `pos` moves the body in radii (y up), `squash` scales x and y about `anchor`
 * (-1 is the bottom, 0 the middle), `zoom` is the body's diameter as a share of the box, `faces`
 * changes the face, and `blinks` are moments the eyes blink.
 */
export type BotMarkClip = {
  duration: number;
  anchor?: number;
  rot?: readonly Key[];
  pos?: readonly Key[];
  squash?: readonly Key[];
  zoom?: readonly Key[];
  lids?: readonly Key[];
  faces?: readonly (readonly [number, string])[];
  blinks?: readonly number[];
};

/** The pose a body holds when nothing plays: turned up and to the right, as if glancing aside. */
export const REST_ROTATION = [-15.9, 33.3, 25.4] as const;
/** The body's diameter as a share of the box. */
export const REST_ZOOM = 0.6;

// Superbot's clips, written to move the way the reference's do at the same moments.
const CLIPS = {
  idle: {
    duration: 4,
    rot: [
      [0.9, 0, 0, 0],
      [1.62, 0.1, -8.7, -2.5],
      [2.49, 1, 5.7, 1.7],
      [3.46, 0, 0, 0],
    ],
    zoom: [
      [0, 0.6],
      [1.61, 0.64],
      [3.84, 0.6],
    ],
    blinks: [1.48, 3.46],
  },
  idleLook: {
    duration: 6,
    pos: [
      [0.49, 0, 0],
      [1.38, -0.15, 0.03],
      [1.78, -0.15, 0.03],
      [2.75, -0.07, -0.17],
      [2.93, -0.07, -0.17],
      [4.08, 0, 0],
    ],
    rot: [
      [0.49, 0, 0, 0],
      [1.38, -16.1, -32.7, -11],
      [1.78, -13.5, -31.7, -11.6],
      [2.75, 10.4, 13.6, 10.7],
      [2.93, 22.8, 5.3, 5.2],
      [4.08, -24.9, 31.8, 15.1],
      [5.75, 0, 360, 0],
    ],
    blinks: [1.16, 4],
  },
  idleGlance: {
    duration: 6,
    rot: [
      [0, -15.9, 33.3, 25.4],
      [0.59, -34.3, 16.9, 15.1],
      [1.08, -34.3, 16.9, 15.1],
      [1.96, -6.2, 3.1, 14.4],
      [2.67, -6.2, 3.1, 14.4],
      [3.91, 7.6, 40.4, 25.5],
      [4.79, 7.6, 40.4, 25.5],
      [5.63, -15.9, 33.3, 25.4],
    ],
    blinks: [0.59, 2.07, 2.37, 4.25],
  },
  workSpin: {
    duration: 8,
    pos: [
      [0.49, 0, 0],
      [1.38, -0.15, 0.03],
      [1.78, -0.15, 0.03],
      [2.6, 0.06, 0.04],
      [3.07, -0.02, 0.08],
      [3.43, -0.01, -0.21],
      [4, -0.01, -0.13],
      [5.01, 0, 0],
      [6.3, 0.04, -0.02],
      [6.95, -0.25, 0],
      [7.9, 0, 0],
    ],
    rot: [
      [0.49, 0, 0, 0],
      [1.38, -11, -20.1, -12.9],
      [1.78, -17.5, -18.7, -12.7],
      [2.6, -14.6, 17.2, 9.4],
      [3.18, -24.6, 0.1, -0.8],
      [3.47, -1.1, -1.1, -0.7],
      [4, -147.1, -0.7, -0.4],
      [5.01, -360, 0, 0],
      [6.3, -364.9, 18.6, -0.3],
      [6.95, -366.8, -23.4, -3.3],
      [7.9, -360, 0, 0],
    ],
    faces: [
      [1.78, "surprised"],
      [5.64, "neutral"],
      [6.3, "inspecting"],
      [7.31, "neutral"],
    ],
    blinks: [1.17],
  },
  workInspect: {
    duration: 4.8,
    pos: [
      [0.18, 0, 0],
      [1.41, -0.1, 0],
      [2.75, 0.1, 0],
      [4.78, 0, 0],
    ],
    rot: [
      [0.18, 0, 0, 0],
      [1.41, 1.4, -16.1, -36.1],
      [2.75, -3.8, 16.2, 23.1],
      [3.3, -0.7, 32.1, 23],
      [3.9, 0, -273, 5.8],
      [4.78, 0, -360, 0],
    ],
    zoom: [
      [0.18, 0.6],
      [1.41, 0.42],
      [2.25, 0.53],
      [2.99, 0.62],
      [4.61, 0.6],
    ],
    faces: [
      [0.75, "inspecting"],
      [2.56, "surprised"],
      [3.76, "neutral"],
    ],
  },
  workSway: {
    duration: 5,
    pos: [
      [0.17, -0.07, 0],
      [1.51, 0.03, 0],
      [1.8, -0.07, 0],
      [3.13, 0.03, 0],
      [3.41, -0.07, 0],
      [4.78, 0.03, 0],
      [5, -0.07, 0],
    ],
    rot: [
      [0.17, 22.8, -5.5, -34.9],
      [1.51, 25.8, 8.2, 36.4],
      [1.8, 22.8, -5.5, -34.9],
      [3.13, 25.8, 8.2, 36.4],
      [3.41, 22.8, -5.5, -34.9],
      [4.78, 25.8, 8.2, 36.4],
      [5, 22.8, -5.5, -34.9],
    ],
    faces: [[0, "surprised"]],
  },
  workScan: {
    duration: 5,
    pos: [
      [1.53, 0, 0],
      [2.25, 0.13, 0.09],
      [2.64, 0, 0],
    ],
    rot: [
      [0, 2.5, -24.9, 2.8],
      [0.52, 20.2, -20.6, 22.5],
      [1.53, -21, -21.3, -6.2],
      [2.25, -23.8, 24.8, 18.8],
      [2.64, 8.3, -27.4, -9.5],
      [3.49, 6.3, -0.2, 0.7],
      [4.25, 8.2, 24.7, 10.4],
      [4.97, 2.5, -24.9, 2.8],
    ],
    faces: [[0, "calm"]],
  },
  workLook: {
    duration: 4,
    pos: [
      [0.62, 0, 0],
      [1.42, -0.16, 0],
      [2.27, -0.16, 0.06],
      [3.16, 0, 0],
    ],
    rot: [
      [0.62, -15.9, 33.3, 25.4],
      [1.42, -3, -26.2, -3.3],
      [2.27, -31.6, -3.7, 24.1],
      [2.8, -27.9, 0.7, 5],
      [3.27, -19.3, -17.4, -7],
      [3.84, -10.1, 13, 19.2],
      [3.98, -15.9, 33.3, 25.4],
    ],
    faces: [
      [0.06, "neutral"],
      [2.24, "surprised"],
    ],
  },
  workFlip: {
    duration: 5,
    pos: [
      [0.49, 0, 0],
      [1.38, -0.15, 0.03],
      [1.78, -0.15, 0.03],
      [2.6, 0.06, 0.04],
      [3.07, -0.02, 0.08],
      [3.43, -0.01, -0.21],
      [4, -0.01, -0.13],
      [4.89, 0, 0],
    ],
    rot: [
      [0.49, 0, 0, 0],
      [1.38, -11, -20.1, -12.9],
      [1.78, -17.5, -18.7, -12.7],
      [2.6, -14.6, 17.2, 9.4],
      [3.18, -24.6, 0.1, -0.8],
      [3.47, -1.1, -1.1, -0.7],
      [4, -147.1, -0.7, -0.4],
      [4.89, -360, 0, 0],
    ],
    lids: [
      [1.17, 0],
      [1.28, 1],
      [1.42, 0],
    ],
    faces: [
      [1.85, "surprised"],
      [4.89, "neutral"],
    ],
  },
  stuck: {
    duration: 2.12,
    pos: [
      [0, 0, 0],
      [0.39, 0.02, 0.03],
      [0.75, -0.13, 0.05],
      [0.87, 0, 0.05],
      [1.05, -0.12, 0.04],
      [1.3, 0, 0.05],
      [1.76, 0, 0],
    ],
    rot: [
      [0, 0, 0, 0],
      [0.39, 6.6, 26.3, 6.1],
      [0.75, 4, -14.1, -8.1],
      [0.87, 10.3, 14, 7.5],
      [1.05, 8, -9.3, -8.5],
      [1.3, 10.3, 14, 7.5],
      [1.76, 0, 0, 0],
    ],
    zoom: [
      [0, 0.6],
      [0.39, 0.6],
      [1.15, 0.5],
      [1.9, 0.6],
    ],
    faces: [
      [0.47, "confused"],
      [1.61, "neutral"],
    ],
  },
  sulk: {
    duration: 3,
    pos: [[1.26, 0, -0.22]],
    rot: [[1.26, 22.4, -0.1, -1.3]],
    faces: [[0, "sad"]],
  },
  doze: {
    duration: 1.4,
    pos: [
      [0, -0.1, 0],
      [0.68, 0.07, 0],
      [1.39, -0.1, 0],
    ],
    rot: [
      [0, 22.1, -15.7, -4.7],
      [0.68, 21.9, 11.4, 0.7],
      [1.39, 22.1, -15.7, -4.7],
    ],
    faces: [[0, "sleepy"]],
  },
  cheer: {
    duration: 3.7,
    anchor: -1,
    squash: [
      [0.03, 1, 1],
      [0.17, 1.09, 0.95],
      [0.25, 1, 1.1],
      [0.59, 1, 1],
      [0.71, 1, 1],
      [0.77, 1.09, 0.95],
      [0.99, 1, 1.05],
      [1.2, 1, 1],
      [1.24, 1.02, 0.95],
      [1.37, 1, 1.05],
      [1.57, 1, 1.05],
      [1.72, 1, 1],
    ],
    rot: [
      [0.08, 0, 0, 0],
      [0.59, -30.1, -0.3, 14.2],
      [1.14, -22.6, 6.4, -21.7],
      [1.97, -2.1, 2.8, -1.1],
      [2.27, 0, 0, 0],
    ],
    pos: [
      [0.22, 0, 0],
      [0.41, 0, 0.27],
      [0.77, 0, 0],
      [0.99, 0, 0.27],
      [1.25, 0, 0],
      [1.43, 0, 0.21],
      [1.62, 0, 0],
      [1.69, 0, 0.13],
      [1.84, 0, 0],
      [1.87, 0, 0.08],
      [1.95, 0, 0],
    ],
    faces: [
      [0.54, "happy"],
      [1.1, "neutral"],
    ],
  },
  wiggle: {
    duration: 1.8,
    anchor: -1,
    squash: [
      [0, 1, 1],
      [0.24, 1.12, 0.88],
      [0.46, 0.93, 1.09],
      [0.68, 1.04, 0.97],
      [0.92, 1, 1],
    ],
    faces: [[0.1, "happy"]],
  },
  hop: {
    duration: 2,
    anchor: -1,
    pos: [
      [0, 0, 0],
      [0.38, -0.11, 0.12],
      [0.94, 0.11, 0.16],
      [1.38, 0, -0.17],
      [1.58, 0, 0.02],
      [1.75, 0, -0.09],
      [1.96, 0, 0],
    ],
    rot: [
      [0, 0, 0, 0],
      [0.38, -31.3, -5.5, 13.7],
      [0.94, -30.6, 14.1, -12.7],
      [1.4, 19.4, 0.1, -1.7],
      [1.59, -5, -1.4, -0.1],
      [1.76, 12.9, -1, -1.4],
      [1.96, 0, 0, 0],
    ],
    faces: [
      [0, "happy"],
      [1.19, "neutral"],
    ],
  },
  pose: {
    duration: 4,
    rot: [
      [0, -15.9, 33.3, 25.4],
      [0.62, -15.9, 33.3, 25.4],
      [1.42, -3, -26.2, -3.3],
      [2.27, 20.2, -20.6, 22.5],
      [3.27, -21, -21.2, -6.2],
      [4, -23.8, 24.8, 18.8],
    ],
    faces: [
      [0, "neutral"],
      [1.45, "calm"],
    ],
  },
} satisfies Record<string, BotMarkClip>;

export type BotMarkClipName = keyof typeof CLIPS;

/** What each state plays, and the face it holds over its clips. */
export type BotMarkPlaylist = {
  clips: readonly BotMarkClipName[];
  face?: BotMarkFace;
};

export const BOT_MARK_PLAYLISTS = {
  idle: { clips: ["idle"] },
  working: { clips: ["workSpin", "workInspect", "workSway", "workScan", "workLook", "workFlip"] },
  thinking: { clips: ["idle"], face: "sad" },
  waiting: { clips: ["idleGlance"], face: "calm" },
  blocked: { clips: ["stuck"] },
  drowsy: { clips: ["doze"] },
  done: { clips: ["wiggle", "cheer"], face: "happy" },
  error: { clips: ["sulk"] },
  asleep: { clips: ["idle"], face: "sleepy" },
  waking: { clips: ["idle"], face: "surprised" },
  playful: { clips: ["idleLook"] },
  excited: { clips: ["hop"] },
  listening: { clips: ["idleGlance"], face: "calm" },
  proud: { clips: ["pose"] },
  laughing: { clips: ["wiggle"] },
  shy: { clips: ["idleGlance"], face: "calm" },
  curious: { clips: ["workInspect"], face: "inspecting" },
  happy: { clips: ["cheer"] },
} as const satisfies Record<string, BotMarkPlaylist>;

export type BotMarkPlaylistName = keyof typeof BOT_MARK_PLAYLISTS;

// ── Sampling ────────────────────────────────────────────────────────────────────────────────

const EASE = [0.42, 0, 0.58, 1] as const;
const BRIDGE_EASE = [0.4, 0, 0.2, 1] as const;
/** Seconds a body takes to move from one clip's end into the next clip's start. */
export const BRIDGE_SECONDS = 0.35;
const BLINK_SECONDS = 0.26;

function sample(keys: readonly Key[] | undefined, time: number): number[] | null {
  if (!keys || keys.length === 0) return null;
  const first = keys[0]!;
  if (time <= first[0]!) return first.slice(1);
  const last = keys[keys.length - 1]!;
  if (time >= last[0]!) return last.slice(1);
  let index = 0;
  while (index < keys.length - 2 && keys[index + 1]![0]! <= time) index += 1;
  const a = keys[index]!;
  const b = keys[index + 1]!;
  const t = cubicEase(EASE, (time - a[0]!) / Math.max(b[0]! - a[0]!, 1e-9));
  return a.slice(1).map((value, k) => value + (b[k + 1]! - value) * t);
}

/** A body's pose: rotation in degrees, offset in radii, squash, zoom and how shut the lids are. */
export type BotMarkPose = {
  rot: [number, number, number];
  pos: [number, number];
  squash: [number, number];
  zoom: number;
  lids: number;
  anchor: number;
};

export function clipPose(name: BotMarkClipName, time: number): BotMarkPose {
  const clip: BotMarkClip = CLIPS[name];
  const rot = sample(clip.rot, time);
  const pos = sample(clip.pos, time);
  const squash = sample(clip.squash, time);
  const zoom = sample(clip.zoom, time);
  let lids = sample(clip.lids, time)?.[0] ?? 0;
  for (const at of clip.blinks ?? []) {
    const t = time - at;
    if (t < 0 || t > BLINK_SECONDS) continue;
    const peak = BLINK_SECONDS * 0.45;
    const u = t < peak ? t / peak : 1 - (t - peak) / (BLINK_SECONDS - peak);
    lids = Math.max(lids, cubicEase(EASE, u));
  }
  return {
    rot: rot ? [rot[0]!, rot[1]!, rot[2]!] : [0, 0, 0],
    pos: pos ? [pos[0]!, pos[1]!] : [0, 0],
    squash: squash ? [squash[0]!, squash[1]!] : [1, 1],
    zoom: zoom?.[0] ?? REST_ZOOM,
    lids: Math.min(1, Math.max(0, lids)),
    anchor: clip.anchor ?? 0,
  };
}

/** The face a clip shows at `time`, the one before it, and how far it has blended. */
export function clipFace(
  name: BotMarkClipName,
  time: number,
): { from: BotMarkFace; to: BotMarkFace; since: number } {
  const clip: BotMarkClip = CLIPS[name];
  let from: BotMarkFace = "neutral";
  let to: BotMarkFace = "neutral";
  let since = Infinity;
  for (const [at, face] of clip.faces ?? []) {
    if (at > time) break;
    from = to;
    to = botMarkFaceNamed(face);
    since = time - at;
  }
  return { from, to, since };
}

export function clipDuration(name: BotMarkClipName): number {
  return CLIPS[name].duration;
}

/** Turns `to` by whole turns so it lands nearest `from`, so a body never unwinds a spin. */
function nearestTurn(to: number, from: number): number {
  return to + 360 * Math.round((from - to) / 360);
}

/** Blends two poses, as the body moves from one clip into the next. */
export function blendPose(from: BotMarkPose, to: BotMarkPose, progress: number): BotMarkPose {
  const t = cubicEase(BRIDGE_EASE, Math.min(1, Math.max(0, progress)));
  const mix = (a: number, b: number) => a + (b - a) * t;
  return {
    rot: [0, 1, 2].map((k) => mix(from.rot[k]!, nearestTurn(to.rot[k]!, from.rot[k]!))) as [
      number,
      number,
      number,
    ],
    pos: [mix(from.pos[0], to.pos[0]), mix(from.pos[1], to.pos[1])],
    squash: [mix(from.squash[0], to.squash[0]), mix(from.squash[1], to.squash[1])],
    zoom: mix(from.zoom, to.zoom),
    lids: mix(from.lids, to.lids),
    anchor: t < 0.5 ? from.anchor : to.anchor,
  };
}

function posesDiffer(a: BotMarkPose, b: BotMarkPose): boolean {
  const angle = (x: number, y: number) => Math.abs(((((x - y) % 360) + 540) % 360) - 180);
  return (
    a.rot.some((value, k) => angle(value, b.rot[k]!) >= 4) ||
    Math.abs(a.pos[0] - b.pos[0]) >= 0.015 ||
    Math.abs(a.pos[1] - b.pos[1]) >= 0.015 ||
    Math.abs(a.squash[0] - b.squash[0]) >= 0.02 ||
    Math.abs(a.squash[1] - b.squash[1]) >= 0.02 ||
    Math.abs(a.zoom - b.zoom) >= 0.02
  );
}

/** A small seeded generator, so a bot always plays its clips in its own order. */
function random(seed: number) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cycleOrder(clips: readonly BotMarkClipName[], seed: number, cycle: number) {
  const order = [...clips];
  const next = random(seed ^ Math.imul(cycle + 1, 0x9e3779b9));
  for (let index = order.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(next() * (index + 1));
    [order[index], order[pick]] = [order[pick]!, order[index]!];
  }
  return order;
}

/** One step of a playlist: the clip, the seconds into it, and the pose it starts from. */
export type BotMarkPlay = {
  clip: BotMarkClipName;
  time: number;
  /** The previous clip's last pose while the body is still moving out of it. */
  bridge: { from: BotMarkPose; progress: number } | null;
};

/**
 * Where a playlist is `time` seconds after it began: clips play in seeded rounds, each round a
 * shuffle that never repeats the clip that just ended, with a short move between clips whose
 * poses do not meet. A bot joins its first round partway through, so bots do not move in step.
 */
export function playlistAt(
  clips: readonly BotMarkClipName[],
  time: number,
  seed: number,
): BotMarkPlay {
  const round = clips.reduce((sum, name) => sum + clipDuration(name) + BRIDGE_SECONDS, 0);
  const shifted = Math.max(0, time) + ((seed % 997) / 997) * clipDuration(clips[0]!);
  const cycle = Math.floor(shifted / round);
  const previous = cycleOrder(clips, seed, cycle - 1);
  let order = cycleOrder(clips, seed, cycle);
  if (order.length > 1 && order[0] === previous[previous.length - 1]) {
    order = [order[1]!, order[0]!, ...order.slice(2)];
  }
  let at = shifted - cycle * round;
  let last: BotMarkClipName = previous[previous.length - 1]!;
  for (const name of order) {
    if (at < BRIDGE_SECONDS) {
      const from = clipPose(last, clipDuration(last));
      const progress = at / BRIDGE_SECONDS;
      return {
        clip: name,
        time: 0,
        bridge: posesDiffer(from, clipPose(name, 0)) ? { from, progress } : null,
      };
    }
    at -= BRIDGE_SECONDS;
    const duration = clipDuration(name);
    if (at < duration) return { clip: name, time: at, bridge: null };
    at -= duration;
    last = name;
  }
  const name = order[order.length - 1]!;
  return { clip: name, time: clipDuration(name), bridge: null };
}

// ── Pokes ───────────────────────────────────────────────────────────────────────────────────

export type BotMarkPokeKind = "spin" | "bounce" | "nod";
/** A poke and the seconds since it began; `turns` is how many times a spin goes round. */
export type BotMarkPoke = { kind: BotMarkPokeKind; since: number; turns?: number };

export function pokeSeconds({ kind, turns = 1 }: BotMarkPoke): number {
  return kind === "spin"
    ? 0.9 + 0.4 * (Math.max(1, Math.round(turns)) - 1)
    : kind === "bounce"
      ? 0.62
      : 0.5;
}

const swell = (t: number, from: number, to: number) =>
  t <= from || t >= to ? 0 : Math.sin((Math.PI * (t - from)) / (to - from)) ** 2;

/** What the pokes in flight add: pitch and yaw in degrees, a lift in radii, and a squash. */
export function pokeEffect(pokes: readonly BotMarkPoke[]) {
  let pitch = 0;
  let yaw = 0;
  let lift = 0;
  let sx = 1;
  let sy = 1;
  for (const poke of pokes) {
    const t = Math.min(1, Math.max(0, poke.since / pokeSeconds(poke)));
    if (poke.since < 0 || poke.since > pokeSeconds(poke)) continue;
    if (poke.kind === "spin") {
      yaw += 180 * Math.max(1, Math.round(poke.turns ?? 1)) * (1 - Math.cos(Math.PI * t));
    } else if (poke.kind === "nod") {
      pitch += 16 * swell(t, 0, 1);
    } else {
      const ends = swell(t, 0, 0.18) + swell(t, 0.82, 1);
      const middle = swell(t, 0.18, 0.82);
      lift += 0.3 * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.14) / 0.72)));
      sx *= 1 + 0.08 * ends - 0.04 * middle;
      sy *= 1 - 0.1 * ends + 0.06 * middle;
    }
  }
  return { pitch, yaw, lift, squash: [sx, sy] as const };
}
