import {
  BOT_MARK_VIEWBOX,
  botMarkRestDrawing,
  botMarkShapeFor,
  notificationAvatarSource,
} from "@rakazo/core";
import { botInks, botStemColors } from "@rakazo/ui-tokens";
import { expect, it } from "vitest";

function portrait(bot: Parameters<typeof notificationAvatarSource>[0]) {
  const source = notificationAvatarSource(bot);
  return decodeURIComponent(source.slice(source.indexOf(",") + 1));
}

it("draws the bot's mark at rest in its picked shape and ink, eyes cut out", () => {
  const svg = portrait({ id: "agent-1", color: "#14b8a6", lookShape: "cloud", lookColor: "green" });
  const drawing = botMarkRestDrawing("cloud");
  expect(svg).toContain(`viewBox="${BOT_MARK_VIEWBOX}"`);
  expect(svg).toContain(`d="${drawing.body}" fill="${botInks.green}" mask="url(#holes)"`);
  expect(svg).toContain(`d="${drawing.eyes}" fill="#000"`);
});

it("draws an Avatar Studio pick like the chat does, in its palette colour's ink", () => {
  const svg = portrait({ id: "agent-2", color: "#8B5CF6::shape_3" });
  expect(svg).toContain(`d="${botMarkRestDrawing(botMarkShapeFor("agent-2", null, 3)).body}"`);
  expect(svg).toContain(`fill="${botInks.purple}"`);
});

it("keeps the pumpkin's stem in its own greys", () => {
  const svg = portrait({ id: "agent-4", color: "#FF781C", lookShape: "pumpkin" });
  expect(svg).toContain(`fill="${botStemColors.stem}"`);
  expect(svg).toContain(`fill="${botStemColors.cap}"`);
});

it("keeps a saved photo", () => {
  const image = "data:image/png;base64,AAAA";
  expect(notificationAvatarSource({ id: "agent-3", color: image })).toBe(image);
});
