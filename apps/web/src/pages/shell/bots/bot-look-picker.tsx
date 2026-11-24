import { useLingui } from "@lingui/react/macro";
import type { BotMarkInk, BotMarkShape } from "@rakazo/core";
import { BOT_MARK_VIEWBOX, botMarkRestDrawing } from "@rakazo/core";
import { cn } from "@rakazo/ui-web";
import { useId } from "react";

/** A bot's look as the picker edits it: one body and one ink. */
export type BotPickedLook = { shape: BotMarkShape; ink: BotMarkInk };

/** The bodies the picker offers, in the reference's order. Rows hold five. */
export const PICKER_SHAPES: readonly BotMarkShape[] = [
  "blob",
  "cloud",
  "square",
  "sparkle",
  "clover",
  "heart",
  "flower",
  "teardrop",
  "tablet",
  "wedge",
  "house",
  "star",
  "hex",
];

/** The inks the picker offers, in the reference's order. */
export const PICKER_INKS: readonly BotMarkInk[] = [
  "neutral",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "magenta",
  "gray",
];

/** A body that always wears one ink: picking it sets the ink and hides the colours. */
const FIXED_INKS: Partial<Record<BotMarkShape, BotMarkInk>> = { pumpkin: "orange" };

const ROW = 5;
/** The mark inside a 48px shape cell. */
const CELL_MARK = 36;
/** The selection ring sits this far outside the body, 1px thick. */
const RING_GAP = 3;

/** The look after picking a body: a body with an ink of its own takes it. */
export function withShape(look: BotPickedLook, shape: BotMarkShape): BotPickedLook {
  return { shape, ink: FIXED_INKS[shape] ?? look.ink };
}

/** The shapes to show: the picker's own, plus the current body when it is not one of them. */
function shownShapes(current: BotMarkShape): readonly BotMarkShape[] {
  return PICKER_SHAPES.includes(current) ? PICKER_SHAPES : [...PICKER_SHAPES, current];
}

/**
 * The body and colour pickers of the agent edit menu: rows of five resting marks drawn in the
 * current ink, then the inks. A body with an ink of its own hides the colours.
 */
export function BotLookPicker({
  look,
  disabled = false,
  onChange,
}: {
  look: BotPickedLook;
  disabled?: boolean;
  onChange: (look: BotPickedLook) => void;
}) {
  const { t } = useLingui();
  const shapes = shownShapes(look.shape);
  const rows = Array.from({ length: Math.ceil(shapes.length / ROW) }, (_, index) =>
    shapes.slice(index * ROW, (index + 1) * ROW),
  );
  const fixedInk = FIXED_INKS[look.shape];
  return (
    <div className="flex flex-col gap-3">
      <fieldset
        aria-label={t`Character shape`}
        className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 py-1.5"
      >
        {rows.map((row) => (
          <div key={row[0]} className="flex justify-center gap-x-2">
            {row.map((shape) => (
              <ShapeCell
                key={shape}
                shape={shape}
                ink={FIXED_INKS[shape] ?? look.ink}
                selected={shape === look.shape}
                disabled={disabled}
                onPick={() => onChange(withShape(look, shape))}
              />
            ))}
          </div>
        ))}
      </fieldset>
      {fixedInk ? null : (
        <fieldset
          aria-label={t`Character color`}
          className="m-0 flex min-w-0 max-w-58 flex-wrap justify-center gap-2 self-center border-0 px-0 py-2"
        >
          {PICKER_INKS.map((ink) => (
            <InkCell
              key={ink}
              ink={ink}
              selected={ink === look.ink}
              disabled={disabled}
              onPick={() => onChange({ ...look, ink })}
            />
          ))}
        </fieldset>
      )}
    </div>
  );
}

function ShapeCell({
  shape,
  ink,
  selected,
  disabled,
  onPick,
}: {
  shape: BotMarkShape;
  ink: BotMarkInk;
  selected: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const { t } = useLingui();
  const name = useShapeName(shape);
  return (
    <button
      type="button"
      title={name}
      aria-label={t`${name} character shape`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onPick}
      data-bot-look-shape={shape}
      className="group/shape relative flex size-12 cursor-pointer items-center justify-center outline-none disabled:cursor-default"
    >
      <RestingMark shape={shape} ink={ink} size={CELL_MARK} />
      <SelectionRing
        shape={shape}
        className={cn(
          "absolute",
          selected
            ? "text-foreground/24"
            : "text-border opacity-0 group-hover/shape:opacity-100 group-focus-visible/shape:opacity-100",
        )}
      />
    </button>
  );
}

function InkCell({
  ink,
  selected,
  disabled,
  onPick,
}: {
  ink: BotMarkInk;
  selected: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const { t } = useLingui();
  const name = useInkName(ink);
  return (
    <button
      type="button"
      title={name}
      aria-label={t`${name} character color`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onPick}
      data-bot-look-ink={ink}
      className={cn(
        "flex size-8 cursor-pointer items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
        !selected && "hover:border-border",
      )}
    >
      <span
        className={cn(
          "block size-6 rounded-full",
          selected && "ring-1 ring-foreground/24 ring-offset-3 ring-offset-popover",
        )}
        style={{ backgroundColor: `var(--bot-ink-${ink})` }}
      />
    </button>
  );
}

/** A still mark: the resting body in its ink with the eyes cut out, as the picker shows it. */
function RestingMark({ shape, ink, size }: { shape: BotMarkShape; ink: BotMarkInk; size: number }) {
  const id = useId();
  const drawing = botMarkRestDrawing(shape);
  return (
    <svg
      viewBox={BOT_MARK_VIEWBOX}
      aria-hidden="true"
      data-bot-mark={shape}
      data-bot-mark-ink={ink}
      className="shrink-0 overflow-visible"
      style={{ width: size, height: size, color: `var(--bot-ink-${ink})` }}
    >
      <mask id={`${id}-eyes`} maskUnits="userSpaceOnUse" x="-96" y="-96" width="384" height="384">
        <rect x="-96" y="-96" width="384" height="384" fill="white" />
        <path d={drawing.eyes} fill="black" />
      </mask>
      <path d={drawing.body} fill="currentColor" mask={`url(#${id}-eyes)`} />
      {drawing.stem.map(({ d, tone }) => (
        <path
          key={tone}
          d={d}
          fill={tone === "cap" ? "var(--bot-stem-cap)" : "var(--bot-stem)"}
          opacity={drawing.stemOpacity}
        />
      ))}
    </svg>
  );
}

/**
 * A 1px ring that follows the body's outline 3px outside it, as the reference marks the picked
 * body. Drawn in the cell mark's own units, so it scales with the mark.
 */
function SelectionRing({ shape, className }: { shape: BotMarkShape; className: string }) {
  const id = useId();
  const { body } = botMarkRestDrawing(shape);
  const [, , span] = BOT_MARK_VIEWBOX.split(" ").map(Number);
  const unitsPerPixel = (span ?? 1) / CELL_MARK;
  const outer = 2 * (RING_GAP + 1) * unitsPerPixel;
  const inner = 2 * RING_GAP * unitsPerPixel;
  return (
    <svg
      viewBox={BOT_MARK_VIEWBOX}
      aria-hidden="true"
      className={cn("pointer-events-none overflow-visible", className)}
      style={{ width: CELL_MARK, height: CELL_MARK }}
    >
      <mask id={`${id}-ring`} maskUnits="userSpaceOnUse" x="-96" y="-96" width="384" height="384">
        <path d={body} fill="white" stroke="white" strokeWidth={outer} strokeLinejoin="round" />
        <path d={body} fill="black" stroke="black" strokeWidth={inner} strokeLinejoin="round" />
      </mask>
      <rect
        x="-96"
        y="-96"
        width="384"
        height="384"
        fill="currentColor"
        mask={`url(#${id}-ring)`}
      />
    </svg>
  );
}

function useShapeName(shape: BotMarkShape): string {
  const { t } = useLingui();
  switch (shape) {
    case "blob":
      return t`blob`;
    case "pebble":
      return t`pebble`;
    case "bean":
      return t`bean`;
    case "egg":
      return t`egg`;
    case "squircle":
      return t`squircle`;
    case "tablet":
      return t`tablet`;
    case "capsule":
      return t`capsule`;
    case "cylinder":
      return t`cylinder`;
    case "hex":
      return t`hex`;
    case "gem":
      return t`gem`;
    case "crystal":
      return t`crystal`;
    case "wedge":
      return t`wedge`;
    case "shield":
      return t`shield`;
    case "dome":
      return t`dome`;
    case "arch":
      return t`arch`;
    case "cloud":
      return t`cloud`;
    case "teardrop":
      return t`teardrop`;
    case "leaf":
      return t`leaf`;
    case "square":
      return t`square`;
    case "sparkle":
      return t`sparkle`;
    case "clover":
      return t`clover`;
    case "flower":
      return t`flower`;
    case "heart":
      return t`heart`;
    case "house":
      return t`house`;
    case "star":
      return t`star`;
    case "pumpkin":
      return t`pumpkin`;
  }
}

function useInkName(ink: BotMarkInk): string {
  const { t } = useLingui();
  switch (ink) {
    case "neutral":
      return t`Black`;
    case "brown":
      return t`Brown`;
    case "red":
      return t`Red`;
    case "orange":
      return t`Orange`;
    case "yellow":
      return t`Yellow`;
    case "green":
      return t`Green`;
    case "cyan":
      return t`Cyan`;
    case "blue":
      return t`Blue`;
    case "purple":
      return t`Violet`;
    case "magenta":
      return t`Magenta`;
    case "gray":
      return t`Gray`;
  }
}
