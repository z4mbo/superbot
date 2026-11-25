import { describe, expect, it } from "vitest";
import type { BotMarkGazeHold } from "./bot-mark-animation.js";
import {
  BOT_MARK_GAZE_REST,
  botMarkDrawing,
  botMarkFollowsPointer,
  botMarkFrame,
  botMarkGazeAim,
  botMarkGazeSettled,
  botMarkGazeStep,
  botMarkPointerGaze,
} from "./bot-mark-animation.js";
import { REST_ROTATION } from "./bot-mark-rest.js";

const FRAME = 1 / 60;

/** The middle of the points an eye-holes path passes through, in mark units. */
function eyeCentre(path: string): [number, number] {
  const numbers = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  let x = 0;
  let y = 0;
  const points = Math.floor(numbers.length / 2);
  for (let index = 0; index < points; index += 1) {
    x += numbers[index * 2]!;
    y += numbers[index * 2 + 1]!;
  }
  return [x / points, y / points];
}

function run(gaze: BotMarkGazeHold, target: [number, number] | null, frames: number) {
  let next = gaze;
  for (let index = 0; index < frames; index += 1) {
    next = botMarkGazeStep(botMarkGazeAim(next, target), FRAME);
  }
  return next;
}

describe("bot mark gaze", () => {
  it("reads the pointer in half-widths of the mark from its middle", () => {
    const mark = { left: 10, top: 20, width: 36, height: 36 };
    expect(botMarkPointerGaze(mark, [28, 38]).map((value) => value + 0)).toEqual([0, 0]);
    expect(botMarkPointerGaze(mark, [37, 29])).toEqual([0.5, 0.5]);
  });

  // The mark's middle is at (28, 38); y on screen grows downward, gaze y grows upward.
  const mark = { left: 10, top: 20, width: 36, height: 36 };
  const D = Math.SQRT1_2;
  it.each([
    ["top", [28, 0], [0, 1]],
    ["bottom", [28, 90], [0, -1]],
    ["left", [-40, 38], [-1, 0]],
    ["right", [120, 38], [1, 0]],
    ["top left", [0, 10], [-D, D]],
    ["top right", [56, 10], [D, D]],
    ["bottom left", [0, 66], [-D, -D]],
    ["bottom right", [56, 66], [D, -D]],
  ] as const)("looks %s at full reach, along that direction", (_name, pointer, expected) => {
    const [x, y] = botMarkPointerGaze(mark, pointer);
    expect(x).toBeCloseTo(expected[0], 6);
    expect(y).toBeCloseTo(expected[1], 6);
    expect(Math.hypot(x, y)).toBeCloseTo(1, 6);
  });

  it("clamps the length, not each axis, so a wide row keeps the pointer's true direction", () => {
    // Far along the row and a little below the mark: almost straight right, slightly down.
    const [x, y] = botMarkPointerGaze(mark, [240, 60]);
    expect(Math.hypot(x, y)).toBeCloseTo(1, 6);
    expect(x).toBeGreaterThan(0.99);
    expect(y).toBeLessThan(0);
    expect(y).toBeGreaterThan(-0.11);
  });

  it("does not follow the pointer while asleep or waking", () => {
    expect(botMarkFollowsPointer("idle")).toBe(true);
    expect(botMarkFollowsPointer("working")).toBe(true);
    expect(botMarkFollowsPointer("asleep")).toBe(false);
    expect(botMarkFollowsPointer("waking")).toBe(false);
  });

  it("moves the eyes toward each of the eight directions", () => {
    const centre = (x: number, y: number) => {
      const frame = botMarkFrame({ state: "idle", time: 0, seed: 0, gaze: { x, y, hold: 1 } });
      return eyeCentre(botMarkDrawing("blob", frame).eyes);
    };
    const ahead = centre(0, 0);
    for (const [x, y] of [
      [0, 1],
      [0, -1],
      [-1, 0],
      [1, 0],
      [-D, D],
      [D, D],
      [-D, -D],
      [D, -D],
    ] as const) {
      const [cx, cy] = centre(x, y);
      // Screen y grows downward, so looking up moves the eyes to a smaller y.
      if (x !== 0) expect(Math.sign(cx - ahead[0])).toBe(Math.sign(x));
      else expect(Math.abs(cx - ahead[0])).toBeLessThan(0.5);
      if (y !== 0) expect(Math.sign(ahead[1] - cy)).toBe(Math.sign(y));
      else expect(Math.abs(cy - ahead[1])).toBeLessThan(0.5);
    }
  });

  it("looks straight at the first target and eases only its hold in, 14% a frame", () => {
    const aimed = botMarkGazeAim(BOT_MARK_GAZE_REST, [0.4, -0.2]);
    expect(aimed).toMatchObject({ x: 0.4, y: -0.2, hold: 0, held: true });
    const first = botMarkGazeStep(aimed, FRAME);
    expect(first.hold).toBeCloseTo(0.14, 6);
    expect(run(aimed, [0.4, -0.2], 30).hold).toBeGreaterThan(0.98);
  });

  it("follows a moving pointer smoothly once held, and settles exactly on it", () => {
    const held = run(BOT_MARK_GAZE_REST, [0, 0], 60);
    expect(botMarkGazeSettled(held)).toBe(true);
    const moved = botMarkGazeStep(botMarkGazeAim(held, [1, 0]), FRAME);
    expect(moved.x).toBeCloseTo(0.14, 6);
    const settled = run(moved, [1, 0], 60);
    expect(settled).toMatchObject({ x: 1, y: 0, hold: 1 });
    expect(botMarkGazeSettled(settled)).toBe(true);
  });

  it("lets go from where it was looking and comes back to rest", () => {
    const held = run(BOT_MARK_GAZE_REST, [0.6, 0.3], 60);
    const released = botMarkGazeStep(botMarkGazeAim(held, null), FRAME);
    expect(released.hold).toBeCloseTo(0.86, 6);
    expect(released.x).toBe(0.6);
    const rest = run(released, null, 60);
    expect(rest.hold).toBe(0);
    expect(botMarkGazeSettled(rest)).toBe(true);
    const frame = botMarkFrame({ state: "idle", time: 0, seed: 0, gaze: rest });
    expect(frame.rotation).toEqual([...REST_ROTATION]);
  });

  it("never covers more than a tenth of a second in one step", () => {
    const aimed = botMarkGazeAim(BOT_MARK_GAZE_REST, [1, 1]);
    expect(botMarkGazeStep(aimed, 5)).toEqual(botMarkGazeStep(aimed, 0.1));
    expect(botMarkGazeStep(aimed, 0.1).hold).toBeCloseTo(1 - 0.86 ** 6, 6);
  });

  it("turns a held face toward the pointer and back to its tilted rest", () => {
    const face = (gaze: BotMarkGazeHold) =>
      botMarkFrame({ state: "idle", time: 0, seed: 0, shape: "blob", gaze }).rotation.map(
        (value) => value + 0,
      );
    expect(face(run(BOT_MARK_GAZE_REST, [0, 0], 60))).toEqual([0, 0, 0]);
    expect(face(run(BOT_MARK_GAZE_REST, [1, 1], 60))).toEqual([-14, 18, 0]);
    expect(face(BOT_MARK_GAZE_REST)).toEqual([...REST_ROTATION]);
  });
});
