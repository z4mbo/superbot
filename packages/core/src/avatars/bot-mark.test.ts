import { describe, expect, it } from "vitest";
import {
  BOT_MARK_SHAPES,
  BOT_MARK_STATES,
  botMarkBody,
  botMarkFrame,
  botMarkInkFor,
  botMarkPath,
  botMarkRestPath,
  botMarkShapeFor,
  botMarkShowcaseEmotion,
  botMarkStateFor,
} from "./bot-mark.js";

const subpaths = (d: string) => d.split("M").length - 1;

function radius(d: string, index: number) {
  const part = d.split("M")[index + 1]!;
  const numbers = part.match(/-?[\d.]+/g)!.map(Number);
  let max = 0;
  for (let i = 0; i < numbers.length; i += 2) {
    max = Math.max(max, Math.hypot(numbers[i]! - 96, numbers[i + 1]! - 96));
  }
  return max;
}

describe("bot mark", () => {
  it.each(BOT_MARK_SHAPES)("draws %s as one body with two eye holes", (shape) => {
    const d = botMarkRestPath(shape);
    expect(subpaths(d)).toBe(3);
    expect(d).toMatch(/Z$/);
    expect(botMarkBody(shape).length).toBeGreaterThan(40);
  });

  it("makes the disc 60% of the 192-unit box", () => {
    expect(radius(botMarkRestPath("circle"), 0)).toBeCloseTo(57.6, 0);
  });

  it("keeps the eyes inside the body however far the face turns", () => {
    for (const shape of BOT_MARK_SHAPES) {
      for (const pointer of [
        [9, 0],
        [-9, 4],
        [0, -9],
        [6, 6],
      ] as const) {
        const d = botMarkPath(shape, botMarkFrame({ state: "idle", time: 2000, seed: 7, pointer }));
        expect(radius(d, 1)).toBeLessThan(radius(d, 0));
        expect(radius(d, 2)).toBeLessThan(radius(d, 0));
      }
    }
  });

  it("turns the face toward the pointer and narrows the eyes when it is far", () => {
    const near = botMarkFrame({ state: "idle", time: 2000, seed: 1, pointer: [0.2, 0] });
    const far = botMarkFrame({ state: "idle", time: 2000, seed: 1, pointer: [12, 0] });
    expect(far.gaze[0]).toBeGreaterThan(near.gaze[0]);
    expect(far.left.h).toBeLessThan(near.left.h);
  });

  it("changes a working bot's eyes and sways its body over time", () => {
    const frames = [0, 1200, 2600, 3800].map((time) =>
      botMarkPath("circle", botMarkFrame({ state: "working", time, seed: 0, pointer: null })),
    );
    expect(new Set(frames).size).toBe(frames.length);
    const sway = [0, 325, 650, 975].map(
      (time) => botMarkFrame({ state: "working", time, seed: 0, pointer: null }).dx,
    );
    expect(Math.max(...sway) - Math.min(...sway)).toBeGreaterThan(6);
  });

  it.each(BOT_MARK_STATES)("draws the %s state", (state) => {
    const d = botMarkPath("egg", botMarkFrame({ state, time: 1500, seed: 3, pointer: null }));
    expect(subpaths(d)).toBeGreaterThanOrEqual(1);
  });

  it("squashes on a click and springs back", () => {
    const poked = botMarkFrame({ state: "idle", time: 0, seed: 0, pointer: null, poke: 0 });
    const settled = botMarkFrame({ state: "idle", time: 0, seed: 0, pointer: null, poke: 2000 });
    expect(poked.sy).toBeLessThan(1);
    expect(poked.sx).toBeGreaterThan(1);
    expect(settled.sx).toBe(1);
  });

  it("shows each welcome emotion for 1200ms with 1200ms of idle between", () => {
    expect(botMarkShowcaseEmotion(100)).toBe("playful");
    expect(botMarkShowcaseEmotion(1300)).toBeNull();
    expect(botMarkShowcaseEmotion(2500)).toBe("excited");
  });

  it("keeps a picked shape and ink, and derives stable ones otherwise", () => {
    expect(botMarkShapeFor("bot-1", "cloud")).toBe("cloud");
    expect(botMarkShapeFor("bot-1", "nope")).toBe(botMarkShapeFor("bot-1"));
    expect(botMarkShapeFor("bot-1", null, 1)).toBe(BOT_MARK_SHAPES[1]);
    expect(botMarkInkFor("green", "#000000")).toBe("green");
    expect(botMarkInkFor(null, "#1e86fc")).toBe("blue");
    expect(botMarkInkFor(null, "#fb2b3e")).toBe("red");
    expect(botMarkInkFor(null, "#14c16f")).toBe("green");
    expect(botMarkInkFor(null, "#a06b39")).toBe("brown");
    expect(botMarkInkFor(null, "#111111")).toBe("neutral");
  });

  it("maps run statuses to states", () => {
    expect(botMarkStateFor("running")).toBe("working");
    expect(botMarkStateFor("waiting_input")).toBe("waiting");
    expect(botMarkStateFor("failed")).toBe("error");
    expect(botMarkStateFor(undefined)).toBe("idle");
  });
});
