import { BotAvatarValueSchema, parseBotAvatarValue } from "@rakazo/contracts";
import { botInks } from "@rakazo/ui-tokens";
import { resolvePersonaColorDef } from "./bot-avatar-colors.js";
import { BOT_MARK_VIEWBOX, botMarkInkFor, botMarkRestPath, botMarkShapeFor } from "./bot-mark.js";

/** A static notification portrait: the saved photo, or the bot's mark at rest in its ink. */
export function notificationAvatarSource(bot: {
  id: string;
  color: string;
  avatarSet?: string | null;
  lookShape?: string | null;
  lookColor?: string | null;
}): string {
  const parsed = BotAvatarValueSchema.safeParse(bot.color).success
    ? parseBotAvatarValue(bot.color)
    : null;
  if (parsed?.kind === "image") return parsed.imageUrl;
  const color = resolvePersonaColorDef(
    bot.id,
    parsed && "color" in parsed ? parsed.color : bot.color,
  ).hex;
  const ink = botMarkInkFor(bot.lookColor, color);
  // The push is flattened onto white, so a neutral mark is black and its eyes show white.
  const fill = ink === "neutral" ? "#000000" : botInks[ink];
  const d = botMarkRestPath(
    botMarkShapeFor(
      bot.id,
      bot.lookShape,
      parsed?.kind === "shape" ? parsed.shapeIndex : undefined,
    ),
  );
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="${BOT_MARK_VIEWBOX}"><path d="${d}" fill="${fill}" fill-rule="evenodd"/></svg>`)}`;
}
