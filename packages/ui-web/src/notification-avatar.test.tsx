import {
  BOT_MARK_VIEWBOX,
  botMarkRestPath,
  botMarkShapeFor,
  notificationAvatarSource,
} from "@rakazo/core";
import { botInks } from "@rakazo/ui-tokens";
import { expect, it } from "vitest";

function portrait(bot: Parameters<typeof notificationAvatarSource>[0]) {
  const source = notificationAvatarSource(bot);
  return decodeURIComponent(source.slice(source.indexOf(",") + 1));
}

it("draws the bot's mark at rest in its picked shape and ink", () => {
  const svg = portrait({ id: "agent-1", color: "#14b8a6", lookShape: "cloud", lookColor: "green" });
  expect(svg).toContain(`viewBox="${BOT_MARK_VIEWBOX}"`);
  expect(svg).toContain(`d="${botMarkRestPath("cloud")}"`);
  expect(svg).toContain(`fill="${botInks.green}"`);
  expect(svg).toContain('fill-rule="evenodd"');
});

it("draws an Avatar Studio pick like the chat does, in the ink nearest the colour", () => {
  const svg = portrait({ id: "agent-2", color: "#8B5CF6::shape_3" });
  expect(svg).toContain(`d="${botMarkRestPath(botMarkShapeFor("agent-2", null, 3))}"`);
  expect(svg).toContain(`fill="${botInks.purple}"`);
});

it("keeps a saved photo", () => {
  const image = "data:image/png;base64,AAAA";
  expect(notificationAvatarSource({ id: "agent-3", color: image })).toBe(image);
});
