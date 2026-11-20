import { describe, expect, it } from "vitest";
import { SpaceBotSchema } from "../spaces/space.js";
import { BotSchema, UpdateBotInput } from "./bot.js";

const botId = "cmlookbot000000000000000a";

describe("a bot's picked avatar look", () => {
  it("takes pack names, and null clears a pick", () => {
    expect(
      UpdateBotInput.parse({ botId, lookShape: "teardrop", lookColor: "chrome" }),
    ).toMatchObject({
      lookShape: "teardrop",
      lookColor: "chrome",
    });
    expect(UpdateBotInput.parse({ botId, lookShape: null, lookColor: null })).toMatchObject({
      lookShape: null,
      lookColor: null,
    });
    expect(UpdateBotInput.parse({ botId })).not.toHaveProperty("lookShape");
  });

  it("refuses anything that is not a short lowercase name", () => {
    for (const bad of ["", "Blob", "#ff0000", "a b", "../x", "x".repeat(33), "9lives"]) {
      expect(UpdateBotInput.safeParse({ botId, lookShape: bad }).success, bad).toBe(false);
    }
  });

  it("reads bots from servers that never sent a look", () => {
    const summary = SpaceBotSchema.pick({ lookShape: true, lookColor: true }).parse({});
    expect(summary).toEqual({});
    expect(BotSchema.shape.lookShape.parse("a-shape-this-client-has-never-seen")).toBe(
      "a-shape-this-client-has-never-seen",
    );
  });
});
