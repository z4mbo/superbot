import type { BotMarkEmotion } from "@rakazo/core";
import {
  BOT_MARK_ZOOM_ORIGIN,
  botMarkBlend,
  botMarkDrawing,
  botMarkFrame,
  botMarkGazeAim,
  botMarkGazeSettled,
  botMarkGazeStep,
  botMarkPointerGaze,
  botMarkShowcaseEmotion,
  botMarkZoom,
} from "@rakazo/core/bot-mark-animation";
import type { BotMarkEngine, BotMarkHost, BotMarkSource } from "./bot-mark.js";

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

  /**
   * Where a source's face looks: at the pointer while it is inside the box of one of the bot's
   * avatars, straight ahead while one of those boxes is the open bot, else nowhere. With reduced
   * motion the face only ever looks straight ahead.
   */
  function gazeTarget(source: BotMarkSource): [number, number] | null {
    let pointed: [number, number] | null = null;
    let facing = false;
    for (const instance of source.instances) {
      facing ||= instance.selected;
      if (instance.pointer && instance.visible) {
        pointed = botMarkPointerGaze(instance.element.getBoundingClientRect(), instance.pointer);
      }
    }
    if (reducedMotion) return pointed || facing ? [0, 0] : null;
    return pointed ?? (facing ? [0, 0] : null);
  }

  /** Aims the face and eases it a frame on; with reduced motion it lands at once. */
  function follow(source: BotMarkSource, now: number) {
    const aimed = botMarkGazeAim(source.gaze, gazeTarget(source));
    source.gaze = reducedMotion
      ? { ...aimed, x: aimed.to[0], y: aimed.to[1], hold: aimed.held ? 1 : 0 }
      : botMarkGazeStep(aimed, (now - source.drawnAt) / 1000);
  }

  /** Whether the source still moves: a state that plays, a poke in flight, a blend or a gaze. */
  function moving(source: BotMarkSource, now: number) {
    if (reducedMotion) return false;
    if (source.showcase || source.state !== "idle") return true;
    if (source.pokes.length > 0 || source.previous) return true;
    const gaze = botMarkGazeAim(source.gaze, gazeTarget(source));
    return !botMarkGazeSettled(gaze) || now - source.stateSince < BLEND_MS;
  }

  function draw(source: BotMarkSource, now: number) {
    const still = reducedMotion;
    follow(source, now);
    source.drawnAt = now;
    source.pokes = source.pokes.filter((poke) => now - poke.at < 2000);
    const emotion: BotMarkEmotion | null =
      source.showcase && !still ? botMarkShowcaseEmotion(now) : null;
    let frame = botMarkFrame({
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
    poke(source) {
      if (reducedMotion) return;
      const kind = POKES[source.clicks % POKES.length]!;
      source.clicks += 1;
      source.pokes.push({ kind, at: performance.now() });
      schedule();
    },
  };
}
