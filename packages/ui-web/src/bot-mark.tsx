import type {
  BotMarkDrawing,
  BotMarkFrame,
  BotMarkInk,
  BotMarkPoke,
  BotMarkShape,
  BotMarkState,
} from "@rakazo/core";
import {
  BOT_MARK_BOX,
  BOT_MARK_VIEWBOX,
  botMarkRestDrawing,
  botMarkRestFrame,
  botMarkSeed,
} from "@rakazo/core";
import type { CSSProperties, ReactNode } from "react";
import { memo, useEffect, useId, useLayoutEffect, useRef } from "react";
import { cn } from "./lib/utils.js";

/**
 * One drawing per bot, reused everywhere it appears. Each source is a group in a hidden 8px
 * layer: the body in its ink with the eyes cut out by a mask, the pumpkin's stem over it, and the
 * dots of a morph behind it. Every visible avatar of that bot shows it through `<use>`.
 *
 * A source is first painted resting, which is all a still avatar ever shows. What makes marks
 * move is in `bot-mark-engine.ts`, loaded once the first mark mounts so it stays out of the page's
 * startup code; it then redraws a source once per animation frame while it moves. A source with
 * no avatar on screen, or one resting with nothing to follow, stops being drawn.
 */

export type BotMarkInstance = {
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

export type BotMarkSource = {
  id: string;
  parts: Parts;
  shape: BotMarkShape;
  state: BotMarkState;
  /** When the current state began, and the frame it took over from. */
  stateSince: number;
  previous: BotMarkFrame | null;
  showcase: boolean;
  seed: number;
  instances: Set<BotMarkInstance>;
  pokes: { kind: BotMarkPoke["kind"]; at: number; turns?: number }[];
  gaze: { x: number; y: number; hold: number };
  frame: BotMarkFrame | null;
  drawnAt: number;
  /** Everything last written to the drawing, so an unchanged frame writes nothing. */
  drawn: string;
  /** Clicks so far: each one plays the next of a spin, a bounce and a nod. */
  clicks: number;
};

/** What the engine is given: every source, and the one way to write a drawing into one. */
export type BotMarkHost = {
  sources: ReadonlyMap<string, BotMarkSource>;
  paint: (source: BotMarkSource, drawing: BotMarkDrawing) => void;
};

export type BotMarkEngine = {
  /** Draws a source's frame for `now`. */
  draw: (source: BotMarkSource, now: number) => void;
  /** Asks for the next animation frame, when anything moves. */
  schedule: () => void;
  /** Plays the next of a spin, a bounce and a nod. */
  poke: (source: BotMarkSource) => void;
};

const sources = new Map<string, BotMarkSource>();
let layer: SVGSVGElement | null = null;
let engine: BotMarkEngine | null = null;
let engineLoading = false;

const SVG = "http://www.w3.org/2000/svg";

/** Loads the engine once; a failed load leaves the marks resting and is tried again later. */
function loadEngine() {
  if (engineLoading) return;
  engineLoading = true;
  void import("./bot-mark-engine.js").then(
    ({ createBotMarkEngine }) => {
      engine = createBotMarkEngine({ sources, paint });
    },
    () => {
      engineLoading = false;
    },
  );
}

/** Animates what moves now that a mark is on screen, loading the engine first if need be. */
function schedule() {
  if (engine) engine.schedule();
  else loadEngine();
}

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
  const source: BotMarkSource = {
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
  if (engine) engine.draw(source, now);
  else {
    source.frame = botMarkRestFrame();
    paint(source, botMarkRestDrawing(shape));
  }
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

/** Writes a drawing into a source, touching only what changed. */
function paint(source: BotMarkSource, drawing: BotMarkDrawing) {
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

function setState(source: BotMarkSource, state: BotMarkState) {
  if (source.state === state) return;
  source.previous = source.frame;
  source.state = state;
  source.stateSince = performance.now();
  schedule();
}

function release(key: string, source: BotMarkSource, instance: BotMarkInstance) {
  source.instances.delete(instance);
  if (source.instances.size > 0) return;
  source.parts.group.remove();
  sources.delete(key);
}

const instances = new Set<BotMarkInstance>();

/** Marks an avatar that is off screen or in a hidden tab, where its drawing stops. */
function markPaused(instance: BotMarkInstance) {
  instance.element.dataset.paused = String(!instance.visible || document.hidden);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const instance of instances) markPaused(instance);
    if (!document.hidden) engine?.schedule();
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
  const sourceRef = useRef<BotMarkSource | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const source = sourceFor(key, shape, state, who, showcase);
    sourceRef.current = source;
    const instance: BotMarkInstance = {
      element,
      visible: true,
      region: hoverRegion(element),
      size,
    };
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
              if (sourceRef.current) engine?.poke(sourceRef.current);
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
