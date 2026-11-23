import { describe, expect, it } from "vitest";
import { botAvatarMotion } from "./bot-avatar-motion.js";

describe("botAvatarMotion", () => {
  it("gives every activity one motion", () => {
    expect(botAvatarMotion("idle")).toBe("idle");
    expect(botAvatarMotion("thinking")).toBe("thinking");
    expect(botAvatarMotion("waiting")).toBe("waiting");
    expect(botAvatarMotion("error")).toBe("blocked");
    for (const activity of ["reading", "writing", "computer", "working"] as const)
      expect(botAvatarMotion(activity)).toBe("working");
  });
});
