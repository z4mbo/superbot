/**
 * How a bot mark moves: the frame of any state at any time, blends between states, the welcome
 * showcase, and the morphs a thinking or waiting body folds into. Every function is pure. It is
 * its own entry, `@rakazo/core/bot-mark-animation`, outside the package barrel: a renderer first
 * paints a mark resting with `bot-mark.ts` alone and loads this once something moves.
 */

import type {
  BotMarkDrawing,
  BotMarkEmotion,
  BotMarkFrame,
  BotMarkShape,
  BotMarkState,
} from "./bot-mark.js";
import {
  BOT_MARK_BOX,
  BOT_MARK_EMOTIONS,
  botMarkDrawingOf,
  botMarkDrawingPath,
  botMarkOutlines,
} from "./bot-mark.js";
import type { BotMarkFace } from "./bot-mark-faces.js";
import {
  blinkEye,
  canBlink,
  FACE_MORPH_SECONDS,
  faceMorphEase,
  inspectEyes,
  inspectWeight,
  morphFaces,
  morphOffsets,
} from "./bot-mark-faces.js";
import type { Point } from "./bot-mark-geometry.js";
import type { BotMarkMorph } from "./bot-mark-morph.js";
import {
  MORPH_MARK_CENTRE,
  MORPH_ZOOM_ORIGIN,
  morphCore,
  morphDots,
  morphProgress,
  morphZoom,
  roundOutline,
} from "./bot-mark-morph.js";
import type {
  BotMarkPlay,
  BotMarkPlaylist,
  BotMarkPlaylistName,
  BotMarkPoke,
  BotMarkPose,
} from "./bot-mark-motion.js";
import {
  BOT_MARK_PLAYLISTS,
  BRIDGE_SECONDS,
  blendPose,
  clipDuration,
  clipEndFace,
  clipFace,
  clipPose,
  clipRestFace,
  playlistAt,
  pokeEffect,
  SWITCH_SECONDS,
  sequenceAt,
} from "./bot-mark-motion.js";
import { REST_POSE, REST_ZOOM } from "./bot-mark-rest.js";

const CENTER = BOT_MARK_BOX / 2;

// ── Frames ──────────────────────────────────────────────────────────────────────────────────

/** Where the pointer holds the face: x right and y up, each -1 to 1, and how firmly (0 to 1). */
export type BotMarkGaze = { x: number; y: number; hold: number };

/**
 * A gaze as it moves: where the face looks now (`x`, `y`, `hold`), where it is headed (`to`) and
 * whether anything still holds it (`held`). Released, the face keeps easing toward its last aim
 * while the hold lets go, so it turns back to rest from where it was looking.
 */
export type BotMarkGazeHold = BotMarkGaze & { to: readonly [number, number]; held: boolean };

export const BOT_MARK_GAZE_REST: BotMarkGazeHold = { x: 0, y: 0, hold: 0, to: [0, 0], held: false };

/**
 * Where the pointer over an avatar's box holds its face: the direction from the mark's middle to
 * the pointer, x right and y up, in half-widths of the mark. Past that reach only the direction
 * counts, so the face turns its full way toward any angle (up, down, aside or a diagonal) and a
 * wide box never pushes it further along one axis than the other.
 */
export function botMarkPointerGaze(
  mark: { left: number; top: number; width: number; height: number },
  pointer: readonly [number, number],
): [number, number] {
  const reach = Math.max(mark.width, 1) * 0.5;
  const x = (pointer[0] - (mark.left + mark.width / 2)) / reach;
  const y = -(pointer[1] - (mark.top + mark.height / 2)) / reach;
  const length = Math.hypot(x, y);
  return length > 1 ? [x / length, y / length] : [x, y];
}

/** Whether a mark in `state` turns to the pointer: a sleeping or waking one does not. */
export function botMarkFollowsPointer(state: BotMarkState): boolean {
  return state !== "asleep" && state !== "waking";
}

/**
 * Aims a gaze at `target`, or releases it with null. A face that was not held at all starts
 * looking straight at the target and only its hold eases in, so the first glance does not sweep.
 */
export function botMarkGazeAim(
  gaze: BotMarkGazeHold,
  target: readonly [number, number] | null,
): BotMarkGazeHold {
  if (!target) return gaze.held ? { ...gaze, held: false } : gaze;
  const x = Math.max(-1, Math.min(1, target[0]));
  const y = Math.max(-1, Math.min(1, target[1]));
  if (gaze.held && gaze.to[0] === x && gaze.to[1] === y) return gaze;
  return gaze.hold === 0
    ? { x, y, hold: 0, to: [x, y], held: true }
    : { ...gaze, to: [x, y], held: true };
}

/** The share of the way a gaze eases each 60th of a second. */
const GAZE_EASE = 0.14;
/** A step never covers more than this, so a mark that missed frames does not leap. */
const GAZE_MAX_STEP = 0.1;

/**
 * Moves a gaze `seconds` on: the face and the hold each close 14% of their distance per 60th of
 * a second, landing exactly once within a thousandth.
 */
export function botMarkGazeStep(gaze: BotMarkGazeHold, seconds: number): BotMarkGazeHold {
  if (botMarkGazeSettled(gaze)) return gaze;
  const k = 1 - (1 - GAZE_EASE) ** (Math.min(Math.max(seconds, 0), GAZE_MAX_STEP) * 60);
  const toward = (from: number, to: number) => {
    const value = from + (to - from) * k;
    return Math.abs(to - value) < 1e-3 ? to : value;
  };
  return {
    ...gaze,
    x: toward(gaze.x, gaze.to[0]),
    y: toward(gaze.y, gaze.to[1]),
    hold: toward(gaze.hold, gaze.held ? 1 : 0),
  };
}

/** Whether a gaze has stopped moving: fully held on its aim, or let go. */
export function botMarkGazeSettled(gaze: BotMarkGazeHold): boolean {
  if (!gaze.held) return gaze.hold === 0;
  return gaze.hold === 1 && gaze.x === gaze.to[0] && gaze.y === gaze.to[1];
}

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
  /**
   * The state began on screen, out of another one. Its first clip then starts from the beginning
   * once the move into it ends (the renderer draws that move, `BRIDGE_SECONDS` long), a bot that
   * stops working keeps playing for `BOT_MARK_IDLE_HOLD` seconds before it rests, and a finished
   * or failed run is shown. A state the mark is first painted in joins its clips partway instead,
   * and a finished or failed run from before then rests.
   */
  entered?: boolean;
  /**
   * The pointer is over the line the mark sits in, which surprises the face (unless the state
   * holds a face of its own); `seconds` since that last began or ended.
   */
  emphasis?: { on: boolean; seconds: number } | null;
};

/** A blocked bot dozes off after two minutes; a waking one settles into idle after 1.6s. */
const DOZE_AFTER = 120;
const WAKE_FOR = 1.6;
/** Seconds a bot that stops working keeps playing its idle clip before it moves to rest. */
export const BOT_MARK_IDLE_HOLD = 1.4;
/** Seconds a finished or failed run is shown before the bot goes idle. */
export const BOT_MARK_SETTLE = 8;

/** What a state plays: a playlist from `seconds` into it, or nothing for a mark at rest. */
function playlistFor(input: BotMarkFrameInput, seconds: number) {
  const { state, emotion, entered = false } = input;
  if (emotion) return { name: emotion as BotMarkPlaylistName, seconds };
  if (state === "blocked" && seconds >= DOZE_AFTER) {
    return { name: "drowsy" as const, seconds: seconds - DOZE_AFTER };
  }
  if (state === "waking" && seconds >= WAKE_FOR) return null;
  if (state === "idle") {
    return entered && seconds < BOT_MARK_IDLE_HOLD + BRIDGE_SECONDS
      ? { name: "idle" as const, seconds }
      : null;
  }
  if (state === "done" || state === "error") {
    if (!entered || seconds >= BOT_MARK_SETTLE + BOT_MARK_IDLE_HOLD + BRIDGE_SECONDS) return null;
  }
  return { name: state as BotMarkPlaylistName, seconds };
}

/**
 * Seconds into a state after which its mark rests and only the pointer, a poke or emphasis moves
 * it; null while it keeps playing.
 */
export function botMarkRestsAfter(state: BotMarkState, entered: boolean): number | null {
  if (state === "idle") return entered ? BOT_MARK_IDLE_HOLD + BRIDGE_SECONDS : 0;
  if (state === "done" || state === "error") {
    return entered ? BOT_MARK_SETTLE + BOT_MARK_IDLE_HOLD + BRIDGE_SECONDS : 0;
  }
  return state === "waking" ? WAKE_FOR : null;
}

/**
 * The idle clip from its beginning after a move into it, then from `end` seconds a move to rest.
 * `at` counts from where the move in began. Out of another clip (`from`, which ended at `at`
 * 0), the move follows the frame that clip holds; out of a state, the renderer draws the move.
 */
function idleThenRest(from: BotMarkPose | null, at: number, end: number): BotMarkPose {
  const lead = from ? SWITCH_SECONDS + BRIDGE_SECONDS : BRIDGE_SECONDS;
  const loop = clipDuration("idle");
  const clipAt = (t: number) => Math.max(0, t - lead) % loop;
  if (from && at < SWITCH_SECONDS) return from;
  if (from && at < lead) {
    return blendPose(from, clipPose("idle", 0), (at - SWITCH_SECONDS) / BRIDGE_SECONDS);
  }
  if (at < end) return clipPose("idle", clipAt(at));
  return blendPose(clipPose("idle", clipAt(end)), REST_POSE, (at - end) / BRIDGE_SECONDS);
}

/** How far a held gaze turns a body (degrees) and moves it (body radii), per unit of gaze. */
function gazeTurn(shape: BotMarkShape | undefined) {
  if (shape === undefined || shape === "blob") return { pitch: 14, yaw: 18, x: 0.03, y: 0.024 };
  const k = GAZE_SCALE[shape] ?? 1;
  return { pitch: 19 * k, yaw: 26 * k, x: 0.07, y: 0.055 };
}

/** Bodies that turn less toward a gaze. */
const GAZE_SCALE: Partial<Record<BotMarkShape, number>> = { heart: 0.6, wedge: 0.55 };

type FaceMove = { from: BotMarkFace; to: BotMarkFace; since: number };

function eyesFor(face: FaceMove, lids: number) {
  const [left, right] = morphFaces(face.from, face.to, face.since / FACE_MORPH_SECONDS);
  const settled = face.since >= FACE_MORPH_SECONDS;
  if (lids <= 0 || !settled || !canBlink(face.to)) return [left, right] as const;
  return [blinkEye(left, lids), blinkEye(right, lids)] as const;
}

/** The face emphasis surprises: it morphs to surprised while held and back to `face` after. */
function emphasized(face: FaceMove, emphasis: BotMarkFrameInput["emphasis"]): FaceMove {
  if (!emphasis) return face;
  const held: BotMarkFace = "surprised";
  if (emphasis.on) return { from: face.to, to: held, since: emphasis.seconds };
  return emphasis.seconds < FACE_MORPH_SECONDS
    ? { from: held, to: face.to, since: emphasis.seconds }
    : face;
}

/**
 * The frame for a state `time` ms after it began. An idle mark rests turned aside, and turns to
 * face a held gaze; every other state plays its clips. Pokes (clicks) add a spin, a bounce or a
 * nod on top of either.
 */
export function botMarkFrame(input: BotMarkFrameInput): BotMarkFrame {
  const seconds = Math.max(0, input.time / 1000);
  const play = playlistFor(input, seconds);
  let pose: BotMarkPose;
  let face: FaceMove = { from: "neutral", to: "neutral", since: Infinity };
  let morph: BotMarkMorph | null = null;
  let morphStart: BotMarkPose | null = null;
  let spin = 0;
  let ownFace = false;
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
  } else {
    const playlist: BotMarkPlaylist = BOT_MARK_PLAYLISTS[play.name];
    const entered = input.entered ?? false;
    // Entered on screen, the first clip starts from its beginning once the move into it ends.
    const clipSeconds =
      entered && !playlist.morph ? Math.max(0, play.seconds - BRIDGE_SECONDS) : play.seconds;
    let step: BotMarkPlay | null;
    let start: BotMarkPose | null = null;
    let resting = 0;
    if (input.state === "idle" && !input.emotion) {
      // Stopping work: the idle clip plays on, then the body moves to rest.
      step = null;
      pose = idleThenRest(null, play.seconds, BOT_MARK_IDLE_HOLD);
    } else if (playlist.once) {
      // Clips that play once, in order; then the idle clip until the run has been shown long
      // enough, and rest.
      const run = sequenceAt(playlist.clips, clipSeconds);
      step = run.play;
      resting = clipSeconds - run.ended;
      const last = playlist.clips[playlist.clips.length - 1]!;
      const end = BOT_MARK_SETTLE + BOT_MARK_IDLE_HOLD - (play.seconds - resting);
      pose = idleThenRest(clipPose(last, clipDuration(last)), resting, end);
      // A face the clips held morphs back once they end.
      if (!step && playlist.face) face = { from: playlist.face, to: "neutral", since: resting };
    } else if (playlist.morph) {
      // A morph slows the clip to a stop and holds the body near where the morph began.
      step = playlistAt(playlist.clips, morphProgress(play.seconds).clipSeconds, input.seed);
      const first = playlistAt(playlist.clips, 0, input.seed);
      start = clipPose(first.clip, first.time);
      pose = REST_POSE;
    } else {
      step = playlistAt(playlist.clips, clipSeconds, input.seed, !entered);
      pose = REST_POSE;
    }
    if (step) {
      pose = clipPose(step.clip, step.time);
      if (step.bridge) pose = blendPose(step.bridge.from, pose, step.bridge.progress);
      const held = playlist.face ?? null;
      ownFace = held !== null;
      // Moving into a clip, the face morphs to the one the clip starts with; a clip that plays
      // again straight after itself keeps the face it ended on.
      face = held
        ? { from: "neutral", to: held, since: play.seconds }
        : step.enter
          ? {
              from: clipEndFace(step.enter.from),
              to: clipRestFace(step.clip),
              since: step.enter.since,
            }
          : clipFace(
              step.clip,
              step.time,
              step.loop ? clipEndFace(step.clip) : clipRestFace(step.clip),
            );
    }
    if (playlist.morph && start) {
      const { amount } = morphProgress(play.seconds);
      // The dots' own clock starts on the frame after the spring does.
      morph = { kind: playlist.morph, amount, clock: Math.max(0, play.seconds - 1 / 60) };
      morphStart = start;
      // A morph spins the body half a turn as it folds; a mark's first fold always turns this way.
      spin = 180 * amount;
    }
  }
  if (!ownFace) face = emphasized(face, input.emphasis);
  const progress = face.since / FACE_MORPH_SECONDS;
  const eyes = eyesFor(face, pose.lids);
  const eyeOffsets = morphOffsets(face.from, face.to, progress);
  const inspecting = inspectWeight(face.from, face.to, progress);
  const poke = pokeEffect(input.pokes ?? []);
  let rotation: [number, number, number] = [
    pose.rot[0] + poke.pitch,
    pose.rot[1] + poke.yaw,
    pose.rot[2],
  ];
  let offset: [number, number] = [pose.pos[0], pose.pos[1] + poke.lift];
  let squash: [number, number] = [pose.squash[0] * poke.squash[0], pose.squash[1] * poke.squash[1]];
  let shown: BotMarkFrame["eyes"] = inspectEyes(eyes, eyeOffsets, rotation[1], inspecting);
  if (morph && morphStart) {
    const keep = 1 - morph.amount;
    const held = morphStart.rot;
    rotation = [0, 1, 2].map((k) => held[k]! + (rotation[k]! - held[k]!) * keep) as [
      number,
      number,
      number,
    ];
    rotation[1] += spin;
    offset = [offset[0] * keep, offset[1] * keep];
    squash = [1 + (squash[0] - 1) * keep, 1 + (squash[1] - 1) * keep];
    if (morph.amount >= 0.5) shown = null;
  }
  return {
    rotation,
    offset,
    squash,
    anchor: pose.anchor,
    zoom: pose.zoom,
    eyes: shown,
    eyeOffsets,
    morph,
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
  // The face morphs into the new state's as the reference's does: faster than the body moves.
  const t = faceMorphEase(Math.max(0, progress) * BRIDGE_SECONDS);
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
  // Folding out of a morph eases its dots away; folding in starts from nothing anyway.
  const morph =
    to.morph ??
    (from.morph
      ? { ...from.morph, amount: from.morph.amount * (1 - Math.min(1, Math.max(0, progress))) }
      : null);
  return {
    rotation: blended.rot,
    offset: blended.pos,
    squash: blended.squash,
    anchor: blended.anchor,
    zoom: blended.zoom,
    eyes: morph && morph.amount >= 0.5 ? null : eyes,
    eyeOffsets,
    morph,
  };
}

/** The welcome showcase: each emotion for 1200ms, then 1200ms of rest, round and round. */
export function botMarkShowcaseEmotion(time: number): BotMarkEmotion | null {
  const step = Math.floor(time / 1200);
  if (step % 2 === 1) return null;
  return BOT_MARK_EMOTIONS[(step / 2) % BOT_MARK_EMOTIONS.length] ?? null;
}

// ── Path ────────────────────────────────────────────────────────────────────────────────────

/** How far the morph layout is scaled to fit the box. */
const MARK_SCALE = (REST_ZOOM * BOT_MARK_BOX) / 2 / MORPH_MARK_CENTRE;
/** The point a morphed mark grows about, in box units. */
export const BOT_MARK_ZOOM_ORIGIN = CENTER + (MORPH_ZOOM_ORIGIN - MORPH_MARK_CENTRE) * MARK_SCALE;

/** How much a morphed mark grows on an avatar `pixels` across, about `BOT_MARK_ZOOM_ORIGIN`. */
export function botMarkZoom(frame: BotMarkFrame, pixels: number): number {
  return morphZoom(frame.morph, pixels);
}

/**
 * The body's outline and its eye holes for a frame, in box units. A renderer fills the body and
 * cuts the eyes out of it with a mask, as the reference does, so an eye reaching over the body's
 * edge only ever removes ink.
 */
export function botMarkDrawing(shape: BotMarkShape, frame: BotMarkFrame): BotMarkDrawing {
  const outlines = botMarkOutlines(shape, frame);
  const morph = frame.morph && frame.morph.amount > 0 ? frame.morph : null;
  if (!outlines || !morph || !outlines.body) return botMarkDrawingOf(outlines);
  // The body rounds into a disc and shrinks about its middle; the dots grow out beside it.
  const { cx, cy, radius } = outlines;
  const core = morphCore(morph);
  const amount = Math.min(1, morph.amount);
  const scale = 1 - amount + (REST_ZOOM / frame.zoom) * core.disc * amount;
  const lift = core.lift * MARK_SCALE;
  const place = ([x, y]: Point): Point => [cx + (x - cx) * scale, cy - lift + (y - cy) * scale];
  const rounded = {
    ...outlines,
    body: roundOutline(outlines.body, [cx, cy], radius, core.round).map(place),
    eyes: outlines.eyes.map((eye) => eye.map(place)),
    stem: outlines.stem.map(({ loops, tone }) => ({
      loops: loops.map((loop) => loop.map(place)),
      tone,
    })),
  };
  return botMarkDrawingOf(rounded, {
    opacity: core.opacity,
    stemOpacity: 1 - core.round,
    dots: morphDots(morph).map((dot) => ({
      cx: CENTER + (dot.cx - MORPH_MARK_CENTRE) * MARK_SCALE,
      cy: CENTER + (dot.cy - MORPH_MARK_CENTRE) * MARK_SCALE,
      r: dot.r * MARK_SCALE,
      opacity: dot.opacity,
    })),
  });
}

/**
 * The mark as one even-odd path, for still pictures drawn without a mask: the body, then each eye
 * as a hole. Eyes that reach over the body's edge are left out of it.
 */
export function botMarkPath(shape: BotMarkShape, frame: BotMarkFrame): string {
  return botMarkDrawingPath(shape, botMarkDrawing(shape, frame));
}
