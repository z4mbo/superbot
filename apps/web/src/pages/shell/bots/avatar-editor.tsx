import { Trans, useLingui } from "@lingui/react/macro";
import type { AvatarCrop } from "@rakazo/core";
import {
  AVATAR_CROP_MAX_ZOOM,
  avatarCropSquare,
  centeredAvatarCrop,
  clampAvatarCrop,
} from "@rakazo/core";
import { Button, cn, Tabs, TabsContent, TabsList, TabsTrigger } from "@rakazo/ui-web";
import type { ClipboardEvent, DragEvent, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useRef, useState } from "react";
import type { BotPickedLook } from "./bot-look-picker";
import { BotLookPicker } from "./bot-look-picker";

/**
 * The inside of the agent edit menu, loaded when the menu first opens: Bot and Upload tabs with
 * Reset, the body and colour picker, and the photo dropzone and cropper.
 */
export function AvatarEditor({
  look,
  photo,
  staged,
  customLook,
  onPick,
  onReset,
  onRemovePhoto,
  onSetAvatar,
  onPhoto,
  onTabChange,
  onClose,
}: {
  /** The body and ink shown as picked: the staged pick over a photo, else the bot's own. */
  look: BotPickedLook;
  photo: boolean;
  staged: boolean;
  /** The bot has a picked body or ink that Reset can clear. */
  customLook: boolean;
  onPick: (look: BotPickedLook) => void;
  onReset: () => void;
  onRemovePhoto: () => void;
  onSetAvatar: () => void;
  onPhoto: (dataUrl: string) => void;
  onTabChange: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [tab, setTab] = useState<"bot" | "upload">("bot");
  const [picked, setPicked] = useState<PickedImage | null>(null);

  function takePhoto(file: File) {
    void loadImage(file).then((image) => {
      if (image) setPicked({ image, crop: centeredAvatarCrop(image) });
    });
  }

  const reset = photo
    ? { label: t`Reset to the Bot`, run: onRemovePhoto }
    : tab === "bot" && customLook
      ? { label: t`Reset character to default`, run: onReset }
      : null;

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        onTabChange();
        setPicked(null);
        setTab(next === "upload" ? "upload" : "bot");
      }}
      onPasteCapture={(event: ClipboardEvent<HTMLDivElement>) => {
        const file = pastedImage(event);
        if (!file) return;
        event.preventDefault();
        setTab("upload");
        takePhoto(file);
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
        <BotLookPicker look={look} onChange={onPick} />
        {photo ? (
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button className="flex-1" disabled={!staged} onClick={onSetAvatar}>
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
            onDone={() => onPhoto(croppedPhoto(picked.image, picked.crop))}
          />
        ) : (
          <PhotoDropzone onFile={takePhoto} />
        )}
      </TabsContent>
    </Tabs>
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
