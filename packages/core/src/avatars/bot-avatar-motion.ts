import type { LogoAvatarActivity } from "./logo-avatar-activity.js";

/**
 * How a shape avatar moves. The avatar itself carries the bot's state: calm at rest, turning
 * while it works, a slow look-around while it thinks, a nudge when it waits on someone and
 * a short shake when it is blocked.
 */
export type BotAvatarMotion = "idle" | "thinking" | "working" | "waiting" | "blocked";

export function botAvatarMotion(activity: LogoAvatarActivity): BotAvatarMotion {
  switch (activity) {
    case "idle":
      return "idle";
    case "thinking":
      return "thinking";
    case "waiting":
      return "waiting";
    case "error":
      return "blocked";
    default:
      return "working";
  }
}
