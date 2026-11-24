/**
 * How a bot mark moves: short keyframed clips turn, shift, squash and zoom the body and change
 * its face; each state plays its clips in a seeded order, and a click adds a spin, a bounce or a
 * nod on top. Every function is pure: it answers for a time, so any renderer can draw a frame.
 */

import type { BotMarkClip, BotMarkClipKey, BotMarkClipName } from "./bot-mark-clips.js";
import type { BotMarkFace } from "./bot-mark-faces.js";
import { botMarkFaceNamed } from "./bot-mark-faces.js";

export type { BotMarkClipName } from "./bot-mark-clips.js";

import { BOT_MARK_CLIPS } from "./bot-mark-clips.js";
import { cubicEase } from "./bot-mark-geometry.js";
import type { BotMarkMorphKind } from "./bot-mark-morph.js";

/** The pose a body holds when nothing plays: turned up and to the right, as if glancing aside. */
export const REST_ROTATION = [-15.9, 33.3, 25.4] as const;
/** The body's diameter as a share of the box. */
export const REST_ZOOM = 0.6;

/** What each state plays, and the face it holds over its clips. */
export type BotMarkPlaylist = {
  clips: readonly BotMarkClipName[];
  face?: BotMarkFace;
  /** A morph the body folds into while the state lasts. */
  morph?: BotMarkMorphKind;
  /** Plays the clips once, in order, and then rests. */
  once?: true;
};

export const BOT_MARK_PLAYLISTS = {
  idle: { clips: ["idle"] },
  working: { clips: ["workSpin", "workInspect", "workSway", "workScan", "workLook", "workFlip"] },
  thinking: { clips: ["idle"], morph: "dots" },
  waiting: { clips: ["idle"], morph: "orbit" },
  blocked: { clips: ["stuck"] },
  drowsy: { clips: ["doze"] },
  done: { clips: ["wiggle", "cheer"], face: "happy", once: true },
  error: { clips: ["sulk"], once: true },
  asleep: { clips: ["idle"], face: "sleepy" },
  waking: { clips: ["idle"], face: "surprised" },
  playful: { clips: ["dance"] },
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

/** A track's values at `time`, eased from each key to the next by that key's own curve. */
function sample(keys: readonly BotMarkClipKey[] | undefined, time: number): number[] | null {
  if (!keys || keys.length === 0) return null;
  const values = (key: BotMarkClipKey) => key.slice(1, -4);
  const first = keys[0]!;
  if (time <= first[0]!) return values(first);
  const last = keys[keys.length - 1]!;
  if (time >= last[0]!) return values(last);
  let index = 0;
  while (index < keys.length - 2 && keys[index + 1]![0]! <= time) index += 1;
  const a = keys[index]!;
  const b = keys[index + 1]!;
  const t = cubicEase(a.slice(-4), (time - a[0]!) / Math.max(b[0]! - a[0]!, 1e-9));
  const to = values(b);
  return values(a).map((value, k) => value + (to[k]! - value) * t);
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
  const clip: BotMarkClip = BOT_MARK_CLIPS[name];
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
  const clip: BotMarkClip = BOT_MARK_CLIPS[name];
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
  return BOT_MARK_CLIPS[name].duration;
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

/**
 * Where a once-through playlist is `time` seconds in: its clips in order with the same short
 * moves between them, or null once the last clip has ended, with when that was.
 */
export function sequenceAt(
  clips: readonly BotMarkClipName[],
  time: number,
): { play: BotMarkPlay | null; ended: number } {
  let at = Math.max(0, time);
  let elapsed = 0;
  let last: BotMarkClipName | null = null;
  for (const name of clips) {
    if (last) {
      const from = clipPose(last, clipDuration(last));
      const moves = posesDiffer(from, clipPose(name, 0));
      if (moves && at < BRIDGE_SECONDS) {
        return {
          play: { clip: name, time: 0, bridge: { from, progress: at / BRIDGE_SECONDS } },
          ended: 0,
        };
      }
      if (moves) {
        at -= BRIDGE_SECONDS;
        elapsed += BRIDGE_SECONDS;
      }
    }
    const duration = clipDuration(name);
    if (at < duration) return { play: { clip: name, time: at, bridge: null }, ended: 0 };
    at -= duration;
    elapsed += duration;
    last = name;
  }
  return { play: null, ended: elapsed };
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
