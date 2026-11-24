/**
 * The pose a mark holds when nothing plays. The still picture and the animation both start from
 * it, so a mark first painted at rest looks the same once it starts moving.
 */
import type { BotMarkPose } from "./bot-mark-motion.js";

/** Turned up and to the right, as if glancing aside: pitch, yaw and roll in degrees. */
export const REST_ROTATION = [-15.8963, 33.2932, 25.3848] as const;
/** The body's diameter as a share of the box. */
export const REST_ZOOM = 0.6;

/**
 * The resting pose: turned up and to the side, eyes open, nothing moving. Built in a call marked
 * pure, so a bundle that never draws a mark can drop it.
 */
export const REST_POSE: BotMarkPose = /* @__PURE__ */ (() => ({
  rot: [...REST_ROTATION],
  pos: [0, 0],
  squash: [1, 1],
  zoom: REST_ZOOM,
  lids: 0,
  anchor: 0,
}))();
