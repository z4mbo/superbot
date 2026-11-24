import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import { resolveBotAvatarSet } from "@rakazo/contracts";
import type { AvatarCrop, BotMarkInk } from "@rakazo/core";
import {
  AVATAR_CROP_MAX_ZOOM,
  avatarCropSquare,
  BOT_MARK_SHAPES,
  BOT_MARK_VIEWBOX,
  botLookState,
  botLookWithColor,
  botLookWithShape,
  botMarkInkFor,
  botMarkRestPath,
  botMarkShapeFor,
  centeredAvatarCrop,
  clampAvatarCrop,
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
} from "@rakazo/core";
import {
  BOT_COLORS,
  BotAvatar,
  BotShapePreview,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  defaultBotAvatarValue,
  resolvePersonaColorDef,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { Button } from "@rakazo/ui-web/components/ui/button";
import { Check, Pencil, Upload, X } from "lucide-react";
import type { ClipboardEvent, DragEvent, KeyboardEvent, PointerEvent } from "react";
import { useRef, useState } from "react";

/**
 * The shape grid and color row for a bot's look. With `organicIdentities`, the grid also offers
 * the organic body each identity draws (for a bot that has no id yet); without them, "Default"
 * restores the bot's own organic body.
 */
export function BotLookPicker({
  value,
  identity,
  organicIdentities,
  avatarSet = "organic",
  onAvatarSetChange,
  onChange,
}: {
  value: string;
  identity?: string;
  organicIdentities?: readonly string[];
  avatarSet?: BotAvatarSet;
  onAvatarSetChange?: (set: BotAvatarSet, value: string) => void;
  onChange: (value: string, identity?: string) => void;
}) {
  const {
    photo,
    shapeIndex,
    color: currentColor,
    defaultLook: isDefaultLook,
  } = botLookState(value);

  return (
    <div className="space-y-4">
      {/* Only one bot's own editor overrides the account's set; a new bot takes the default. */}
      {onAvatarSetChange ? (
        <Tabs
          value={avatarSet}
          onValueChange={(next) =>
            onAvatarSetChange(resolveBotAvatarSet(next), defaultBotAvatarValue(value))
          }
        >
          <TabsList className="w-full" aria-label={t`Icon set`}>
            <TabsTrigger value="organic" className="flex-1">
              <Trans>Original</Trans>
            </TabsTrigger>
            <TabsTrigger value="rakazo" className="flex-1">
              <Trans>Superbot</Trans>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      {avatarSet === "organic" ? (
        <div>
          {organicIdentities ? null : (
            <div className="mb-2 flex items-center justify-between">
              <div className="text-caption font-medium tracking-wider text-muted-foreground uppercase">
                <Trans>Shape</Trans>
              </div>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                data-testid="avatar-studio-default"
                aria-pressed={isDefaultLook}
                onClick={() => {
                  const next = defaultBotAvatarValue(value);
                  if (next !== value) onChange(next);
                }}
                className={`px-3 py-1 text-label font-medium transition-colors ${
                  isDefaultLook
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Trans>Default</Trans>
              </Button>
            </div>
          )}
          <div
            className={`grid place-items-center gap-2 ${organicIdentities ? "grid-cols-4 sm:grid-cols-8 sm:gap-1" : "grid-cols-4"}`}
          >
            {organicIdentities?.map((organicIdentity, index) => (
              <BotShapePreview
                key={organicIdentity}
                identity={organicIdentity}
                label={t`Shape ${index + 1}`}
                color={currentColor}
                selected={isDefaultLook && identity === organicIdentity}
                onClick={() => onChange(currentColor, organicIdentity)}
              />
            ))}
            {SHIPPED_BOT_AVATAR_SHAPE_KEYS.map((key, index) => (
              <BotShapePreview
                key={key}
                shapeIndex={index}
                color={currentColor}
                selected={shapeIndex === index}
                onClick={() => onChange(botLookWithShape(currentColor, index))}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div>
        {organicIdentities ? null : (
          <div className="mb-2 text-caption font-medium tracking-wider text-muted-foreground uppercase">
            <Trans>Color</Trans>
          </div>
        )}
        <div className="grid grid-cols-6 place-items-center gap-2">
          {BOT_COLORS.map((color) => {
            const selected = currentColor.toLowerCase() === color.toLowerCase() && !photo;
            return (
              <button
                key={color}
                type="button"
                onClick={() => onChange(botLookWithColor(value, color))}
                aria-label={t`Color ${color}`}
                aria-pressed={selected}
                className={`size-6 rounded-full border transition-transform hover:scale-110 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? "scale-105 border-transparent ring-2 ring-foreground ring-offset-2 ring-offset-popover"
                    : "border-border"
                }`}
                style={{ backgroundColor: color }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** A bot's picked mark: the shape and ink it is drawn in, by their shared names. */
export type BotMarkLook = { lookShape: string | null; lookColor: string | null };

const MARK_INKS: BotMarkInk[] = [
  "neutral",
  "blue",
  "cyan",
  "green",
  "magenta",
  "orange",
  "purple",
  "red",
  "yellow",
  "brown",
];

/** Every mark shape and ink; a pick saves to the bot's look, which every avatar of it draws. */
export function MarkLookPicker({
  identity,
  color,
  look,
  onChange,
}: {
  identity: string;
  color: string;
  look: BotMarkLook;
  onChange: (look: BotMarkLook) => void;
}) {
  const shape = botMarkShapeFor(
    identity,
    look.lookShape,
    botLookState(color).shapeIndex ?? undefined,
  );
  const ink = botMarkInkFor(
    look.lookColor,
    resolvePersonaColorDef(identity, botLookState(color).color).hex,
  );
  const inkStyle = (name: BotMarkInk) => ({ color: `var(--bot-ink-${name})` });
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-caption font-medium tracking-wider text-muted-foreground uppercase">
          <Trans>Shape</Trans>
        </div>
        <div
          className="grid grid-cols-7 place-items-center gap-1"
          data-testid="avatar-studio-shapes"
        >
          {BOT_MARK_SHAPES.map((name) => (
            <button
              key={name}
              type="button"
              aria-label={name}
              aria-pressed={shape === name}
              onClick={() => onChange({ ...look, lookShape: name })}
              className={`flex size-10 items-center justify-center rounded-lg transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${
                shape === name ? "bg-accent ring-1 ring-foreground/40" : ""
              }`}
              style={inkStyle(ink)}
            >
              <svg
                viewBox={BOT_MARK_VIEWBOX}
                className="size-7 overflow-visible"
                aria-hidden="true"
              >
                <path d={botMarkRestPath(name)} fill="currentColor" fillRule="evenodd" />
              </svg>
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-2 text-caption font-medium tracking-wider text-muted-foreground uppercase">
          <Trans>Color</Trans>
        </div>
        <div
          className="grid grid-cols-10 place-items-center gap-1"
          data-testid="avatar-studio-inks"
        >
          {MARK_INKS.map((name) => (
            <button
              key={name}
              type="button"
              aria-label={name}
              aria-pressed={ink === name}
              onClick={() => onChange({ ...look, lookColor: name })}
              className={`size-6 rounded-full bg-current transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring ${
                ink === name ? "ring-2 ring-foreground ring-offset-2 ring-offset-popover" : ""
              } ${name === "neutral" ? "ring-1 ring-border" : ""}`}
              style={inkStyle(name)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export interface AvatarStudioPopoverProps {
  value: string;
  identity?: string;
  status?: string;
  avatarSet?: BotAvatarSet;
  size?: number;
  onChange: (value: string, avatarSet?: BotAvatarSet) => void;
  /** The bot's picked mark; with `onLookChange` the studio offers every shape and ink. */
  look?: BotMarkLook;
  onLookChange?: (look: BotMarkLook) => void;
  disabled?: boolean;
}

export function AvatarStudioPopover({
  value,
  identity,
  status,
  avatarSet = "organic",
  size = 72,
  onChange,
  look,
  onLookChange,
  disabled = false,
}: AvatarStudioPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"bot" | "upload">("bot");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<PickedImage | null>(null);

  function restoreDefaultAvatar() {
    const next = defaultBotAvatarValue(value);
    if (next !== value) onChange(next);
    if (onLookChange && (look?.lookShape || look?.lookColor))
      onLookChange({ lookShape: null, lookColor: null });
  }

  function processImageFile(file: File) {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result as string;
      if (!src) return;
      const img = new Image();
      img.onload = () => {
        if (!img.width || !img.height) return;
        setPicked({ image: img, crop: centeredAvatarCrop(img) });
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }

  function setPickedAvatar({ image, crop }: PickedImage) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const targetSize = 256;
    canvas.width = targetSize;
    canvas.height = targetSize;
    if (!ctx) return;

    ctx.beginPath();
    ctx.arc(targetSize / 2, targetSize / 2, targetSize / 2, 0, Math.PI * 2);
    ctx.clip();

    const { left, top, side } = avatarCropSquare(image, crop);
    ctx.drawImage(image, left, top, side, side, 0, 0, targetSize, targetSize);

    onChange(canvas.toDataURL("image/webp", 0.9));
    setPicked(null);
    setOpen(false);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) processImageFile(file);
  }

  function handlePaste(event: ClipboardEvent<HTMLButtonElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item?.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) {
        processImageFile(file);
        break;
      }
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="group relative cursor-pointer rounded-2xl outline-none transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t`Customize bot avatar`}
        data-testid="avatar-studio-trigger"
      >
        <BotAvatar
          color={value}
          identity={identity}
          size={size}
          status={status}
          avatarSet={avatarSet}
          lookShape={look?.lookShape}
          lookColor={look?.lookColor}
        />
        <div className="absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border-2 border-background bg-secondary text-foreground shadow-md opacity-0 transition group-hover:scale-110 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100">
          <Pencil size={12} strokeWidth={2.2} />
        </div>
      </button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setPicked(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="w-[360px] max-w-full gap-4 rounded-3xl p-5 sm:max-w-[360px]"
          data-testid="avatar-studio"
        >
          <DialogHeader className="flex-row items-center justify-between space-y-0">
            <DialogTitle className="text-body font-semibold tracking-tight">
              <Trans>Avatar Studio</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Choose a bot shape, color, or upload an image</Trans>
            </DialogDescription>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full text-muted-foreground"
              aria-label={t`Close`}
            >
              <X size={16} />
            </Button>
          </DialogHeader>

          <div className="flex flex-col items-center justify-center py-2">
            <BotAvatar
              color={value}
              identity={identity}
              size={78}
              status={status}
              avatarSet={avatarSet}
              lookShape={look?.lookShape}
              lookColor={look?.lookColor}
            />
          </div>

          <Tabs
            value={activeTab}
            onValueChange={(next) => setActiveTab(next as "bot" | "upload")}
            className="gap-4"
          >
            <div className="flex items-center justify-between border-b border-border pb-1">
              <TabsList className="rounded-full">
                <TabsTrigger value="bot" className="rounded-full px-3 text-label">
                  <Trans>Bot</Trans>
                </TabsTrigger>
                <TabsTrigger value="upload" className="rounded-full px-3 text-label">
                  <Trans>Upload</Trans>
                </TabsTrigger>
              </TabsList>

              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={restoreDefaultAvatar}
                className="text-label text-muted-foreground"
              >
                <Trans>Reset</Trans>
              </Button>
            </div>

            <TabsContent value="bot" className="pt-1" data-testid="avatar-studio-bot-tab">
              {onLookChange && identity ? (
                <MarkLookPicker
                  identity={identity}
                  color={value}
                  look={look ?? { lookShape: null, lookColor: null }}
                  onChange={onLookChange}
                />
              ) : (
                <BotLookPicker
                  value={value}
                  identity={identity}
                  avatarSet={avatarSet}
                  onChange={(next) => onChange(next)}
                  onAvatarSetChange={(set, next) => onChange(next, set)}
                />
              )}
            </TabsContent>
            <TabsContent value="upload">
              {picked ? (
                <AvatarCropper
                  picked={picked}
                  onChange={setPicked}
                  onCancel={() => setPicked(null)}
                  onDone={() => setPickedAvatar(picked)}
                />
              ) : (
                <button
                  type="button"
                  aria-label={t`Image upload area`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onPaste={handlePaste}
                  onClick={() => fileInputRef.current?.click()}
                  className={`flex w-full flex-col items-center justify-center rounded-xl border border-dashed p-6 text-center transition-colors ${
                    dragOver
                      ? "border-primary bg-primary/10"
                      : "border-border bg-muted hover:border-foreground/30"
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) processImageFile(file);
                    }}
                  />
                  <div className="mb-2 grid size-10 place-items-center rounded-full bg-secondary text-muted-foreground">
                    <Upload size={18} strokeWidth={1.8} />
                  </div>
                  <p className="text-body-sm font-medium text-muted-foreground">
                    <Trans>Drag, drop, or paste an image</Trans>
                  </p>
                  <span className="mt-3 rounded-lg bg-secondary px-3 py-1.5 text-label font-medium text-foreground">
                    <Trans>Choose file</Trans>
                  </span>
                </button>
              )}
            </TabsContent>
          </Tabs>

          {picked && activeTab === "upload" ? null : (
            <DialogFooter className="border-border sm:justify-end">
              <Button variant="secondary" size="sm" type="button" onClick={() => setOpen(false)}>
                <Check size={14} />
                <Trans>Done</Trans>
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

interface PickedImage {
  image: HTMLImageElement;
  crop: AvatarCrop;
}

const CROP_VIEWPORT = 200;
const CROP_KEY_STEP = 8;

/** Drag or use the arrow keys to position an uploaded image, and the slider to zoom it. */
function AvatarCropper({
  picked,
  onChange,
  onCancel,
  onDone,
}: {
  picked: PickedImage;
  onChange: (next: PickedImage) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
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
    <div className="flex flex-col items-center gap-4" data-testid="avatar-cropper">
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
      <div className="flex w-full justify-end gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button size="sm" type="button" onClick={onDone}>
          <Trans>Set avatar</Trans>
        </Button>
      </div>
    </div>
  );
}
