import type { BotMarkShape } from "@rakazo/core";
import { BOT_MARK_VIEWBOX, botMarkRestDrawing } from "@rakazo/core";
import type { CSSProperties } from "react";

/**
 * Something drawn over an avatar's corner, in pixels from the avatar's top left: a badge, a dot,
 * or another avatar. A mark is cut out in its own resting outline; anything else as a pill.
 */
export type AvatarCutoutHole = {
  x: number;
  y: number;
  width: number;
  height: number;
  shape?: BotMarkShape;
};

/** How far past the avatar's box its mark may reach (a turned wedge does) without being clipped. */
const REACH = 16;

const [VIEW_X, , VIEW_SIZE] = BOT_MARK_VIEWBOX.split(" ").map(Number) as [number, number, number];

const round = (value: number) => String(Math.round(value * 100) / 100);

function pill(x: number, y: number, width: number, height: number) {
  const r = height / 2;
  return `<path d="M${round(x + r)} ${round(y)}H${round(x + width - r)}A${round(r)} ${round(r)} 0 0 1 ${round(x + width - r)} ${round(y + height)}H${round(x + r)}A${round(r)} ${round(r)} 0 0 1 ${round(x + r)} ${round(y)}Z"/>`;
}

function markHole(hole: AvatarCutoutHole & { shape: BotMarkShape }, gap: number) {
  const scale = hole.width / VIEW_SIZE;
  const d = botMarkRestDrawing(hole.shape).body;
  return `<path transform="translate(${round(hole.x)} ${round(hole.y)}) scale(${scale.toFixed(5)}) translate(${-VIEW_X} ${-VIEW_X})" d="${d}" stroke="#000" stroke-width="${round((2 * gap) / scale)}" stroke-linejoin="round"/>`;
}

/**
 * Cuts a gap around whatever sits over an avatar's corner, so the surface behind shows between
 * them on any background, hovered or selected, as the reference does; never a ring in a guessed
 * colour. The avatar's own wrapper takes the style.
 */
export function avatarCutoutStyle(
  size: number,
  holes: readonly AvatarCutoutHole[],
  gap: number,
): CSSProperties {
  if (holes.length === 0) return {};
  const box = size + REACH * 2;
  const cut = holes
    .map((hole) =>
      hole.shape
        ? markHole({ ...hole, shape: hole.shape }, gap)
        : pill(hole.x - gap, hole.y - gap, hole.width + gap * 2, hole.height + gap * 2),
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${-REACH} ${-REACH} ${box} ${box}"><mask id="m"><rect x="${-REACH}" y="${-REACH}" width="${box}" height="${box}" fill="#fff"/><g fill="#000">${cut}</g></mask><rect x="${-REACH}" y="${-REACH}" width="${box}" height="${box}" fill="#fff" mask="url(#m)"/></svg>`;
  const image = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return {
    padding: REACH,
    margin: -REACH,
    maskImage: image,
    WebkitMaskImage: image,
    maskSize: `${box}px ${box}px`,
    WebkitMaskSize: `${box}px ${box}px`,
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
  };
}
