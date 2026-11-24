import type { BotMarkEmotion } from "@rakazo/core";
import {
  BOT_MARK_ZOOM_ORIGIN,
  botMarkBlend,
  botMarkDrawing,
  botMarkFrame,
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

/** What successive clicks play. */
const POKES = ["spin", "bounce", "nod"] as const;

export function createBotMarkEngine({ sources, paint }: BotMarkHost): BotMarkEngine {
  let frameRequest = 0;
  let pointer: [number, number] | null = null;
  // Absent where there is no layout to query, as in a test document.
  const media =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  let reducedMotion = media?.matches ?? false;

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

  /** Where the pointer is as gaze for an avatar whose row it is over: x right, y up, ±1. */
  function pointerGaze(instance: BotMarkInstance): [number, number] | null {
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
  function follow(source: BotMarkSource, now: number) {
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
  function moving(source: BotMarkSource, now: number) {
    if (reducedMotion) return false;
    if (source.showcase || source.state !== "idle") return true;
    if (source.pokes.length > 0 || source.previous) return true;
    const target = [...source.instances].some((instance) => pointerGaze(instance) !== null);
    return target || source.gaze.hold > 0 || now - source.stateSince < BLEND_MS;
  }

  function draw(source: BotMarkSource, now: number) {
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
    paint(source, botMarkDrawing(source.shape, frame));
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

  media?.addEventListener("change", () => {
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
    poke(source) {
      if (reducedMotion) return;
      const kind = POKES[source.clicks % POKES.length]!;
      source.clicks += 1;
      source.pokes.push({ kind, at: performance.now() });
      schedule();
    },
  };
}
