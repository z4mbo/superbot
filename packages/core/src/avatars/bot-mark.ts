/**
 * The bot mark: one flat body with two eyes cut out of it, drawn as a single even-odd path in a
 * 192-unit box. The body takes 60% of the box. The eyes are decals on a sphere seen head-on, so
 * looking aside slides them toward the edge and narrows them the way a turned head would; nothing
 * is extruded, shaded or drawn in 3D. Every function here is pure: a renderer asks for the frame
 * at a time and writes the path it returns.
 */

export const BOT_MARK_BOX = 192;
const CENTER = BOT_MARK_BOX / 2;
/** The body's radius in box units: a disc 60% of the box. */
export const BOT_MARK_RADIUS = BOT_MARK_BOX * 0.3;
/** The part of the box an avatar shows, so the body fills about 93% of the avatar's size. */
export const BOT_MARK_VIEWBOX = "34 34 124 124";

export const BOT_MARK_SHAPES = [
  "circle",
  "arch",
  "bean",
  "blob",
  "capsule",
  "cloud",
  "clover",
  "crystal",
  "cylinder",
  "dome",
  "egg",
  "flower",
  "gem",
  "heart",
  "hex",
  "house",
  "leaf",
  "pebble",
  "pumpkin",
  "shield",
  "sparkle",
  "square",
  "squircle",
  "star",
  "tablet",
  "teardrop",
  "wedge",
] as const;

export type BotMarkShape = (typeof BOT_MARK_SHAPES)[number];

export const BOT_MARK_STATES = [
  "idle",
  "working",
  "thinking",
  "waiting",
  "blocked",
  "done",
  "error",
  "asleep",
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

type Point = readonly [number, number];

export function isBotMarkShape(value: string | null | undefined): value is BotMarkShape {
  return (BOT_MARK_SHAPES as readonly string[]).includes(value ?? "");
}

/** A stable 32-bit hash, so a bot keeps its shape, blink rhythm and wander everywhere. */
export function botMarkSeed(identity: string): number {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * The picked shape when it is one of ours, then an Avatar Studio pick (the `::shape_N` index on
 * the bot's colour), else the one the bot's identity picks.
 */
export function botMarkShapeFor(
  identity: string,
  picked?: string | null,
  studioIndex?: number,
): BotMarkShape {
  if (isBotMarkShape(picked)) return picked;
  if (studioIndex !== undefined)
    return BOT_MARK_SHAPES[studioIndex % BOT_MARK_SHAPES.length] ?? "circle";
  return BOT_MARK_SHAPES[botMarkSeed(identity) % BOT_MARK_SHAPES.length] ?? "circle";
}

// ── Bodies ──────────────────────────────────────────────────────────────────────────────────

const SAMPLES = 72;

function polar(radius: (theta: number) => number, sx = 1, sy = 1): Point[] {
  return Array.from({ length: SAMPLES }, (_, index) => {
    const theta = (index / SAMPLES) * Math.PI * 2 - Math.PI / 2;
    const r = radius(theta);
    return [Math.cos(theta) * r * sx, Math.sin(theta) * r * sy] as const;
  });
}

function superellipse(power: number, sx = 1, sy = 1, turn = 0): Point[] {
  return Array.from({ length: SAMPLES }, (_, index) => {
    const theta = (index / SAMPLES) * Math.PI * 2;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const x = Math.sign(c) * Math.abs(c) ** (2 / power) * sx;
    const y = Math.sign(s) * Math.abs(s) ** (2 / power) * sy;
    return [
      x * Math.cos(turn) - y * Math.sin(turn),
      x * Math.sin(turn) + y * Math.cos(turn),
    ] as const;
  });
}

/** Corner-cut a polygon until its corners read as soft, then resample it evenly. */
function rounded(points: readonly Point[], passes = 4): Point[] {
  let shape = [...points];
  for (let pass = 0; pass < passes; pass += 1) {
    const next: Point[] = [];
    for (let index = 0; index < shape.length; index += 1) {
      const [ax, ay] = shape[index]!;
      const [bx, by] = shape[(index + 1) % shape.length]!;
      next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
      next.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    shape = next;
  }
  return resample(shape, SAMPLES);
}

function resample(points: readonly Point[], count: number): Point[] {
  const lengths = [0];
  for (let index = 1; index <= points.length; index += 1) {
    const [ax, ay] = points[index - 1]!;
    const [bx, by] = points[index % points.length]!;
    lengths.push(lengths[index - 1]! + Math.hypot(bx - ax, by - ay));
  }
  const total = lengths[points.length]!;
  const out: Point[] = [];
  let segment = 0;
  for (let index = 0; index < count; index += 1) {
    const at = (index / count) * total;
    while (lengths[segment + 1]! < at) segment += 1;
    const [ax, ay] = points[segment]!;
    const [bx, by] = points[(segment + 1) % points.length]!;
    const span = lengths[segment + 1]! - lengths[segment]! || 1;
    const t = (at - lengths[segment]!) / span;
    out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
  }
  return out;
}

function parametric(fn: (t: number) => Point): Point[] {
  const raw = Array.from({ length: 360 }, (_, index) => fn((index / 360) * Math.PI * 2));
  return resample(raw, SAMPLES);
}

const RAW_BODIES: Record<BotMarkShape, () => Point[]> = {
  circle: () => polar(() => 1),
  arch: () =>
    rounded([
      [-0.82, 0.95],
      [-0.82, -0.15],
      [-0.6, -0.7],
      [0, -1],
      [0.6, -0.7],
      [0.82, -0.15],
      [0.82, 0.95],
    ]),
  bean: () =>
    polar(
      (theta) => 1 + 0.1 * Math.cos(2 * theta) - 0.22 * Math.max(0, Math.cos(theta + 0.4)) ** 6,
      1.06,
      0.86,
    ),
  blob: () => polar((theta) => 1 + 0.07 * Math.cos(3 * theta + 0.5) + 0.05 * Math.sin(5 * theta)),
  // Fitted to the reference roster's silhouettes by overlap (scripts/parity), drawn as our own curves.
  capsule: () => superellipse(2.57, 1.144, 0.811, -0.237),
  cloud: () => polar((theta) => 0.84 + 0.12 * Math.abs(Math.cos(2 * theta + 0.2)) ** 0.6, 1, 0.86),
  clover: () =>
    polar((theta) => 0.879 + 0.137 * Math.abs(Math.cos(2 * theta - 0.055)) ** 0.441, 1.116, 0.941),
  crystal: () =>
    rounded(
      [
        [0, -1.08],
        [0.78, -0.3],
        [0.55, 0.9],
        [-0.55, 0.9],
        [-0.78, -0.3],
      ],
      3,
    ),
  cylinder: () => superellipse(7, 0.82, 1),
  dome: () =>
    rounded([
      [-1, 0.7],
      [-0.95, -0.1],
      [-0.6, -0.72],
      [0, -0.92],
      [0.6, -0.72],
      [0.95, -0.1],
      [1, 0.7],
    ]),
  egg: () => parametric((t) => [0.84 * Math.cos(t) * (1 + 0.14 * Math.sin(t)), 1.02 * Math.sin(t)]),
  flower: () => polar((theta) => 0.84 + 0.16 * Math.cos(6 * theta)),
  gem: () =>
    rounded(
      [
        [-0.6, -0.8],
        [0.6, -0.8],
        [1.02, -0.25],
        [0, 1],
        [-1.02, -0.25],
      ],
      3,
    ),
  heart: () =>
    parametric((t) => [
      (16 * Math.sin(t) ** 3) / 16.5,
      -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 15 + 0.15,
    ]),
  hex: () =>
    rounded(
      Array.from({ length: 6 }, (_, index) => {
        const angle = (index / 6) * Math.PI * 2 + Math.PI / 6;
        return [Math.cos(angle) * 1.05, Math.sin(angle) * 1.05] as const;
      }),
      3,
    ),
  house: () =>
    rounded([
      [0, -1.02],
      [0.98, -0.2],
      [0.92, 0.92],
      [-0.92, 0.92],
      [-0.98, -0.2],
    ]),
  leaf: () =>
    parametric((t) => {
      const x = Math.cos(t);
      const y = 0.62 * Math.sin(t) * (1 - 0.25 * Math.cos(t) ** 2);
      const angle = -Math.PI / 4;
      return [
        1.05 * (x * Math.cos(angle) - y * Math.sin(angle)),
        1.05 * (x * Math.sin(angle) + y * Math.cos(angle)),
      ];
    }),
  pebble: () =>
    polar((theta) => 1 + 0.05 * Math.cos(2 * theta + 0.6) + 0.04 * Math.cos(3 * theta), 1.04, 0.9),
  pumpkin: () => polar((theta) => 0.92 + 0.08 * Math.abs(Math.cos(3 * theta)) ** 0.5, 1.1, 0.88),
  shield: () =>
    rounded([
      [-0.92, -0.9],
      [0.92, -0.9],
      [0.92, 0.12],
      [0, 1.02],
      [-0.92, 0.12],
    ]),
  sparkle: () => polar((theta) => 0.62 + 0.42 * Math.abs(Math.cos(2 * theta)) ** 2.4),
  square: () => superellipse(9, 0.92, 0.92),
  squircle: () => superellipse(4, 0.96, 0.96),
  star: () => polar((theta) => 0.74 + 0.3 * ((1 + Math.cos(5 * theta + Math.PI / 2)) / 2) ** 1.6),
  tablet: () => superellipse(6, 0.8, 1),
  teardrop: () =>
    rounded(
      [
        [-0.585, -1.188],
        [0.747, 0.007],
        [-0.42, 0.877],
        [-1.158, -0.027],
      ],
      5,
    ),
  wedge: () =>
    rounded(
      [
        [-0.44, 1.571],
        [1.919, 0.536],
        [-0.055, -0.881],
      ],
      4,
    ),
};

const bodies = new Map<BotMarkShape, Point[]>();

/** A body outline in body units (radius-1 disc for the circle), centred and evened out in size. */
export function botMarkBody(shape: BotMarkShape): readonly Point[] {
  const cached = bodies.get(shape);
  if (cached) return cached;
  const raw = RAW_BODIES[shape]();
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  let area = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const [ax, ay] = raw[index]!;
    const [bx, by] = raw[(index + 1) % raw.length]!;
    area += ax * by - bx * ay;
    minX = Math.min(minX, ax);
    minY = Math.min(minY, ay);
    maxX = Math.max(maxX, ax);
    maxY = Math.max(maxY, ay);
  }
  // Same visual weight as the disc: scale toward its area, but never past 1.12 of its span.
  const areaScale = Math.sqrt((Math.PI * 0.94) / Math.abs(area / 2));
  const span = Math.max(maxX - minX, maxY - minY) / 2;
  const scale = shape === "circle" ? 1 : Math.min(areaScale, 1.12 / span);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const body = raw.map(([x, y]) => [(x - cx) * scale, (y - cy) * scale] as const);
  bodies.set(shape, body);
  return body;
}

// ── Eyes ────────────────────────────────────────────────────────────────────────────────────

/** One eye's look, in body units on the face: its size, a tilt, and whether it is a ∩ smile. */
export type BotMarkEye = { w: number; h: number; tilt?: number; smile?: boolean };

export type BotMarkFrame = {
  /** Where the face looks, as the point it faces on the unit disc (|gaze| ≤ 0.6). */
  gaze: readonly [number, number];
  left: BotMarkEye;
  right: BotMarkEye;
  /** Half the distance between the eyes on the face, in body units. */
  spread: number;
  /** How high the eyes sit on the face, in body units (negative is up). */
  lift: number;
  /** Body squash and stretch, offset in box units, and a tilt in radians. */
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  turn: number;
  /** Both eyes turned together on the face, in radians. */
  roll?: number;
};

export const REST_EYE: BotMarkEye = { w: 0.255, h: 0.56 };
const DOT: BotMarkEye = { w: 0.22, h: 0.22 };
const COMMA_EYE: BotMarkEye = { w: 0.23, h: 0.52 };
const OVAL: BotMarkEye = { w: 0.36, h: 0.2 };
const SLIT: BotMarkEye = { w: 0.38, h: 0.07 };
const SHUT: BotMarkEye = { w: 0.32, h: 0 };
const SMILE: BotMarkEye = { w: 0.36, h: 0.3, smile: true };

const REST: BotMarkFrame = {
  gaze: [0, 0],
  left: REST_EYE,
  right: REST_EYE,
  spread: 0.305,
  lift: -0.05,
  sx: 1,
  sy: 1,
  dx: 0,
  dy: 0,
  turn: 0,
};

const MAX_GAZE = 0.66;
const RESTING_GAZE: [number, number] = [0.32, -0.44];

function clampGaze([x, y]: readonly [number, number], limit = MAX_GAZE): [number, number] {
  const length = Math.hypot(x, y);
  return length > limit ? [(x / length) * limit, (y / length) * limit] : [x, y];
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function mixEye(a: BotMarkEye, b: BotMarkEye, t: number): BotMarkEye {
  return {
    w: mix(a.w, b.w, t),
    h: mix(a.h, b.h, t),
    tilt: mix(a.tilt ?? 0, b.tilt ?? 0, t),
    smile: t < 0.5 ? a.smile : b.smile,
  };
}

/** A blink: the eyes close over 70ms and open over 110ms, `period` apart, offset per bot. */
function blink(eye: BotMarkEye, time: number, seed: number, period: number): BotMarkEye {
  const offset = ((seed % 997) / 997) * period;
  const phase = (time + offset) % period;
  const closing = phase < 70 ? phase / 70 : phase < 180 ? 1 - (phase - 70) / 110 : 0;
  return closing > 0 ? { ...eye, h: eye.h * (1 - smooth(closing)) } : eye;
}

type Key = { at: number; eye: BotMarkEye; gaze: [number, number] };

/** Steps through keyed looks with short eased transitions between them. */
function keyed(keys: readonly Key[], period: number, time: number) {
  const phase = time % period;
  let index = keys.length - 1;
  for (let k = 0; k < keys.length; k += 1) if (keys[k]!.at <= phase) index = k;
  const current = keys[index]!;
  const previous = keys[(index - 1 + keys.length) % keys.length]!;
  const t = smooth(Math.min(1, (phase - current.at) / 160));
  return {
    eye: mixEye(previous.eye, current.eye, t),
    gaze: [
      mix(previous.gaze[0], current.gaze[0], t),
      mix(previous.gaze[1], current.gaze[1], t),
    ] as [number, number],
  };
}

const WORKING_KEYS: Key[] = [
  { at: 0, eye: DOT, gaze: [-0.25, 0.05] },
  { at: 900, eye: SHUT, gaze: [-0.15, 0] },
  { at: 1050, eye: OVAL, gaze: [0.2, -0.1] },
  { at: 2250, eye: SLIT, gaze: [0.05, 0.25] },
  { at: 3250, eye: SHUT, gaze: [0, 0.1] },
  { at: 3400, eye: REST_EYE, gaze: [0.45, -0.38] },
  { at: 4500, eye: DOT, gaze: [0.1, 0] },
];

/**
 * The frame for a state at `time` (ms). `pointer` is where the pointer sits relative to the mark,
 * in body radii (null when there is none); `poke` is the ms since the mark was last clicked.
 */
export function botMarkFrame(input: {
  state: BotMarkState;
  time: number;
  seed: number;
  pointer: readonly [number, number] | null;
  poke?: number | null;
  emotion?: BotMarkEmotion | null;
}): BotMarkFrame {
  const { state, time, seed, pointer } = input;
  // With no pointer over the window, an idle bot glances up and to the side.
  const follow: [number, number] = pointer
    ? clampGaze([pointer[0] * 0.5, pointer[1] * 0.5])
    : RESTING_GAZE;
  let frame: BotMarkFrame;
  if (input.emotion) {
    frame = emotionFrame(input.emotion, time);
  } else if (state === "working") {
    const { eye, gaze } = keyed(WORKING_KEYS, 5200, time + (seed % 2000));
    frame = {
      ...REST,
      gaze,
      left: eye,
      right: eye,
      dx: 4 * Math.sin((time / 1300) * Math.PI * 2),
      sy: 1 + 0.015 * Math.sin((time / 650) * Math.PI * 2),
    };
  } else if (state === "thinking") {
    const drift = Math.sin((time / 2400) * Math.PI * 2);
    const eye = blink({ w: 0.22, h: 0.44 }, time, seed, 4200);
    frame = { ...REST, gaze: [-0.32 + 0.08 * drift, -0.42], left: eye, right: eye };
  } else if (state === "waiting") {
    const eye = blink({ w: 0.3, h: 0.24 }, time, seed, 5200);
    const breath = Math.sin((time / 3200) * Math.PI * 2);
    frame = {
      ...REST,
      gaze: [follow[0] * 0.5, 0.12],
      left: eye,
      right: eye,
      sy: 1 + 0.02 * breath,
    };
  } else if (state === "blocked") {
    const shake =
      Math.sin((time / 90) * Math.PI * 2) * Math.max(0, Math.sin((time / 2600) * Math.PI));
    frame = {
      ...REST,
      gaze: [0, 0.05],
      left: { ...SLIT, w: 0.34, h: 0.1, tilt: 0.35 },
      right: { ...SLIT, w: 0.34, h: 0.1, tilt: -0.35 },
      dx: 2.5 * shake,
    };
  } else if (state === "done") {
    frame = { ...REST, gaze: [0.05, -0.12], left: SMILE, right: SMILE };
  } else if (state === "error") {
    const eye = blink({ w: 0.2, h: 0.26, tilt: 0 }, time, seed, 6000);
    frame = {
      ...REST,
      gaze: [0, 0.32],
      left: { ...eye, tilt: -0.3 },
      right: { ...eye, tilt: 0.3 },
      turn: -0.06,
    };
  } else if (state === "asleep") {
    const breath = Math.sin((time / 4200) * Math.PI * 2);
    frame = {
      ...REST,
      gaze: [0, 0.18],
      left: { w: 0.3, h: 0.04 },
      right: { w: 0.3, h: 0.04 },
      sx: 1 + 0.012 * breath,
      sy: 1 - 0.012 * breath,
    };
  } else {
    // Idle: the face turns to the pointer. Close by, the eyes stand upright ("II"); with the
    // pointer far away they shrink into short commas that lie along the rim.
    const distance = pointer ? Math.hypot(pointer[0], pointer[1]) : Infinity;
    const far = smooth(Math.min(1, Math.max(0, (distance - 1.6) / 2.4)));
    const length = Math.hypot(follow[0], follow[1]);
    const eye = blink(mixEye(REST_EYE, COMMA_EYE, far), time, seed, 4600 + (seed % 2400));
    frame = {
      ...REST,
      gaze: follow,
      left: eye,
      right: eye,
      roll: length > 0.05 ? Math.atan2(follow[1], follow[0]) * 0.66 * far : 0,
    };
  }
  return input.poke != null ? squash(frame, input.poke) : frame;
}

/** A click squashes the body, then it springs back. */
function squash(frame: BotMarkFrame, since: number): BotMarkFrame {
  if (since < 0 || since > 900) return frame;
  const amount = -0.23 * Math.exp(-since / 230) * Math.cos((since / 320) * Math.PI * 2);
  return { ...frame, sx: frame.sx * (1 - amount * 0.5), sy: frame.sy * (1 + amount) };
}

function emotionFrame(emotion: BotMarkEmotion, time: number): BotMarkFrame {
  const wave = Math.sin((time / 600) * Math.PI * 2);
  switch (emotion) {
    case "playful":
      return { ...REST, gaze: [0.25, -0.1], left: SMILE, right: REST_EYE, turn: 0.12 };
    case "excited":
      return {
        ...REST,
        left: { w: 0.33, h: 0.6 },
        right: { w: 0.33, h: 0.6 },
        dy: -6 * Math.abs(wave),
        sy: 1 + 0.04 * Math.abs(wave),
      };
    case "listening":
      return { ...REST, gaze: [0.3, 0], turn: 0.14 };
    case "proud":
      return { ...REST, gaze: [0, -0.3], left: SMILE, right: SMILE, sy: 1.04, sx: 0.98 };
    case "laughing":
      return { ...REST, left: SMILE, right: SMILE, dy: -4 * Math.abs(wave), turn: 0.05 * wave };
    case "shy":
      return {
        ...REST,
        gaze: [-0.35, 0.3],
        left: { w: 0.2, h: 0.36 },
        right: { w: 0.2, h: 0.36 },
      };
    case "curious":
      return {
        ...REST,
        gaze: [0.2, -0.15],
        left: { w: 0.2, h: 0.42 },
        right: REST_EYE,
        turn: -0.1,
      };
    case "happy":
      return { ...REST, left: SMILE, right: SMILE };
  }
}

/** The welcome showcase: each emotion for 1200ms, then 1200ms of idle, round and round. */
export function botMarkShowcaseEmotion(time: number): BotMarkEmotion | null {
  const step = Math.floor(time / 1200);
  if (step % 2 === 1) return null;
  return BOT_MARK_EMOTIONS[(step / 2) % BOT_MARK_EMOTIONS.length] ?? null;
}

// ── Path ────────────────────────────────────────────────────────────────────────────────────

type Vec3 = [number, number, number];

/** Rotation that turns the face (0,0,1) toward the gaze point on the sphere. */
function faceRotation(gaze: readonly [number, number]): (v: Vec3) => Vec3 {
  const [gx, gy] = gaze;
  const gz = Math.sqrt(Math.max(0, 1 - gx * gx - gy * gy));
  const sin = Math.hypot(gx, gy);
  if (sin < 1e-6) return (v) => v;
  // Axis = z × g, normalised; angle with cos = gz.
  const ax = -gy / sin;
  const ay = gx / sin;
  const cos = gz;
  return ([x, y, z]) => {
    const dot = ax * x + ay * y;
    const crossX = ay * z;
    const crossY = -ax * z;
    const crossZ = ax * y - ay * x;
    return [
      x * cos + crossX * sin + ax * dot * (1 - cos),
      y * cos + crossY * sin + ay * dot * (1 - cos),
      z * cos + crossZ * sin,
    ];
  };
}

const EYE_SAMPLES = 28;

function eyeOutline(
  side: -1 | 1,
  eye: BotMarkEye,
  frame: BotMarkFrame,
  rotate: (v: Vec3) => Vec3,
): Point[] | null {
  if (eye.h < 0.012) return null;
  // A rolled face turns the pair of eyes, not just each eye.
  const roll = frame.roll ?? 0;
  const x0 = side * frame.spread * Math.cos(roll) - frame.lift * Math.sin(roll);
  const y0 = side * frame.spread * Math.sin(roll) + frame.lift * Math.cos(roll);
  const z0 = Math.sqrt(Math.max(0, 1 - x0 * x0 - y0 * y0));
  const center = rotate([x0, y0, z0]);
  // Tangent axes at the eye, so its outline foreshortens with the sphere.
  const u = rotate([z0, 0, -x0]);
  const v = rotate([0, 1, 0]);
  const tilt = (eye.tilt ?? 0) * side + (frame.roll ?? 0);
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const local: Point[] = [];
  if (eye.smile) {
    // A ∩: the top of an ellipse, then back along a lower, narrower arc.
    for (let index = 0; index <= EYE_SAMPLES / 2; index += 1) {
      const a = Math.PI + (index / (EYE_SAMPLES / 2)) * Math.PI;
      local.push([(Math.cos(a) * eye.w) / 2, (Math.sin(a) * eye.h) / 2 + eye.h * 0.25]);
    }
    for (let index = EYE_SAMPLES / 2; index >= 0; index -= 1) {
      const a = Math.PI + (index / (EYE_SAMPLES / 2)) * Math.PI;
      local.push([
        (Math.cos(a) * eye.w * 0.62) / 2,
        (Math.sin(a) * eye.h * 0.45) / 2 + eye.h * 0.25,
      ]);
    }
  } else {
    // A pill: a superellipse between an ellipse and a rounded rectangle.
    for (let index = 0; index < EYE_SAMPLES; index += 1) {
      const a = (index / EYE_SAMPLES) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      local.push([
        (Math.sign(c) * Math.abs(c) ** 0.8 * eye.w) / 2,
        (Math.sign(s) * Math.abs(s) ** 0.8 * eye.h) / 2,
      ]);
    }
  }
  return local.map(([lx, ly]) => {
    const x = lx * cosT - ly * sinT;
    const y = lx * sinT + ly * cosT;
    return [center[0] + u[0] * x + v[0] * y, center[1] + u[1] * x + v[1] * y] as const;
  });
}

function inside([px, py]: Point, polygon: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const round = (value: number) => Math.round(value * 10) / 10;

function smoothPath(points: readonly Point[]): string {
  // Quadratic curves through the midpoints keep the outline smooth without extra samples.
  const mid = (a: Point, b: Point) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
  const first = mid(points[points.length - 1]!, points[0]!);
  let d = `M${round(first[0])} ${round(first[1])}`;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const end = mid(point, points[(index + 1) % points.length]!);
    d += `Q${round(point[0])} ${round(point[1])} ${round(end[0])} ${round(end[1])}`;
  }
  return `${d}Z`;
}

/**
 * The single even-odd path for a body and a frame, in box units: the body outline, then each
 * open eye, which the even-odd rule turns into a hole. Eyes that would cross the body's edge are
 * pulled back toward the middle of the face first.
 */
export function botMarkPath(shape: BotMarkShape, frame: BotMarkFrame): string {
  const body = botMarkBody(shape);
  const cos = Math.cos(frame.turn);
  const sin = Math.sin(frame.turn);
  const toBox = ([x, y]: Point): Point => {
    const sx = x * frame.sx;
    const sy = y * frame.sy;
    return [
      CENTER + frame.dx + (sx * cos - sy * sin) * BOT_MARK_RADIUS,
      CENTER + frame.dy + (sx * sin + sy * cos) * BOT_MARK_RADIUS,
    ];
  };
  let gaze = clampGaze(frame.gaze);
  let eyes: Point[][] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // The last try looks straight ahead, which fits every body.
    if (attempt === 4) gaze = [0, 0];
    const rotate = faceRotation(gaze);
    eyes = [
      eyeOutline(-1, frame.left, frame, rotate),
      eyeOutline(1, frame.right, frame, rotate),
    ].filter((eye): eye is Point[] => eye !== null);
    const margin = 0.97;
    if (eyes.every((eye) => eye.every(([x, y]) => inside([x / margin, y / margin], body)))) break;
    gaze = [gaze[0] * 0.72, gaze[1] * 0.72];
  }
  return [body, ...eyes].map((outline) => smoothPath(outline.map(toBox))).join("");
}

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

/** Maps a run status the roster knows to the mark state that shows it. */
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
    case "asleep":
    case "sleeping":
      return "asleep";
    default:
      return "idle";
  }
}

/** The mark facing forward with open eyes: for still pictures such as notification portraits. */
export function botMarkRestPath(shape: BotMarkShape): string {
  return botMarkPath(shape, REST);
}
