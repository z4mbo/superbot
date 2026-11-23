import type { BotAvatarSet, BotColorDef } from "@rakazo/contracts";
import { BOT_COLOR_LIST, BOT_COLORS } from "@rakazo/contracts";
import type { AvatarEyes, BotMarkState, LogoAvatarActivity } from "@rakazo/core";
import {
  avatarEyeRects,
  BOT_MARK_VIEWBOX,
  botEyeTone,
  botMarkInkFor,
  botMarkRestPath,
  botMarkShapeFor,
  DEFAULT_BOT_AVATAR_COLOR,
  isRunWorking,
  logoAvatarStatusActivity,
  resolvePersonaColorDef,
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
  SHIPPED_BOT_AVATAR_SHAPES,
  SHIPPED_BOT_AVATAR_VIEWBOX,
} from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useContext, useMemo } from "react";
import { useBotAvatarActivity } from "./bot-avatar-activity.js";
import { BotMark } from "./bot-mark.js";
import { cn } from "./lib/utils.js";
import "./styles.css";

export type { BotColorDef };
export { BOT_COLOR_LIST, BOT_COLORS, DEFAULT_BOT_AVATAR_COLOR, resolvePersonaColorDef };

export const BOT_SHAPES = SHIPPED_BOT_AVATAR_SHAPES;
export const SHIPPED_SHAPE_KEYS = SHIPPED_BOT_AVATAR_SHAPE_KEYS;
const _VIEWBOX = SHIPPED_BOT_AVATAR_VIEWBOX;

export const BOT_MASCOT_SHAPES = SHIPPED_SHAPE_KEYS.map(
  (k) => BOT_SHAPES[k] ?? FALLBACK_SHAPE_PATH,
);

const FALLBACK_SHAPE_PATH = BOT_SHAPES.hex ?? "";

export function parseBotAvatar(
  rawColor: string,
  _identity?: string,
): {
  color: string;
  shapeIndex?: number;
  isImage: boolean;
  imageUrl?: string;
} {
  if (!rawColor) return { color: "#F97316", isImage: false };
  // Only data: image URLs are rendered. Arbitrary http(s)/blob values in `color`
  // must not become <img src> (SSRF / tracking when other members view the bot).
  if (rawColor.startsWith("data:image/")) {
    return { color: "#F97316", isImage: true, imageUrl: rawColor };
  }
  if (rawColor.includes("::shape_")) {
    const parts = rawColor.split("::shape_");
    const rawShapeIdx = parts[1] ?? "0";
    const parsedShapeIdx = /^\d+$/.test(rawShapeIdx) ? Number(rawShapeIdx) : 0;
    const shapeIdx = Number.isSafeInteger(parsedShapeIdx) ? parsedShapeIdx : 0;
    return {
      color: parts[0] || "#F97316",
      shapeIndex: shapeIdx % SHIPPED_SHAPE_KEYS.length,
      isImage: false,
    };
  }
  return { color: rawColor, isImage: false };
}

const AVATAR_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function defaultBotAvatarValue(rawColor: string): string {
  const parsed = parseBotAvatar(rawColor);
  if (rawColor && !parsed.isImage && AVATAR_HEX.test(parsed.color)) return parsed.color;
  return DEFAULT_BOT_AVATAR_COLOR;
}

type BotLook = { lookShape?: string | null; lookColor?: string | null };

const BotLooks = createContext<ReadonlyMap<string, BotLook>>(new Map());

/** The shapes and inks people picked for their bots, so every avatar of a bot draws the same. */
export function BotLookProvider({
  bots,
  children,
}: {
  bots: readonly ({ id: string } & BotLook)[];
  children: ReactNode;
}) {
  const looks = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  return <BotLooks value={looks}>{children}</BotLooks>;
}

export interface BotAvatarProps {
  color: string;
  avatarSet?: BotAvatarSet;
  activity?: LogoAvatarActivity;
  size?: number;
  status?: string;
  identity?: string;
  /** The shape and ink a person picked (`Bot.lookShape`, `Bot.lookColor`), when known. */
  lookShape?: string | null;
  lookColor?: string | null;
  /** A state the run status cannot say, such as a sleeping computer. */
  state?: BotMarkState;
  className?: string;
}

export const BotAvatar = memo(function BotAvatar({
  color,
  activity,
  size = 36,
  status,
  identity = "",
  lookShape,
  lookColor,
  state,
  className,
}: BotAvatarProps) {
  const isWorking = isRunWorking(status);
  const picked = useContext(BotLooks).get(identity);
  const shapeName = lookShape ?? picked?.lookShape;
  const inkName = lookColor ?? picked?.lookColor;

  const parsed = useMemo(() => parseBotAvatar(color, identity), [color, identity]);
  const effectiveId = identity || parsed.color || "agent";

  const colorDef = useMemo(
    () => resolvePersonaColorDef(effectiveId, parsed.color),
    [effectiveId, parsed.color],
  );

  if (parsed.isImage && parsed.imageUrl) {
    return (
      <div
        className={cn("rakazo-bot-avatar relative shrink-0 select-none", className)}
        data-working={isWorking}
        style={{ width: size, height: size }}
      >
        <div className="rakazo-bot-avatar-picture relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-border bg-secondary">
          <img src={parsed.imageUrl} alt="" className="h-full w-full object-cover" />
        </div>
        {isWorking ? (
          <svg
            className="rakazo-bot-avatar-ring rakazo-bot-avatar-ring-working absolute pointer-events-none"
            style={{
              inset: -4,
              width: size + 8,
              height: size + 8,
            }}
            viewBox="0 0 48 48"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="24"
              cy="24"
              r="22"
              className="stroke-status-working"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeDasharray="45 80"
            />
          </svg>
        ) : null}
      </div>
    );
  }

  // Every drawn bot is one flat body with cut-out eyes, in the shape picked for it or the one its
  // identity picks; notification portraits draw the same.
  const shape = botMarkShapeFor(effectiveId, shapeName, parsed.shapeIndex);
  const ink = state === "asleep" ? "gray" : botMarkInkFor(inkName, colorDef.hex);
  if (activity !== undefined || state !== undefined) {
    const shown = state ?? botMarkStateForActivity(activity ?? logoAvatarStatusActivity(status));
    return (
      <BotMark
        identity={effectiveId}
        shape={shape}
        ink={ink}
        state={shown}
        activity={activity}
        size={size}
        className={className}
      />
    );
  }
  return (
    <LiveBotMark
      identity={effectiveId}
      shape={shape}
      ink={ink}
      status={status}
      size={size}
      className={className}
    />
  );
});

/** A mark that follows its bot's live activity feed, such as a tool it is running right now. */
function LiveBotMark({
  status,
  ...props
}: Omit<ComponentProps<typeof BotMark>, "state" | "activity"> & { status?: string }) {
  const activity = useBotAvatarActivity(props.identity, status);
  return <BotMark {...props} state={botMarkStateForActivity(activity)} activity={activity} />;
}

/** The mark state that shows a live activity: reading, writing and using a computer are work. */
function botMarkStateForActivity(activity: LogoAvatarActivity): BotMarkState {
  switch (activity) {
    case "reading":
    case "writing":
    case "computer":
    case "working":
      return "working";
    case "thinking":
      return "thinking";
    case "waiting":
      return "waiting";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function _BarEyes({ eyes }: { eyes: AvatarEyes }) {
  return avatarEyeRects(eyes).map((rect) => <rect key={rect.x} {...rect} />);
}

/** Eyes are cut-outs in the page color unless the body is nearly white or black. */
function _eyeFill(bodyHex: string): string {
  const tone = botEyeTone(bodyHex);
  if (tone === "dark") return "fill-foreground dark:fill-background";
  if (tone === "light") return "fill-background dark:fill-foreground";
  return "fill-background";
}

export function BotShapePreview({
  shapeIndex,
  identity,
  label,
  color,
  selected,
  onClick,
}: {
  /** An Avatar Studio shape; omit it to draw the organic body `identity` gets. */
  shapeIndex?: number;
  identity?: string;
  label?: string;
  color: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const key = shapeIndex === undefined ? undefined : botMarkShapeFor("", null, shapeIndex);
  const colorDef = resolvePersonaColorDef("preview", color);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label ?? key}
      aria-pressed={selected ?? false}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-xl transition-transform hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
        selected
          ? "ring-2 ring-primary ring-offset-2 ring-offset-popover bg-white/10"
          : "hover:bg-white/5",
      )}
    >
      {shapeIndex === undefined ? (
        <BotAvatar color={color} identity={identity} size={32} />
      ) : (
        <svg viewBox={BOT_MARK_VIEWBOX} className="size-8 overflow-visible" aria-hidden="true">
          <path
            d={botMarkRestPath(botMarkShapeFor("", null, shapeIndex))}
            fill={colorDef.hex}
            fillRule="evenodd"
          />
        </svg>
      )}
    </button>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-card">
        <span className="h-4 w-[7px] rounded-full bg-primary" />
        <span className="h-4 w-[7px] rounded-full bg-primary" />
      </div>
      {/* off-scale: wordmark sized to the 44px logo mark */}
      <span className="font-[Aeonik,ui-sans-serif] text-[28px] tracking-tight text-foreground">
        Superbot
      </span>
    </div>
  );
}
