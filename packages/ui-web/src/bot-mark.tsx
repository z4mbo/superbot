import type { BotMarkEmotion, BotMarkInk, BotMarkShape, BotMarkState } from "@rakazo/core";
import {
  BOT_MARK_RADIUS,
  BOT_MARK_VIEWBOX,
  botMarkFrame,
  botMarkPath,
  botMarkSeed,
  botMarkShowcaseEmotion,
} from "@rakazo/core";
import { botInks } from "@rakazo/ui-tokens";
import type { CSSProperties, PointerEvent } from "react";
import { memo, useEffect, useId, useLayoutEffect, useRef } from "react";
import { cn } from "./lib/utils.js";

/**
 * One drawing per bot, reused everywhere it appears. Each source is a single even-odd path in a
 * hidden 8px layer; its outline is rebuilt once per animation frame, and every visible avatar of
 * that bot shows it through `<use>`. A source with no avatar on screen stops being drawn.
 */

type Instance = {
  element: SVGSVGElement;
  visible: boolean;
};

type Source = {
  id: string;
  path: SVGPathElement;
  shape: BotMarkShape;
  state: BotMarkState;
  showcase: boolean;
  seed: number;
  instances: Set<Instance>;
  pokedAt: number | null;
  gaze: [number, number] | null;
  d: string;
};

const sources = new Map<string, Source>();
let layer: SVGSVGElement | null = null;
let frame = 0;
let pointer: [number, number] | null = null;
let reducedMotion = false;

const SVG = "http://www.w3.org/2000/svg";

function ensureLayer(): SVGSVGElement {
  if (layer?.isConnected) return layer;
  layer = document.createElementNS(SVG, "svg");
  layer.setAttribute("aria-hidden", "true");
  layer.setAttribute("data-bot-mark-sources", "");
  Object.assign(layer.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "8px",
    height: "8px",
    overflow: "hidden",
    opacity: "0",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  layer.append(document.createElementNS(SVG, "defs"));
  document.body.append(layer);
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion = media.matches;
  media.addEventListener("change", () => {
    reducedMotion = media.matches;
    for (const source of sources.values()) draw(source, performance.now());
    schedule();
  });
  window.addEventListener(
    "pointermove",
    (event) => {
      pointer = [event.clientX, event.clientY];
      schedule();
    },
    { passive: true },
  );
  document.documentElement.addEventListener("pointerleave", () => {
    pointer = null;
  });
  return layer;
}

function sourceFor(
  key: string,
  shape: BotMarkShape,
  state: BotMarkState,
  identity: string,
  showcase: boolean,
) {
  const existing = sources.get(key);
  if (existing) return existing;
  const path = document.createElementNS(SVG, "path");
  const id = `bot-mark-${sources.size}-${botMarkSeed(key).toString(36)}`;
  path.id = id;
  path.setAttribute("fill", "currentColor");
  path.setAttribute("fill-rule", "evenodd");
  ensureLayer().firstChild?.appendChild(path);
  const source: Source = {
    id,
    path,
    shape,
    state,
    showcase,
    seed: botMarkSeed(identity),
    instances: new Set(),
    pokedAt: null,
    gaze: null,
    d: "",
  };
  sources.set(key, source);
  draw(source, performance.now());
  return source;
}

/** Where the pointer is relative to the source's first avatar on screen, in body radii. */
function pointerFor(source: Source): [number, number] | null {
  if (!pointer) return null;
  for (const instance of source.instances) {
    if (!instance.visible) continue;
    const rect = instance.element.getBoundingClientRect();
    const radius = ((rect.width * BOT_MARK_RADIUS) / 124) * 1;
    if (radius <= 0) continue;
    return [
      (pointer[0] - (rect.left + rect.width / 2)) / radius,
      (pointer[1] - (rect.top + rect.height / 2)) / radius,
    ];
  }
  return null;
}

function draw(source: Source, now: number) {
  const still = reducedMotion;
  const target = still ? null : pointerFor(source);
  // The face eases toward the pointer instead of snapping to it.
  if (target) {
    const [x, y] = target;
    source.gaze = source.gaze
      ? [source.gaze[0] + (x - source.gaze[0]) * 0.25, source.gaze[1] + (y - source.gaze[1]) * 0.25]
      : [x, y];
  }
  const time = still ? 0 : now;
  const emotion: BotMarkEmotion | null =
    source.showcase && !still ? botMarkShowcaseEmotion(now) : null;
  const d = botMarkPath(
    source.shape,
    botMarkFrame({
      state: source.state,
      time,
      seed: source.seed,
      pointer: still ? null : source.gaze,
      poke: source.pokedAt === null || still ? null : now - source.pokedAt,
      emotion,
    }),
  );
  if (d !== source.d) {
    source.d = d;
    source.path.setAttribute("d", d);
  }
}

function tick(now: number) {
  frame = 0;
  let active = false;
  for (const source of sources.values()) {
    const shown = [...source.instances].some((instance) => instance.visible);
    source.path.dataset.paused = shown ? "false" : "true";
    if (!shown) continue;
    draw(source, now);
    active = true;
  }
  if (active && !reducedMotion && !document.hidden) schedule();
}

function schedule() {
  if (frame || reducedMotion || typeof requestAnimationFrame === "undefined") return;
  frame = requestAnimationFrame(tick);
}

function release(key: string, source: Source, instance: Instance) {
  source.instances.delete(instance);
  if (source.instances.size > 0) return;
  source.path.remove();
  sources.delete(key);
}

const instances = new Set<Instance>();

/** Marks an avatar that is off screen or in a hidden tab, where its drawing stops. */
function markPaused(instance: Instance) {
  instance.element.dataset.paused = String(!instance.visible || document.hidden);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const instance of instances) markPaused(instance);
    if (!document.hidden) schedule();
  });
}

export type BotMarkProps = {
  /** The bot's id: picks its blink rhythm and keeps one drawing per bot. */
  identity: string;
  shape: BotMarkShape;
  ink: BotMarkInk;
  state?: BotMarkState;
  size: number;
  /** Cycles through the emotions, as on the welcome screen. */
  showcase?: boolean;
  /** The live activity behind the state, kept on the element for tests and styling. */
  activity?: string;
  className?: string;
};

/** A bot's mark at one size; every mark of the same bot shares one drawing. */
export const BotMark = memo(function BotMark({
  identity,
  shape,
  ink,
  state = "idle",
  size,
  showcase = false,
  activity,
  className,
}: BotMarkProps) {
  const ref = useRef<SVGSVGElement>(null);
  const fallbackId = useId();
  const key = `${identity || fallbackId}|${shape}|${state}|${showcase ? "showcase" : ""}`;
  const sourceRef = useRef<Source | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const source = sourceFor(key, shape, state, identity || fallbackId, showcase);
    sourceRef.current = source;
    const instance: Instance = { element, visible: true };
    source.instances.add(instance);
    instances.add(instance);
    markPaused(instance);
    element.firstElementChild?.setAttribute("href", `#${source.id}`);
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) instance.visible = entry.isIntersecting;
        markPaused(instance);
        schedule();
      });
      observer.observe(element);
    }
    schedule();
    return () => {
      observer?.disconnect();
      instances.delete(instance);
      release(key, source, instance);
      sourceRef.current = null;
    };
  }, [key, shape, state, identity, fallbackId, showcase]);
  useEffect(() => schedule(), []);
  const color = ink === "neutral" ? undefined : botInks[ink];
  return (
    <svg
      ref={ref}
      viewBox={BOT_MARK_VIEWBOX}
      aria-hidden="true"
      data-bot-mark={shape}
      data-bot-mark-state={state}
      data-bot-mark-ink={ink}
      data-activity={activity ?? state}
      data-working={state !== "idle" && state !== "error" && state !== "asleep" && state !== "done"}
      className={cn(
        "shrink-0 overflow-visible select-none",
        ink === "neutral" ? "text-black dark:text-white" : null,
        className,
      )}
      style={{ width: size, height: size, flex: "none", color } as CSSProperties}
      onPointerDown={(event: PointerEvent) => {
        if (event.button !== 0 || !sourceRef.current) return;
        sourceRef.current.pokedAt = performance.now();
        schedule();
      }}
    >
      <use />
    </svg>
  );
});
