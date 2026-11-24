import { describe, expect, it } from "vitest";
import {
  BOT_MARK_SHAPES,
  BOT_MARK_STATES,
  botMarkBlend,
  botMarkDrawing,
  botMarkFrame,
  botMarkInkFor,
  botMarkPath,
  botMarkRestPath,
  botMarkShapeFor,
  botMarkShowcaseEmotion,
  botMarkStateFor,
  botMarkZoom,
} from "./bot-mark.js";
import { bodySilhouette } from "./bot-mark-bodies.js";
import { faceOutlines } from "./bot-mark-faces.js";
import { playlistAt, pokeEffect, REST_ROTATION } from "./bot-mark-motion.js";

const subpaths = (d: string) => d.split("M").length - 1;

function points(d: string, index: number) {
  const part = d.split("M")[index + 1]!;
  const numbers = part.match(/-?[\d.]+/g)!.map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) out.push([numbers[i]!, numbers[i + 1]!]);
  return out;
}

const centre = (d: string, index: number): [number, number] => {
  const p = points(d, index);
  return [
    p.reduce((sum, [x]) => sum + x, 0) / p.length,
    p.reduce((sum, [, y]) => sum + y, 0) / p.length,
  ];
};

const reach = (d: string, index: number) =>
  Math.max(...points(d, index).map(([x, y]) => Math.hypot(x - 96, y - 96)));

describe("bot mark", () => {
  it.each(BOT_MARK_SHAPES)("draws %s as one body with two eye holes", (shape) => {
    const d = botMarkRestPath(shape);
    expect(subpaths(d)).toBe(3);
    expect(d).toMatch(/Z$/);
  });

  it("makes the resting sphere a disc 60% of the 192-unit box, drawn with arcs", () => {
    const d = botMarkRestPath("blob");
    expect(d.startsWith("M153.6 96A57.6 57.6 0 0 0 96 38.4")).toBe(true);
  });

  it("rests with the eyes turned up and to the right, and faces a held gaze head on", () => {
    const rest = botMarkRestPath("blob");
    const [lx, ly] = centre(rest, 1);
    const [rx, ry] = centre(rest, 2);
    expect(lx).toBeGreaterThan(96);
    expect(ry).toBeLessThan(ly);
    expect(rx).toBeGreaterThan(lx);
    const facing = botMarkPath(
      "blob",
      botMarkFrame({ state: "idle", time: 0, seed: 0, gaze: { x: 0, y: 0, hold: 1 } }),
    );
    expect(centre(facing, 1)[0]).toBeCloseTo(78.4, 0);
    expect(centre(facing, 2)[0]).toBeCloseTo(113.6, 0);
    expect(centre(facing, 1)[1]).toBeCloseTo(96, 0);
  });

  it("keeps the sphere's eyes inside the disc however far it turns", () => {
    for (const time of [0, 150, 300, 450, 600, 750]) {
      const frame = botMarkFrame({
        state: "idle",
        time: 0,
        seed: 1,
        pokes: [{ kind: "spin", since: time / 1000 }],
      });
      const d = botMarkPath("blob", frame);
      for (let eye = 1; eye < subpaths(d); eye += 1)
        expect(reach(d, eye)).toBeLessThanOrEqual(57.7);
    }
  });

  it("spins a full turn in 0.9s when clicked", () => {
    expect(pokeEffect([{ kind: "spin", since: 0.3 }]).yaw).toBeCloseTo(90, 5);
    expect(pokeEffect([{ kind: "spin", since: 0.45 }]).yaw).toBeCloseTo(180, 5);
    expect(pokeEffect([{ kind: "spin", since: 1 }]).yaw).toBe(0);
    const bounce = pokeEffect([{ kind: "bounce", since: 0.05 }]);
    expect(bounce.squash[0]).toBeGreaterThan(1);
    expect(bounce.squash[1]).toBeLessThan(1);
  });

  it("turns shaped bodies as solids, so their outline changes edge-on", () => {
    const turn = (yaw: number) => ({ yaw, pitch: 0, roll: 0 });
    const front = bodySilhouette("square", turn(0));
    const side = bodySilhouette("square", turn(89.5));
    const width = (outline: readonly (readonly [number, number])[]) =>
      Math.max(...outline.map(([x]) => x)) - Math.min(...outline.map(([x]) => x));
    expect(width(side)).toBeLessThan(width(front) * 0.5);
    // A pill is round across, so it keeps its width as it turns about its length.
    expect(width(bodySilhouette("capsule", turn(89.5)))).toBeCloseTo(
      width(bodySilhouette("capsule", turn(0))),
      2,
    );
  });

  it("gives the pumpkin a stem in two greys and cuts eyes out with a mask", () => {
    const frame = botMarkFrame({ state: "idle", time: 0, seed: 0, shape: "pumpkin" });
    const drawing = botMarkDrawing("pumpkin", frame);
    expect(drawing.stem.map(({ tone }) => tone)).toEqual(["stem", "cap"]);
    expect(subpaths(drawing.eyes)).toBe(2);
    for (const shape of BOT_MARK_SHAPES) {
      const plain = botMarkDrawing(shape, botMarkFrame({ state: "idle", time: 0, seed: 0, shape }));
      if (shape !== "pumpkin") expect(plain.stem).toEqual([]);
      expect(subpaths(plain.body)).toBe(1);
    }
  });

  it("plays a working bot's clips in a seeded order that differs between bots", () => {
    const clips = [
      "workSpin",
      "workInspect",
      "workSway",
      "workScan",
      "workLook",
      "workFlip",
    ] as const;
    const order = (seed: number) =>
      Array.from({ length: 12 }, (_, index) => playlistAt(clips, index * 5, seed).clip).join();
    expect(order(1)).toBe(order(1));
    expect(order(1)).not.toBe(order(2));
    const frames = [0, 700, 1400, 2100].map((time) =>
      botMarkPath("blob", botMarkFrame({ state: "working", time, seed: 0 })),
    );
    expect(new Set(frames).size).toBe(frames.length);
  });

  it.each(BOT_MARK_STATES)("draws the %s state", (state) => {
    const d = botMarkPath("egg", botMarkFrame({ state, time: 1500, seed: 3, shape: "egg" }));
    expect(subpaths(d)).toBeGreaterThanOrEqual(1);
  });

  it("closes a sleeping bot's eyes into flat curves", () => {
    const [eye] = faceOutlines("sleepy");
    const ys = eye.map(([, y]) => y);
    const xs = eye.map(([x]) => x);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(
      (Math.max(...xs) - Math.min(...xs)) * 0.8,
    );
    const frame = botMarkFrame({ state: "asleep", time: 900, seed: 0 });
    expect(frame.eyes).not.toBeNull();
  });

  it("folds a thinking bot into three dots and a waiting one into a circling orbit", () => {
    const early = botMarkFrame({ state: "thinking", time: 100, seed: 0, shape: "egg" });
    expect(early.morph?.kind).toBe("dots");
    expect(early.eyes).not.toBeNull();
    const thinking = botMarkFrame({ state: "thinking", time: 2000, seed: 0, shape: "egg" });
    expect(thinking.morph?.amount).toBeGreaterThan(0.99);
    expect(thinking.eyes).toBeNull();
    const dots = botMarkDrawing("egg", thinking).dots;
    expect(dots).toHaveLength(2);
    // Two dots either side of the folded body, hopping in turn.
    expect(dots[0]!.cx + dots[1]!.cx).toBeCloseTo(2 * 96, 0);
    const waiting = botMarkDrawing("egg", botMarkFrame({ state: "waiting", time: 2000, seed: 0 }));
    expect(waiting.dots).toHaveLength(5);
    expect(botMarkZoom(thinking, 24)).toBeCloseTo(1.5, 2);
    expect(botMarkZoom(thinking, 200)).toBe(1);
  });

  it("plays a finished or failed bot's clips once, then rests", () => {
    for (const state of ["done", "error"] as const) {
      const late = botMarkFrame({ state, time: 20_000, seed: 0 });
      for (const [k, angle] of late.rotation.entries()) {
        expect(angle).toBeCloseTo(REST_ROTATION[k]!, 6);
      }
    }
    const playing = botMarkFrame({ state: "done", time: 500, seed: 0 });
    expect(playing.rotation).not.toEqual([...REST_ROTATION]);
  });

  it("rests idle bots in the reference's turned pose without moving", () => {
    const a = botMarkFrame({ state: "idle", time: 0, seed: 0 });
    const b = botMarkFrame({ state: "idle", time: 5000, seed: 9 });
    expect(a).toEqual(b);
    expect(a.rotation).toEqual([...REST_ROTATION]);
  });

  it("blends from one state into the next", () => {
    const from = botMarkFrame({ state: "idle", time: 0, seed: 0 });
    const to = botMarkFrame({ state: "working", time: 0, seed: 0 });
    expect(botMarkBlend(from, to, 0).rotation[1]).toBeCloseTo(from.rotation[1], 5);
    // A blend never unwinds whole turns, so compare the angle round the circle.
    const turn = (value: number) => ((value % 360) + 360) % 360;
    expect(turn(botMarkBlend(from, to, 1).rotation[1])).toBeCloseTo(turn(to.rotation[1]), 5);
  });

  it("shows each welcome emotion for 1200ms with 1200ms of rest between", () => {
    expect(botMarkShowcaseEmotion(100)).toBe("playful");
    expect(botMarkShowcaseEmotion(1300)).toBeNull();
    expect(botMarkShowcaseEmotion(2500)).toBe("excited");
  });

  it("keeps a picked shape and ink, and derives stable ones otherwise", () => {
    expect(botMarkShapeFor("bot-1", "cloud")).toBe("cloud");
    expect(botMarkShapeFor("bot-1", "circle")).toBe("blob");
    expect(botMarkShapeFor("bot-1", "nope")).toBe(botMarkShapeFor("bot-1"));
    expect(botMarkShapeFor("bot-1", null, 1)).toBe(BOT_MARK_SHAPES[1]);
    const defaults = new Set(
      Array.from({ length: 60 }, (_, index) => botMarkShapeFor(`bot-${index}`)),
    );
    expect(defaults.size).toBeGreaterThan(4);
    expect(botMarkInkFor("green", "#000000")).toBe("green");
    expect(botMarkInkFor("violet", "#000000")).toBe("purple");
    expect(botMarkInkFor(null, "#1e86fc")).toBe("blue");
    expect(botMarkInkFor(null, "#fb2b3e")).toBe("red");
    expect(botMarkInkFor(null, "#a06b39")).toBe("brown");
    expect(botMarkInkFor(null, "#111111")).toBe("neutral");
  });

  it("maps statuses to looks, with sleeping and unreachable bots asleep", () => {
    expect(botMarkStateFor("running")).toBe("working");
    expect(botMarkStateFor("waiting_input")).toBe("waiting");
    expect(botMarkStateFor("failed")).toBe("error");
    expect(botMarkStateFor("hibernated")).toBe("asleep");
    expect(botMarkStateFor("offline")).toBe("asleep");
    expect(botMarkStateFor("waking")).toBe("waking");
    expect(botMarkStateFor(undefined)).toBe("idle");
  });
});
