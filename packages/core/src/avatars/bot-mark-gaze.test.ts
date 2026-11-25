import { describe, expect, it } from "vitest";
import type { BotMarkGazeHold } from "./bot-mark-animation.js";
import {
  BOT_MARK_GAZE_REST,
  botMarkFrame,
  botMarkGazeAim,
  botMarkGazeSettled,
  botMarkGazeStep,
  botMarkPointerGaze,
} from "./bot-mark-animation.js";
import { REST_ROTATION } from "./bot-mark-rest.js";

const FRAME = 1 / 60;

function run(gaze: BotMarkGazeHold, target: [number, number] | null, frames: number) {
  let next = gaze;
  for (let index = 0; index < frames; index += 1) {
    next = botMarkGazeStep(botMarkGazeAim(next, target), FRAME);
  }
  return next;
}

describe("bot mark gaze", () => {
  it("reads the pointer in half-widths of the mark from its middle, clamped to the box", () => {
    const mark = { left: 10, top: 20, width: 36, height: 36 };
    expect(botMarkPointerGaze(mark, [28, 38]).map((value) => value + 0)).toEqual([0, 0]);
    expect(botMarkPointerGaze(mark, [37, 29])).toEqual([0.5, 0.5]);
    // A pointer far along a wide row still only turns the face its full way.
    expect(botMarkPointerGaze(mark, [240, 60])).toEqual([1, -1]);
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
