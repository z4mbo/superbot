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
  faceOffsets,
  faceOutlines,
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
  clipFace,
  clipPose,
  playlistAt,
  pokeEffect,
  sequenceAt,
} from "./bot-mark-motion.js";
import { REST_POSE, REST_ZOOM } from "./bot-mark-rest.js";

const CENTER = BOT_MARK_BOX / 2;

// ── Frames ──────────────────────────────────────────────────────────────────────────────────

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
  let morph: BotMarkMorph | null = null;
  let inspecting = 0;
  let morphStart: BotMarkPose | null = null;
  let spin = 0;
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
    const playlist: BotMarkPlaylist = BOT_MARK_PLAYLISTS[play.name];
    let step: BotMarkPlay | null;
    let start: BotMarkPose | null = null;
    let resting = 0;
    if (playlist.once) {
      // Clips that play once, in order, then leave the body resting.
      const run = sequenceAt(playlist.clips, play.seconds);
      step = run.play;
      resting = play.seconds - run.ended;
    } else if (playlist.morph) {
      // A morph slows the clip to a stop and holds the body near where the morph began.
      step = playlistAt(playlist.clips, morphProgress(play.seconds).clipSeconds, input.seed);
      const first = playlistAt(playlist.clips, 0, input.seed);
      start = clipPose(first.clip, first.time);
    } else {
      step = playlistAt(playlist.clips, play.seconds, input.seed);
    }
    if (step) {
      pose = clipPose(step.clip, step.time);
      if (step.bridge) pose = blendPose(step.bridge.from, pose, step.bridge.progress);
      const held = playlist.face ?? null;
      const face = held
        ? { from: "neutral" as BotMarkFace, to: held, since: play.seconds }
        : clipFace(step.clip, step.time);
      eyes = eyesFor(face, pose.lids);
      eyeOffsets = morphOffsets(face.from, face.to, face.since / FACE_MORPH_SECONDS);
      inspecting = inspectWeight(face.from, face.to, face.since / FACE_MORPH_SECONDS);
    } else {
      const last = playlist.clips[playlist.clips.length - 1]!;
      pose = blendPose(clipPose(last, clipDuration(last)), REST_POSE, resting / BRIDGE_SECONDS);
      eyes = faceOutlines("neutral");
      eyeOffsets = faceOffsets("neutral");
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
  // Folding out of a morph eases its dots away; folding in starts from nothing anyway.
  const morph =
    to.morph ?? (from.morph ? { ...from.morph, amount: from.morph.amount * (1 - t) } : null);
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
