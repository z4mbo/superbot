import { describe, expect, it } from "vitest";
import {
  BOT_MARK_IDLE_HOLD,
  BOT_MARK_SETTLE,
  botMarkFrame,
  botMarkRestsAfter,
} from "./bot-mark-animation.js";
import { faceOutlines } from "./bot-mark-faces.js";
import type { BotMarkClipName } from "./bot-mark-motion.js";
import {
  BRIDGE_SECONDS,
  clipDuration,
  clipFace,
  clipPose,
  playlistAt,
  SWITCH_SECONDS,
} from "./bot-mark-motion.js";
import { REST_ROTATION } from "./bot-mark-rest.js";

const rotationAt = (input: Parameters<typeof botMarkFrame>[0]) =>
  botMarkFrame(input).rotation.map((value) => value + 0);

describe("bot mark timeline", () => {
  it("keeps a bot that stops working playing its idle clip for 1.4s, then moves it to rest", () => {
    const idle = (seconds: number) =>
      rotationAt({ state: "idle", time: seconds * 1000, seed: 3, entered: true });
    // The renderer draws the move in; the clip then plays from its beginning.
    expect(idle(0.1)).toEqual(clipPose("idle", 0).rot.map((value) => value + 0));
    const at = BRIDGE_SECONDS + 0.6;
    expect(idle(at)).toEqual(clipPose("idle", 0.6).rot.map((value) => value + 0));
    const moving = idle(BOT_MARK_IDLE_HOLD + BRIDGE_SECONDS / 2);
    expect(moving).not.toEqual([...REST_ROTATION]);
    expect(idle(BOT_MARK_IDLE_HOLD + BRIDGE_SECONDS)).toEqual([...REST_ROTATION]);
    expect(botMarkRestsAfter("idle", true)).toBeCloseTo(BOT_MARK_IDLE_HOLD + BRIDGE_SECONDS, 9);
    // First painted idle, a mark simply rests.
    expect(rotationAt({ state: "idle", time: 500, seed: 3 })).toEqual([...REST_ROTATION]);
    expect(botMarkRestsAfter("idle", false)).toBe(0);
  });

  it("starts a state entered on screen at its first clip's beginning once the move in ends", () => {
    const clips: BotMarkClipName[] = [
      "workSpin",
      "workInspect",
      "workSway",
      "workScan",
      "workLook",
      "workFlip",
    ];
    const first = playlistAt(clips, 0, 11, false).clip;
    const working = (seconds: number) =>
      botMarkFrame({ state: "working", time: seconds * 1000, seed: 11, entered: true });
    expect(working(BRIDGE_SECONDS + 1).rotation).toEqual(clipPose(first, 1).rot);
    expect(botMarkRestsAfter("working", true)).toBeNull();
  });

  it("holds a clip's last frame for a 60th of a second before moving into the next", () => {
    const clips = ["workSpin", "workInspect"] as const;
    const first = playlistAt(clips, 0, 5, false).clip;
    const end = clipDuration(first);
    const held = playlistAt(clips, end + SWITCH_SECONDS / 2, 5, false);
    expect(held).toMatchObject({ clip: first, time: end, bridge: null });
    const moving = playlistAt(clips, end + SWITCH_SECONDS + BRIDGE_SECONDS / 2, 5, false);
    expect(moving.clip).not.toBe(first);
    expect(moving.enter).toEqual({ from: first, since: expect.closeTo(BRIDGE_SECONDS / 2, 9) });
  });

  it("loops a clip whose ends meet without a pause, keeping the face it ended on", () => {
    const once = playlistAt(["idle"], 0.5, 0, false);
    const again = playlistAt(["idle"], clipDuration("idle") + 0.5, 0, false);
    expect(again).toMatchObject({ clip: "idle", loop: true });
    expect(again.time).toBeCloseTo(once.time, 9);
  });

  it("moves into a clip with the face it starts on", () => {
    // The inspecting clip's first face change comes later, but it is moved into with it.
    expect(clipFace("workInspect", 0.1).to).toBe(clipFace("workInspect", 1).to);
    expect(clipFace("workInspect", 0.1, "neutral").to).toBe("neutral");
  });

  it("shows a run that finished on screen, idles, and rests once it has been shown long enough", () => {
    const done = (seconds: number) =>
      rotationAt({ state: "done", time: seconds * 1000, seed: 0, entered: true });
    const end = BOT_MARK_SETTLE + BOT_MARK_IDLE_HOLD + BRIDGE_SECONDS;
    expect(done(end - BRIDGE_SECONDS - 0.5)).not.toEqual([...REST_ROTATION]);
    expect(done(end)).toEqual([...REST_ROTATION]);
    expect(botMarkRestsAfter("done", true)).toBeCloseTo(end, 9);
    expect(botMarkRestsAfter("error", false)).toBe(0);
  });

  it("surprises the face while the pointer is over its line, and lets it go after", () => {
    const eyes = (emphasis: { on: boolean; seconds: number } | null) =>
      botMarkFrame({ state: "idle", time: 0, seed: 0, emphasis }).eyes;
    expect(eyes({ on: true, seconds: 1 })).toEqual(faceOutlines("surprised"));
    const midway = eyes({ on: true, seconds: 0.1 });
    expect(midway).not.toEqual(faceOutlines("surprised"));
    expect(midway).not.toEqual(faceOutlines("neutral"));
    expect(eyes({ on: false, seconds: 1 })).toEqual(faceOutlines("neutral"));
    expect(eyes({ on: false, seconds: 0.1 })).not.toEqual(faceOutlines("neutral"));
    // A state that holds a face of its own keeps it.
    const listening = (emphasis: { on: boolean; seconds: number } | null) =>
      botMarkFrame({ state: "idle", emotion: "listening", time: 2000, seed: 0, emphasis }).eyes;
    expect(listening({ on: true, seconds: 1 })).toEqual(listening(null));
  });

  it("reads blinks on a 60th-of-a-second grid from the clip's start", () => {
    const at = 1.1672 + 0.117;
    const step = Math.floor(at * 60) / 60;
    expect(clipPose("workSpin", at).lids).toBe(clipPose("workSpin", step).lids);
    expect(clipPose("workSpin", step + 0.001).lids).toBe(clipPose("workSpin", step).lids);
  });
});
