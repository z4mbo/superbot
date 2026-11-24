import { describe, expect, it } from "vitest";
import { brandEnv } from "./brand-env.js";

describe("brandEnv", () => {
  it("prefers the SUPERBOT_ name", () => {
    expect(brandEnv("WEB_URL", { SUPERBOT_WEB_URL: "a", RAKAZO_WEB_URL: "b" })).toBe("a");
  });

  it("falls back to the legacy RAKAZO_ name", () => {
    expect(brandEnv("WEB_URL", { RAKAZO_WEB_URL: "b" })).toBe("b");
    expect(brandEnv("WEB_URL", { SUPERBOT_WEB_URL: "", RAKAZO_WEB_URL: "b" })).toBe("b");
  });

  it("is undefined when neither is set or both are empty", () => {
    expect(brandEnv("WEB_URL", {})).toBeUndefined();
    expect(brandEnv("WEB_URL", { SUPERBOT_WEB_URL: "", RAKAZO_WEB_URL: "" })).toBeUndefined();
  });
});
