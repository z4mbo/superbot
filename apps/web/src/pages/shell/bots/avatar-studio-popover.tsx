import { Trans, useLingui } from "@lingui/react/macro";
import { botLookState, botMarkInkFor, botMarkShapeFor, resolvePersonaColorDef } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import {
  BotAvatar,
  defaultBotAvatarValue,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@rakazo/ui-web";
import { Pencil } from "lucide-react";
import { Suspense, useState } from "react";
import { lazyComponent } from "../../../lib/platform/preload-recovery";
import type { BotPickedLook } from "./bot-look-picker";

const loadEditor = () => import("./avatar-editor");
const AvatarEditor = lazyComponent(() => loadEditor().then((module) => module.AvatarEditor));

/** A bot's picked mark: the shape and ink it is drawn in, by their shared names. */
export type BotMarkLook = { lookShape: string | null; lookColor: string | null };

const EMPTY_LOOK: BotMarkLook = { lookShape: null, lookColor: null };

/** The body and ink a bot draws: its picks, else what its identity and colour choose. */
export function pickedLook(identity: string, color: string, look: BotMarkLook): BotPickedLook {
  const state = botLookState(color);
  return {
    shape: botMarkShapeFor(identity, look.lookShape, state.shapeIndex ?? undefined),
    ink: botMarkInkFor(look.lookColor, resolvePersonaColorDef(identity, state.color).hex),
  };
}

function lookOf(picked: BotPickedLook): BotMarkLook {
  return { lookShape: picked.shape, lookColor: picked.ink };
}

export interface AvatarStudioPopoverProps {
  /** The bot's stored avatar value: a colour, or a photo as a data URL. */
  value: string;
  identity: string;
  status?: string;
  size?: number;
  /** A new photo, or the colour left after removing one. */
  onChange: (value: string) => void;
  /** The bot's picked mark; a pick saves at once, as every avatar of the bot draws it. */
  look?: BotMarkLook;
  onLookChange: (look: BotMarkLook) => void;
  disabled?: boolean;
}

/**
 * The bot's avatar with its edit menu: a click opens the Avatar editor under it, where the Bot
 * tab picks the body and colour (saved as they are picked) and Upload sets a photo. While a photo
 * is shown, picks wait for Set avatar, which replaces the photo with the mark.
 */
export function AvatarStudioPopover({
  value,
  identity,
  status,
  size = 64,
  onChange,
  look = EMPTY_LOOK,
  onLookChange,
  disabled = false,
}: AvatarStudioPopoverProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [staged, setStaged] = useState<BotPickedLook | null>(null);
  const photo = botLookState(value).photo;
  const shown = photo ? staged : null;
  const current = shown ?? pickedLook(identity, value, look);
  const customLook = look.lookShape !== null || look.lookColor !== null;

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setStaged(null);
    }
  }

  function pick(next: BotPickedLook) {
    if (photo) setStaged(next);
    else onLookChange(lookOf(next));
  }

  function removePhoto() {
    setStaged(null);
    onChange(defaultBotAvatarValue(value));
  }

  function setAvatar() {
    if (!staged) return;
    onLookChange(lookOf(staged));
    onChange(defaultBotAvatarValue(value));
    openChange(false);
  }

  return (
    <Popover open={open && !disabled} onOpenChange={openChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              disabled={disabled}
              aria-label={t`Edit Bot avatar`}
              data-testid="avatar-studio-trigger"
              // The mark turns to the pointer while it is over the avatar.
              data-bot-mark-host={identity}
              // Starts loading the menu's inside as soon as the pointer or focus arrives.
              onPointerEnter={() => void bestEffort("avatar-editor.preload", loadEditor())}
              onFocus={() => void bestEffort("avatar-editor.preload", loadEditor())}
              className="group/avatar relative flex cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ width: size, height: size }}
            />
          }
        >
          <span className="flex transition-[filter] duration-150 group-hover/avatar:brightness-30 group-focus-visible/avatar:brightness-30">
            <BotAvatar
              color={photo && staged ? defaultBotAvatarValue(value) : value}
              identity={identity}
              size={size}
              status={status}
              lookShape={shown?.shape ?? look.lookShape}
              lookColor={shown?.ink ?? look.lookColor}
            />
          </span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-white opacity-0 transition-opacity duration-150 group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100"
          >
            <Pencil className="size-3.5" strokeWidth={2} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Trans>Edit Avatar</Trans>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        sideOffset={6}
        aria-label={t`Avatar editor`}
        data-testid="avatar-studio"
        className="w-[298px] gap-0 rounded-xl border border-hairline p-0 shadow-popover ring-0"
      >
        <Suspense fallback={null}>
          <AvatarEditor
            look={current}
            photo={photo}
            staged={staged !== null}
            customLook={customLook}
            onPick={pick}
            onReset={() => onLookChange(EMPTY_LOOK)}
            onRemovePhoto={removePhoto}
            onSetAvatar={setAvatar}
            onPhoto={(dataUrl) => {
              onChange(dataUrl);
              openChange(false);
            }}
            onTabChange={() => setStaged(null)}
            onClose={() => openChange(false)}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
