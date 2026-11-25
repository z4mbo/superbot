import { BotAvatarValueSchema, parseBotAvatarValue } from "@rakazo/contracts";
import { botInks, botStemColors } from "@rakazo/ui-tokens";
import { resolvePersonaColorDef } from "./bot-avatar-colors.js";
import {
  BOT_MARK_BOX,
  BOT_MARK_VIEWBOX,
  botMarkInkFor,
  botMarkRestDrawing,
  botMarkShapeFor,
} from "./bot-mark.js";

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
  const ink = botMarkInkFor(bot.lookColor, color, bot.id);
  // The push is flattened onto white, so a neutral mark is black and its eyes show white.
  const fill = ink === "neutral" ? "#000000" : botInks[ink];
  const drawing = botMarkRestDrawing(
    botMarkShapeFor(
      bot.id,
      bot.lookShape,
      parsed?.kind === "shape" ? parsed.shapeIndex : undefined,
    ),
  );
  // The same picture the app draws: the body with its eyes masked out, and the pumpkin's stem.
  const [low, span] = [-BOT_MARK_BOX / 2, BOT_MARK_BOX * 2];
  const area = `x="${low}" y="${low}" width="${span}" height="${span}"`;
  const stem = drawing.stem
    .map(({ d, tone }) => `<path d="${d}" fill="${botStemColors[tone]}"/>`)
    .join("");
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="${BOT_MARK_VIEWBOX}"><mask id="holes" maskUnits="userSpaceOnUse" ${area}><rect ${area} fill="#fff"/><path d="${drawing.eyes}" fill="#000"/></mask><path d="${drawing.body}" fill="${fill}" mask="url(#holes)"/>${stem}</svg>`,
  )}`;
}
