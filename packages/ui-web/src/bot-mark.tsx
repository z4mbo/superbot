import type {
  BotMarkEmotion,
  BotMarkFrame,
  BotMarkInk,
  BotMarkPoke,
  BotMarkShape,
  BotMarkState,
} from "@rakazo/core";
import {
  BOT_MARK_BOX,
  BOT_MARK_VIEWBOX,
  BOT_MARK_ZOOM_ORIGIN,
  botMarkBlend,
  botMarkDrawing,
  botMarkFrame,
  botMarkSeed,
  botMarkShowcaseEmotion,
  botMarkZoom,
} from "@rakazo/core";
import type { CSSProperties, ReactNode } from "react";
import { memo, useEffect, useId, useLayoutEffect, useRef } from "react";
import { cn } from "./lib/utils.js";

/**
 * One drawing per bot, reused everywhere it appears. Each source is a group in a hidden 8px
 * layer: the body in its ink with the eyes cut out by a mask, the pumpkin's stem over it, and the
 * dots of a morph behind it. It is rebuilt once per animation frame while it moves, and every
 * visible avatar of that bot shows it through `<use>`. A source with no avatar on screen, or one
 * resting with nothing to follow, stops being drawn.
 */

type Instance = {
  element: SVGSVGElement;
  visible: boolean;
  /** The row or control around the avatar; the pointer over it turns the face. */
  region: Element;
  /** The avatar's size in pixels: small avatars grow while their bot is morphed. */
  size: number;
};

type Parts = {
  group: SVGGElement;
  holes: SVGPathElement;
  dots: SVGGElement;
  body: SVGGElement;
  outline: SVGPathElement;
  stem: SVGGElement;
};

type Source = {
  id: string;
  parts: Parts;
  shape: BotMarkShape;
  state: BotMarkState;
  /** When the current state began, and the frame it took over from. */
  stateSince: number;
  previous: BotMarkFrame | null;
  showcase: boolean;
  seed: number;
  instances: Set<Instance>;
  pokes: { kind: BotMarkPoke["kind"]; at: number; turns?: number }[];
  gaze: { x: number; y: number; hold: number };
  frame: BotMarkFrame | null;
  drawnAt: number;
  /** Everything last written to the drawing, so an unchanged frame writes nothing. */
  drawn: string;
  /** Clicks so far: each one plays the next of a spin, a bounce and a nod. */
  clicks: number;
};

const sources = new Map<string, Source>();
let layer: SVGSVGElement | null = null;
let frameRequest = 0;
let reducedMotion = false;
let pointer: [number, number] | null = null;

const SVG = "http://www.w3.org/2000/svg";
const BLEND_MS = 350;

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
    schedule();
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
  const id = `bot-mark-${sources.size}-${botMarkSeed(key).toString(36)}`;
  const parts = createParts(id);
  ensureLayer().firstChild?.appendChild(parts.group);
  const now = performance.now();
  const source: Source = {
    id,
    parts,
    shape,
    state,
    stateSince: now,
    previous: null,
    showcase,
    seed: botMarkSeed(identity),
    instances: new Set(),
    pokes: [],
    gaze: { x: 0, y: 0, hold: 0 },
    frame: null,
    drawnAt: now,
    drawn: "",
    clicks: 0,
  };
  sources.set(key, source);
  draw(source, now);
  return source;
}

function element<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/** A source's drawing: the dots behind, then the body with its eyes masked out and the stem. */
function createParts(id: string): Parts {
  const box = String(BOT_MARK_BOX * 2);
  const area = {
    maskUnits: "userSpaceOnUse",
    x: String(-BOT_MARK_BOX / 2),
    y: String(-BOT_MARK_BOX / 2),
    width: box,
    height: box,
  };
  const group = element("g", { id });
  const mask = element("mask", { id: `${id}-holes`, ...area });
  const holes = element("path", { fill: "black" });
  mask.append(
    element("rect", { x: area.x, y: area.y, width: box, height: box, fill: "white" }),
    holes,
  );
  const dots = element("g", { fill: "currentColor" });
  const body = element("g");
  const outline = element("path", { fill: "currentColor", mask: `url(#${id}-holes)` });
  const stem = element("g");
  body.append(outline, stem);
  group.append(mask, dots, body);
  return { group, holes, dots, body, outline, stem };
}

const STEM_FILL = { stem: "var(--bot-stem)", cap: "var(--bot-stem-cap)" } as const;

/** Writes a frame's drawing into a source, touching only what changed. */
function paint(source: Source, shape: BotMarkShape, frame: BotMarkFrame) {
  const drawing = botMarkDrawing(shape, frame);
  const signature = JSON.stringify(drawing);
  if (signature === source.drawn) return;
  source.drawn = signature;
  const { parts } = source;
  parts.outline.setAttribute("d", drawing.body);
  parts.holes.setAttribute("d", drawing.eyes);
  if (drawing.opacity < 1) parts.body.setAttribute("opacity", drawing.opacity.toFixed(3));
  else parts.body.removeAttribute("opacity");
  parts.stem.replaceChildren(
    ...drawing.stem.map(({ d, tone }) => element("path", { d, fill: STEM_FILL[tone] })),
  );
  if (drawing.stemOpacity < 1) parts.stem.setAttribute("opacity", drawing.stemOpacity.toFixed(3));
  else parts.stem.removeAttribute("opacity");
  parts.dots.replaceChildren(
    ...drawing.dots.map(({ cx, cy, r, opacity }) =>
      element("circle", {
        cx: cx.toFixed(2),
        cy: cy.toFixed(2),
        r: r.toFixed(2),
        ...(opacity < 1 ? { opacity: opacity.toFixed(3) } : {}),
      }),
    ),
  );
}

/** Grows a small avatar while its bot is morphed, so the dots stay legible. */
function zoomInstances(source: Source) {
  const frame = source.frame;
  const origin = BOT_MARK_ZOOM_ORIGIN.toFixed(3);
  for (const instance of source.instances) {
    const use = instance.element.firstElementChild;
    if (!use) continue;
    const zoom = frame ? botMarkZoom(frame, instance.size) : 1;
    if (zoom === 1) use.removeAttribute("transform");
    else
      use.setAttribute(
        "transform",
        `translate(${origin} ${origin}) scale(${zoom.toFixed(4)}) translate(-${origin} -${origin})`,
      );
  }
}

/** Where the pointer is as gaze for an avatar whose row it is over: x right, y up, ±1. */
function pointerGaze(instance: Instance): [number, number] | null {
  if (!pointer || !instance.visible) return null;
  const area = instance.region.getBoundingClientRect();
  const [px, py] = pointer;
  if (px < area.left || px > area.right || py < area.top || py > area.bottom) return null;
  const rect = instance.element.getBoundingClientRect();
  const reach = Math.max(rect.width, 1) * 0.5;
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  return [
    clamp((px - (rect.left + rect.width / 2)) / reach),
    clamp(-(py - (rect.top + rect.height / 2)) / reach),
  ];
}

/** Moves the held gaze toward the pointer over this bot's row, easing like a spring. */
function follow(source: Source, now: number) {
  let target: [number, number] | null = null;
  for (const instance of source.instances) target = pointerGaze(instance) ?? target;
  const step = 1 - 0.86 ** (Math.max(0, now - source.drawnAt) / (1000 / 60));
  const gaze = source.gaze;
  if (target) {
    const fresh = gaze.hold === 0;
    gaze.x = fresh ? target[0] : gaze.x + (target[0] - gaze.x) * step;
    gaze.y = fresh ? target[1] : gaze.y + (target[1] - gaze.y) * step;
  }
  const hold = target ? 1 : 0;
  gaze.hold += (hold - gaze.hold) * step;
  if (Math.abs(gaze.hold - hold) < 1e-3) gaze.hold = hold;
}

/** Whether the source still moves: a state that plays, a poke in flight, a blend or a gaze. */
function moving(source: Source, now: number) {
  if (reducedMotion) return false;
  if (source.showcase || source.state !== "idle") return true;
  if (source.pokes.length > 0 || source.previous) return true;
  const target = [...source.instances].some((instance) => pointerGaze(instance) !== null);
  return target || source.gaze.hold > 0 || now - source.stateSince < BLEND_MS;
}

function draw(source: Source, now: number) {
  const still = reducedMotion;
  if (!still) follow(source, now);
  source.drawnAt = now;
  source.pokes = source.pokes.filter((poke) => now - poke.at < 2000);
  const emotion: BotMarkEmotion | null =
    source.showcase && !still ? botMarkShowcaseEmotion(now) : null;
  let frame = botMarkFrame({
    state: source.state,
    time: still ? 0 : now - source.stateSince,
    seed: source.seed,
    shape: source.shape,
    gaze: still ? null : source.gaze,
    pokes: still ? [] : source.pokes.map((poke) => ({ ...poke, since: (now - poke.at) / 1000 })),
    emotion,
  });
  if (source.previous && !still) {
    const progress = (now - source.stateSince) / BLEND_MS;
    if (progress >= 1) source.previous = null;
    else frame = botMarkBlend(source.previous, frame, progress);
  }
  source.frame = frame;
  paint(source, source.shape, frame);
  zoomInstances(source);
}

function tick(now: number) {
  frameRequest = 0;
  let active = false;
  for (const source of sources.values()) {
    const shown = [...source.instances].some((instance) => instance.visible);
    source.parts.group.dataset.paused = shown ? "false" : "true";
    if (!shown) continue;
    const wasMoving = moving(source, now);
    draw(source, now);
    if (wasMoving || moving(source, now)) active = true;
  }
  if (active && !reducedMotion && !document.hidden) schedule();
}

function schedule() {
  if (frameRequest || reducedMotion || typeof requestAnimationFrame === "undefined") return;
  frameRequest = requestAnimationFrame(tick);
}

function setState(source: Source, state: BotMarkState) {
  if (source.state === state) return;
  const now = performance.now();
  source.previous = source.frame;
  source.state = state;
  source.stateSince = now;
  schedule();
}

function release(key: string, source: Source, instance: Instance) {
  source.instances.delete(instance);
  if (source.instances.size > 0) return;
  source.parts.group.remove();
  sources.delete(key);
}

const instances = new Set<Instance>();

/** What successive clicks play. */
const POKES = ["spin", "bounce", "nod"] as const;

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

/** The row or control an avatar sits in: the pointer over it turns the avatar's face. */
function hoverRegion(element: Element): Element {
  return (
    element.closest("[data-bot-mark-host], a, button, [role='button'], [role='option'], li") ??
    element
  );
}

/** Live states share one drawing per bot; the sleeping look draws on its own. */
function sourceKey(identity: string, shape: BotMarkShape, state: BotMarkState, showcase: boolean) {
  const look = state === "asleep" || state === "waking" ? "sleep" : "live";
  return `${identity}|${shape}|${look}|${showcase ? "showcase" : ""}`;
}

export type BotMarkProps = {
  /** The bot's id: picks its clip order and keeps one drawing per bot. */
  identity: string;
  shape: BotMarkShape;
  ink: BotMarkInk;
  state?: BotMarkState;
  size: number;
  /** Cycles through the emotions, as on the welcome screen. */
  showcase?: boolean;
  /** The live activity behind the state, kept on the element for tests and styling. */
  activity?: string;
  /** A click plays a spin, then a bounce, then a nod, as on the mark beside a bot's activity. */
  pokeable?: boolean;
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
  pokeable = false,
  className,
}: BotMarkProps) {
  const ref = useRef<SVGSVGElement>(null);
  const fallbackId = useId();
  const who = identity || fallbackId;
  const key = sourceKey(who, shape, state, showcase);
  const sourceRef = useRef<Source | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const source = sourceFor(key, shape, state, who, showcase);
    sourceRef.current = source;
    const instance: Instance = { element, visible: true, region: hoverRegion(element), size };
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
  }, [key, shape, state, who, showcase, size]);
  useEffect(() => {
    if (sourceRef.current) setState(sourceRef.current, state);
  }, [state]);
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
      className={cn("shrink-0 overflow-visible select-none", className)}
      style={
        { width: size, height: size, flex: "none", color: `var(--bot-ink-${ink})` } as CSSProperties
      }
      onClick={
        pokeable
          ? () => {
              const source = sourceRef.current;
              if (!source || reducedMotion) return;
              const kind = POKES[source.clicks % POKES.length]!;
              source.clicks += 1;
              source.pokes.push({ kind, at: performance.now() });
              schedule();
            }
          : undefined
      }
    >
      <use />
    </svg>
  );
});

/**
 * A sleeping bot's mark, breathing slowly with z's drifting up from its corner. The mark inside
 * carries the gray sleeping look; this only adds the motion around it.
 */
export function BotMarkSleep({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("bot-mark-sleep relative inline-flex", className)}>
      <span className="bot-mark-sleep-body inline-flex">{children}</span>
      <span aria-hidden="true" className="bot-mark-sleep-zs">
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}
