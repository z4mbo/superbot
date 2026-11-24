import { Trans, useLingui } from "@lingui/react/macro";
import type { AvatarCrop } from "@rakazo/core";
import {
  AVATAR_CROP_MAX_ZOOM,
  avatarCropSquare,
  botLookState,
  botMarkInkFor,
  botMarkShapeFor,
  centeredAvatarCrop,
  clampAvatarCrop,
  resolvePersonaColorDef,
} from "@rakazo/core";
import {
  BotAvatar,
  Button,
  cn,
  defaultBotAvatarValue,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@rakazo/ui-web";
import { Pencil } from "lucide-react";
import type { ClipboardEvent, DragEvent, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useRef, useState } from "react";
import type { BotPickedLook } from "./bot-look-picker";
import { BotLookPicker } from "./bot-look-picker";

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
  const [tab, setTab] = useState<"bot" | "upload">("bot");
  const [staged, setStaged] = useState<BotPickedLook | null>(null);
  const [picked, setPicked] = useState<PickedImage | null>(null);
  const photo = botLookState(value).photo;
  const shown = photo ? staged : null;
  const current = shown ?? pickedLook(identity, value, look);
  const customLook = look.lookShape !== null || look.lookColor !== null;

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setStaged(null);
      setPicked(null);
      setTab("bot");
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

  function takePhoto(file: File) {
    void loadImage(file).then((image) => {
      if (image) setPicked({ image, crop: centeredAvatarCrop(image) });
    });
  }

  function setPickedAvatar({ image, crop }: PickedImage) {
    onChange(croppedPhoto(image, crop));
    openChange(false);
  }

  const reset = photo
    ? { label: t`Reset to the Bot`, run: removePhoto }
    : tab === "bot" && customLook
      ? { label: t`Reset character to default`, run: () => onLookChange(EMPTY_LOOK) }
      : null;

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
        onPasteCapture={(event) => {
          const file = pastedImage(event);
          if (!file) return;
          event.preventDefault();
          setTab("upload");
          takePhoto(file);
        }}
      >
        <Tabs
          value={tab}
          onValueChange={(next) => {
            setStaged(null);
            setPicked(null);
            setTab(next === "upload" ? "upload" : "bot");
          }}
          className="gap-0"
        >
          <div className="flex items-center gap-2 border-b border-hairline p-2">
            <TabsList
              aria-label={t`Avatar source`}
              className="h-auto flex-1 justify-start gap-0.5 bg-transparent p-0 group-data-horizontal/tabs:h-auto"
            >
              <AvatarTab value="bot">
                <Trans>Bot</Trans>
              </AvatarTab>
              <AvatarTab value="upload">
                <Trans>Upload</Trans>
              </AvatarTab>
            </TabsList>
            {reset ? (
              <Button
                variant="ghost"
                size="xs"
                aria-label={reset.label}
                onClick={reset.run}
                className="rounded-sm text-body-sm font-normal text-muted-foreground"
              >
                <Trans>Reset</Trans>
              </Button>
            ) : null}
          </div>
          <TabsContent value="bot" className="flex flex-col gap-3 p-3">
            <BotLookPicker look={current} onChange={pick} />
            {photo ? (
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={() => openChange(false)}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button className="flex-1" disabled={!staged} onClick={setAvatar}>
                  <Trans>Set avatar</Trans>
                </Button>
              </div>
            ) : null}
          </TabsContent>
          <TabsContent value="upload" className="flex min-h-60 flex-col p-3">
            {picked ? (
              <AvatarCropper
                picked={picked}
                onChange={setPicked}
                onRestart={() => setPicked(null)}
                onDone={() => setPickedAvatar(picked)}
              />
            ) : (
              <PhotoDropzone onFile={takePhoto} />
            )}
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

function AvatarTab({ value, children }: { value: "bot" | "upload"; children: ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      className="h-6.5 flex-none rounded-full px-2 py-1 text-body-sm font-normal text-muted-foreground after:hidden hover:bg-secondary hover:text-foreground data-active:bg-secondary data-active:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-secondary"
    >
      {children}
    </TabsTrigger>
  );
}

/** An image file, decoded; nothing when it is not an image the browser can draw. */
function loadImage(file: File): Promise<HTMLImageElement | null> {
  if (!file.type.startsWith("image/")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = (event) => {
      const src = event.target?.result;
      if (typeof src !== "string") return resolve(null);
      const img = new Image();
      img.onerror = () => resolve(null);
      img.onload = () => resolve(img.width && img.height ? img : null);
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

/** The kept square of an image as the avatar's photo: clipped round, 256px across. */
function croppedPhoto(image: HTMLImageElement, crop: AvatarCrop): string {
  const canvas = document.createElement("canvas");
  const targetSize = 256;
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.beginPath();
    ctx.arc(targetSize / 2, targetSize / 2, targetSize / 2, 0, Math.PI * 2);
    ctx.clip();
    const { left, top, side } = avatarCropSquare(image, crop);
    ctx.drawImage(image, left, top, side, side, 0, 0, targetSize, targetSize);
  }
  return canvas.toDataURL("image/webp", 0.9);
}

/** The first image on the clipboard, if any. */
function pastedImage(event: ClipboardEvent): File | null {
  for (const item of event.clipboardData?.items ?? []) {
    const file = item.type.startsWith("image/") ? item.getAsFile() : null;
    if (file) return file;
  }
  return null;
}

/** Drop or browse for an image. */
function PhotoDropzone({ onFile }: { onFile: (file: File) => void }) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onFile(file);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the drop target; Browse files is the control.
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={cn(
        "flex min-h-47.5 flex-1 flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-border px-3 text-center",
        dragOver && "bg-secondary",
      )}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
        }}
      />
      <span className="text-body leading-5.5 text-muted-foreground">
        <Trans>Drag, drop, or paste an image</Trans>
      </span>
      <span className="text-body leading-5.5 text-faint-foreground">
        <Trans>or</Trans>
      </span>
      <Button
        variant="secondary"
        onClick={() => fileInputRef.current?.click()}
        className="rounded-[10px] font-normal text-body-sm"
      >
        <Trans>Browse files</Trans>
      </Button>
    </div>
  );
}

interface PickedImage {
  image: HTMLImageElement;
  crop: AvatarCrop;
}

/** The round crop preview, as large as the reference's. */
const CROP_VIEWPORT = 96;
const CROP_KEY_STEP = 4;

/** Drag or use the arrow keys to position an uploaded image, and the slider to zoom it. */
function AvatarCropper({
  picked,
  onChange,
  onRestart,
  onDone,
}: {
  picked: PickedImage;
  onChange: (next: PickedImage) => void;
  onRestart: () => void;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const { image, crop } = picked;
  const drag = useRef<{ x: number; y: number } | null>(null);
  const { left, top, side } = avatarCropSquare(image, crop);
  const scale = CROP_VIEWPORT / side;

  function move(dx: number, dy: number) {
    onChange({
      image,
      crop: clampAvatarCrop(image, { ...crop, x: crop.x - dx / scale, y: crop.y - dy / scale }),
    });
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (!drag.current) return;
    move(event.clientX - drag.current.x, event.clientY - drag.current.y);
    drag.current = { x: event.clientX, y: event.clientY };
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const step = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[
      event.key
    ];
    if (!step) return;
    event.preventDefault();
    move(step[0]! * CROP_KEY_STEP, step[1]! * CROP_KEY_STEP);
  }

  return (
    <div className="flex flex-1 flex-col items-center gap-2" data-testid="avatar-cropper">
      <button
        type="button"
        aria-label={t`Image position`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={handleKeyDown}
        className="relative cursor-grab touch-none overflow-hidden rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        style={{ width: CROP_VIEWPORT, height: CROP_VIEWPORT }}
      >
        <img
          src={image.src}
          alt=""
          draggable={false}
          className="pointer-events-none absolute max-w-none select-none"
          style={{
            left: -left * scale,
            top: -top * scale,
            width: image.width * scale,
            height: image.height * scale,
          }}
        />
      </button>
      <input
        type="range"
        aria-label={t`Zoom`}
        min={1}
        max={AVATAR_CROP_MAX_ZOOM}
        step={0.01}
        value={crop.zoom}
        onChange={(event) =>
          onChange({
            image,
            crop: clampAvatarCrop(image, { ...crop, zoom: Number(event.target.value) }),
          })
        }
        className="w-full accent-primary"
      />
      <div className="flex w-full gap-2">
        <Button variant="secondary" className="flex-1" onClick={onRestart}>
          <Trans>Restart</Trans>
        </Button>
        <Button className="flex-1" onClick={onDone}>
          <Trans>Set avatar</Trans>
        </Button>
      </div>
    </div>
  );
}
