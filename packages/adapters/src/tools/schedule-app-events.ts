import type { JobPublisher } from "@rakazo/adapter-kit";
import type { RoutineWatch } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { AppEventConnectors, ResolvedAppEvent } from "../routines/routine-app-events.js";
import {
  listAppEventSources,
  resolveRoutineAppEvents,
  saveRoutineAppEventsIn,
  settleRoutineAppEvents,
} from "../routines/routine-app-events.js";
import type { ToolAppEvent } from "../routines/routine-triggers.js";

type Deps = {
  prisma: PrismaClient;
  jobs: JobPublisher;
  connectors?: AppEventConnectors;
};

export const TOOL_CHECKED_APP_EVENT_CONFLICT =
  "This app event is checked for changes, like a watch: it takes no schedule or other watch.";

/**
 * The app events a schedule tool's `on.apps` names, each from the owner's one connected account
 * of that app. Deliveries run as the bot's creator, so only their routines take them. An unknown
 * event's error lists the app's events, so the bot can pick one.
 */
export async function toolAppEventsFor(
  deps: Pick<Deps, "prisma" | "connectors">,
  owner: { spaceId: string; userId: string; botId: string },
  apps: readonly ToolAppEvent[],
): Promise<
  { ok: true; events: ResolvedAppEvent[]; watch: RoutineWatch | null } | { error: string }
> {
  if (!apps.length) return { ok: true, events: [], watch: null };
  const bot = await deps.prisma.bot.findFirst({
    where: { id: owner.botId, spaceId: owner.spaceId, archivedAt: null },
    select: { userId: true },
  });
  if (!bot) return { error: "Bot not found." };
  if (bot.userId !== owner.userId) {
    return { error: "Only the bot's creator can start its routines from events." };
  }
  const sources = await listAppEventSources(deps, owner);
  const inputs = [];
  for (const entry of apps) {
    const key = entry.app.trim().toLowerCase();
    const source = sources.find((candidate) => candidate.app.toLowerCase() === key);
    if (!source) {
      const named = sources.map((candidate) => candidate.app).join(", ");
      return {
        error: `${entry.app} is not connected or has no events. ${named ? `Apps with events: ${named}.` : "The user connects the app first."}`,
      };
    }
    if (source.connections.length > 1) {
      return {
        error: `More than one ${source.name} account is connected; the user picks one in the routine editor.`,
      };
    }
    const event = source.events.find((candidate) => candidate.id === entry.event);
    if (!event) {
      const list = source.events
        .map((candidate) => {
          const params = candidate.params.map((param) => param.key).join(", ");
          return `${candidate.id} (${candidate.label}${params ? `; params: ${params}` : ""})`;
        })
        .join(", ");
      return { error: `${source.name} events: ${list}.` };
    }
    inputs.push({
      app: source.app,
      event: event.id,
      connectionId: source.connections[0]!.id,
      params: entry.params,
    });
  }
  return resolveRoutineAppEvents(deps, owner, inputs);
}

/** Save a routine's app events after the routine itself, and make their subscriptions now. */
export async function attachToolAppEvents(
  deps: Deps,
  routine: { id: string; spaceId: string; userId: string },
  events: readonly ResolvedAppEvent[] | undefined,
  options: { syncNeeded?: boolean } = {},
): Promise<string | undefined> {
  try {
    const releases = await deps.prisma.$transaction((tx) =>
      saveRoutineAppEventsIn(tx, deps.jobs, routine, events, options),
    );
    await settleRoutineAppEvents(deps, routine.id, releases);
    return undefined;
  } catch (error) {
    getLogger().error("routine app events could not be saved", error, { "routine.id": routine.id });
    return "Could not save the app events. Try again.";
  }
}

/** A routine's app events as a bot reads them. */
export function toolAppEventsView(
  events: readonly Pick<ResolvedAppEvent, "app" | "event" | "params">[],
) {
  return events.map(({ app, event, params }) => ({
    app,
    event,
    ...(Object.keys(params).length ? { params } : {}),
  }));
}
