import type { BotMarkEmotion, BotMarkState } from "@rakazo/core";
import {
  BOT_MARK_ZOOM_ORIGIN,
  botMarkBlend,
  botMarkDrawing,
  botMarkFollowsPointer,
  botMarkFrame,
  botMarkGazeAim,
  botMarkGazeSettled,
  botMarkGazeStep,
  botMarkPointerGaze,
  botMarkRestsAfter,
  botMarkShowcaseEmotion,
  botMarkZoom,
} from "@rakazo/core/bot-mark-animation";
import type { BotMarkEngine, BotMarkHost, BotMarkInstance, BotMarkSource } from "./bot-mark.js";

/**
 * What makes the bot marks move, loaded once the first mark is on screen. Until then each mark
 * shows its bot resting; this takes over from that picture, blending into each mark's state, and
 * then draws every source once per animation frame while it moves.
 */

const BLEND_MS = 350;
/** How long the face takes to morph in and out of surprise, in milliseconds. */
const FACE_MORPH_MS = 280;

/**
 * What the engine remembers of a source between frames: the state it last drew, whether that
 * state began on screen, and when the pointer last came onto or left the line around it.
 */
type Life = { state: BotMarkState; entered: boolean; emphasis: { on: boolean; at: number } };

const HOST = "[data-bot-mark-host]";

/**
 * The box an avatar answers the pointer in: the nearest element marked `data-bot-mark-host`
 * with this bot's identity, such as its roster row or pinned tile. An avatar with no host of its
 * own, or inside another bot's box, never follows the pointer.
 */
function hostOf(element: Element, identity: string): HTMLElement | null {
  const host = element.closest<HTMLElement>(HOST);
  const owner = host?.dataset.botMarkHost;
  return host && (owner === "" || owner === identity) ? host : null;
}

/** Where a gaze is headed, per source, read before anything is drawn. */
type Target = [number, number] | null;

/** What successive clicks play. */
const POKES = ["spin", "bounce", "nod"] as const;

export function createBotMarkEngine({ sources, paint }: BotMarkHost): BotMarkEngine {
  let frameRequest = 0;
  // Absent where there is no layout to query, as in a test document.
  const media =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  let reducedMotion = media?.matches ?? false;
  const lives = new WeakMap<BotMarkSource, Life>();

  /**
   * The pointer and the bot box it is over, shared by every mark. One listener on the window
   * notes it and asks for a frame; the frame then reads where each hovered mark sits. The face
   * itself takes no pointer events, so its box decides when it follows, not its drawing.
   */
  let pointer: { host: HTMLElement; at: [number, number] } | null = null;
  let hosted = 0;
  const onPointer = (event: PointerEvent) => {
    // A touch has no hover; the press already opens the bot.
    if (event.pointerType === "touch") return;
    const target = event.target instanceof Element ? event.target : null;
    const host = target?.closest<HTMLElement>(HOST) ?? null;
    if (!host && !pointer) return;
    pointer = host ? { host, at: [event.clientX, event.clientY] } : null;
    schedule();
  };
  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget || !pointer) return;
    pointer = null;
    schedule();
  };
  /** Listens while at least one avatar has a box of its own, and stops with the last. */
  function listen(on: boolean) {
    if (typeof window === "undefined") return;
    // `pointerover` also fires when the box under a still pointer changes, as after a scroll.
    if (on) {
      window.addEventListener("pointermove", onPointer, { passive: true });
      window.addEventListener("pointerover", onPointer, { passive: true });
      window.addEventListener("pointerout", onPointerOut, { passive: true });
      return;
    }
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("pointerover", onPointer);
    window.removeEventListener("pointerout", onPointerOut);
    pointer = null;
  }

  /** The source's life, noting a state that changed on screen and emphasis coming or going. */
  function lifeOf(source: BotMarkSource, now: number): Life {
    let life = lives.get(source);
    if (!life) {
      life = { state: source.state, entered: false, emphasis: { on: false, at: -Infinity } };
      lives.set(source, life);
    }
    if (life.state !== source.state) {
      life.state = source.state;
      life.entered = true;
    }
    const on = [...source.instances].some((instance) => instance.emphasized);
    if (on !== life.emphasis.on) life.emphasis = { on, at: now };
    return life;
  }

  /**
   * Listens to the boxes around an avatar: the pointer inside its own host box (through the one
   * shared listener) and whether that box is the open bot (`aria-current`) turn its face; the
   * pointer over the line it sits in (`data-bot-mark-emphasis`) surprises it.
   */
  function attach(instance: BotMarkInstance): () => void {
    const stops: (() => void)[] = [];
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
    ) => {
      target.addEventListener(type, listener, { passive: true });
      stops.push(() => target.removeEventListener(type, listener));
    };
    const host = hostOf(instance.element, instance.identity);
    instance.host = host;
    if (host) {
      if (hosted++ === 0) listen(true);
      stops.push(() => {
        instance.host = null;
        if (--hosted === 0) listen(false);
      });
      const current = () => {
        instance.selected = (host.getAttribute("aria-current") ?? "false") !== "false";
        schedule();
      };
      current();
      if (typeof MutationObserver !== "undefined") {
        const observer = new MutationObserver(current);
        observer.observe(host, { attributes: true, attributeFilter: ["aria-current"] });
        stops.push(() => observer.disconnect());
      }
    }
    const line = instance.element.closest<HTMLElement>("[data-bot-mark-emphasis]");
    if (line) {
      const emphasize = (value: boolean) => () => {
        instance.emphasized = value;
        schedule();
      };
      on(line, "pointerenter", emphasize(true));
      on(line, "pointerleave", emphasize(false));
    }
    return () => {
      for (const stop of stops) stop();
    };
  }

  /** Grows a small avatar while its bot is morphed, so the dots stay legible. */
  function zoomInstances(source: BotMarkSource) {
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

  /**
   * Where a source's face looks: at the pointer while it is inside the box of one of the bot's
   * avatars, straight ahead while one of those boxes is the open bot, else nowhere. With reduced
   * motion the face only ever looks straight ahead; asleep, it looks nowhere.
   */
  function gazeTarget(source: BotMarkSource): Target {
    if (!botMarkFollowsPointer(source.state)) return null;
    let pointed: [number, number] | null = null;
    let facing = false;
    for (const instance of source.instances) {
      facing ||= instance.selected;
      if (pointer && instance.visible && instance.host === pointer.host) {
        pointed = botMarkPointerGaze(instance.element.getBoundingClientRect(), pointer.at);
      }
    }
    if (reducedMotion) return pointed || facing ? [0, 0] : null;
    return pointed ?? (facing ? [0, 0] : null);
  }

  /** Aims the face and eases it a frame on; with reduced motion it lands at once. */
  function follow(source: BotMarkSource, now: number, target: Target) {
    const aimed = botMarkGazeAim(source.gaze, target);
    source.gaze = reducedMotion
      ? { ...aimed, x: aimed.to[0], y: aimed.to[1], hold: aimed.held ? 1 : 0 }
      : botMarkGazeStep(aimed, (now - source.drawnAt) / 1000);
  }

  /**
   * Whether the source still moves: a state that plays, a poke in flight, a blend, a gaze or the
   * face morphing in or out of surprise.
   */
  function moving(source: BotMarkSource, now: number, target: Target) {
    if (reducedMotion) return false;
    const life = lifeOf(source, now);
    const rests = botMarkRestsAfter(source.state, life.entered);
    if (source.showcase || rests === null) return true;
    if (now - source.stateSince < Math.max(rests * 1000, BLEND_MS)) return true;
    if (source.pokes.length > 0 || source.previous) return true;
    if (now - life.emphasis.at < FACE_MORPH_MS) return true;
    return !botMarkGazeSettled(botMarkGazeAim(source.gaze, target));
  }

  function draw(source: BotMarkSource, now: number, target: Target = gazeTarget(source)) {
    const still = reducedMotion;
    follow(source, now, target);
    source.drawnAt = now;
    source.pokes = source.pokes.filter((poke) => now - poke.at < 2000);
    const emotion: BotMarkEmotion | null =
      source.showcase && !still ? botMarkShowcaseEmotion(now) : null;
    const life = lifeOf(source, now);
    let frame = botMarkFrame({
      entered: life.entered && !still,
      emphasis: {
        on: life.emphasis.on,
        seconds: still ? Infinity : (now - life.emphasis.at) / 1000,
      },
      state: source.state,
      time: still ? 0 : now - source.stateSince,
      seed: source.seed,
      shape: source.shape,
      gaze: source.gaze,
      pokes: still ? [] : source.pokes.map((poke) => ({ ...poke, since: (now - poke.at) / 1000 })),
      emotion,
    });
    if (source.previous && !still) {
      const progress = (now - source.stateSince) / BLEND_MS;
      if (progress >= 1) source.previous = null;
      else frame = botMarkBlend(source.previous, frame, progress);
    }
    source.frame = frame;
    paint(source, botMarkDrawing(source.shape, frame));
    zoomInstances(source);
  }

  function tick(now: number) {
    frameRequest = 0;
    let active = false;
    // Every mark's place is read before any drawing is written, so a frame lays out once.
    const shown = new Map<BotMarkSource, Target>();
    for (const source of sources.values()) {
      const visible = [...source.instances].some((instance) => instance.visible);
      if (visible) shown.set(source, gazeTarget(source));
    }
    for (const source of sources.values()) {
      source.parts.group.dataset.paused = shown.has(source) ? "false" : "true";
    }
    for (const [source, target] of shown) {
      const wasMoving = moving(source, now, target);
      draw(source, now, target);
      if (wasMoving || moving(source, now, target)) active = true;
    }
    if (active && !reducedMotion && !document.hidden) schedule();
  }

  function schedule() {
    if (frameRequest || typeof requestAnimationFrame === "undefined") return;
    frameRequest = requestAnimationFrame(tick);
  }

  media?.addEventListener("change", () => {
    reducedMotion = media.matches;
    for (const source of sources.values()) draw(source, performance.now());
    schedule();
  });

  // Every mark so far was painted resting: each one blends from that picture into its state,
  // which leaves an idle mark exactly as it was.
  const now = performance.now();
  for (const source of sources.values()) {
    source.previous = source.frame;
    source.stateSince = now;
  }
  schedule();

  return {
    draw,
    schedule,
    attach,
    poke(source) {
      if (reducedMotion) return;
      const kind = POKES[source.clicks % POKES.length]!;
      source.clicks += 1;
      source.pokes.push({ kind, at: performance.now() });
      schedule();
    },
  };
}
