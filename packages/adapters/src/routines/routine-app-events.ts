import type {
  AdapterContext,
  BackgroundJobPayloads,
  ConnectorEventType,
  JobPublisher,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import {
  appEventReleaseJob,
  appEventReleaseJobKey,
  routineAppEventsJob,
  routineAppEventsJobKey,
} from "@rakazo/adapter-kit";
import type {
  AppEventSource,
  RoutineAppEvent,
  RoutineAppEventInput,
  RoutineWatch,
} from "@rakazo/contracts";
import { RoutineAppEventInputSchema, RoutineWatchSchema } from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { LeaseHeldError, readJsonColumn, withLease } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import * as z from "zod";
import { sanitizeIntegrationError } from "../providers/integration/composio/composio-connector.js";

/** The connectors that can serve app events: the registry, or a test's stand-in. */
export type AppEventConnectors = {
  managed(id: string): ManagedConnectorProvider | undefined;
};

export type AppEventDeps = {
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn" | "enqueueManyIn" | "cancel">;
  connectors?: AppEventConnectors;
};

type Owner = { spaceId: string; userId: string };

/** One provider call's budget. */
const PROVIDER_CALL_MS = 30_000;
/** When a save's backup job runs if the direct attempt never reports back: its calls and a margin. */
const SYNC_BACKUP_MS = 5 * PROVIDER_CALL_MS + 30_000;
/** How long before a subscription lapses it is made again. */
const RENEW_AHEAD_MS = 10 * 60_000;
/** A delivery's routine is busy being changed; the backup job looks again this soon. */
const BUSY_RETRY_MS = 15_000;

export const APP_EVENT_RECONNECT = "Reconnect the app to start this routine.";

const ParamsSchema = z.record(z.string(), z.string());

function connectorContext(owner: Owner, operationId: string, botId?: string): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: owner.spaceId,
    userId: owner.userId,
    ...(botId ? { botId } : {}),
    signal: deadlineSignal(PROVIDER_CALL_MS),
  };
}

async function eventTypesOf(provider: ManagedConnectorProvider | undefined) {
  if (!provider?.eventTypes) return [];
  try {
    return await provider.eventTypes();
  } catch (error) {
    getLogger().warn("app event types could not be listed", {
      error: sanitizeIntegrationError(error),
    });
    return [];
  }
}

const sameApp = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The owner's connected apps that can start routines, and their events. */
export async function listAppEventSources(
  deps: Pick<AppEventDeps, "prisma" | "connectors">,
  owner: Owner,
): Promise<AppEventSource[]> {
  if (!deps.connectors) return [];
  const connections = await deps.prisma.connection.findMany({
    where: { spaceId: owner.spaceId, userId: owner.userId, status: "connected" },
    select: { id: true, connectorId: true, provider: true, displayName: true },
    orderBy: { createdAt: "asc" },
  });
  const sources: AppEventSource[] = [];
  for (const connectorId of new Set(connections.map((row) => row.connectorId))) {
    const types = await eventTypesOf(deps.connectors.managed(connectorId));
    const rows = connections.filter((row) => row.connectorId === connectorId);
    for (const app of new Set(types.map((type) => type.app))) {
      const accounts = rows.filter((row) => sameApp(row.provider, app));
      if (!accounts.length) continue;
      const name = accounts[0]!.displayName;
      sources.push({
        app,
        name,
        connections: accounts.map((row, index) => ({
          id: row.id,
          name: accounts.length > 1 ? `${row.displayName} ${index + 1}` : row.displayName,
        })),
        events: types
          .filter((type) => type.app === app)
          .map((type) => ({
            id: type.id,
            label: type.label,
            params: type.params.map(({ key, label, placeholder, optional }) => ({
              key,
              label,
              ...(placeholder ? { placeholder } : {}),
              ...(optional ? { optional } : {}),
            })),
          })),
      });
    }
  }
  return sources;
}

/** An app event checked against the owner's connections and its provider, ready to save. */
export type ResolvedAppEvent = {
  connectionId: string;
  connectorId: string;
  app: string;
  event: string;
  params: Record<string, string>;
  /** Seen by a change check because the provider does not push it. */
  checked: boolean;
};

/**
 * The app events a save asks for, each from one of the owner's connected accounts and declared by
 * its provider. An event the provider does not push is seen by the routine's change check instead,
 * so a routine holds at most one, and `watch` is that check.
 */
export async function resolveRoutineAppEvents(
  deps: Pick<AppEventDeps, "prisma" | "connectors">,
  owner: Owner,
  inputs: readonly RoutineAppEventInput[],
): Promise<
  { ok: true; events: ResolvedAppEvent[]; watch: RoutineWatch | null } | { error: string }
> {
  const events: ResolvedAppEvent[] = [];
  let watch: RoutineWatch | null = null;
  const seen = new Set<string>();
  for (const raw of inputs) {
    const parsed = RoutineAppEventInputSchema.safeParse(raw);
    if (!parsed.success) return { error: "An app event is not valid." };
    const input = parsed.data;
    const connection = await deps.prisma.connection.findFirst({
      where: {
        id: input.connectionId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        status: "connected",
      },
      select: { id: true, connectorId: true, provider: true, displayName: true },
    });
    if (!connection || !sameApp(connection.provider, input.app)) {
      return { error: "Connect the app first, then add its event." };
    }
    const types = await eventTypesOf(deps.connectors?.managed(connection.connectorId));
    const type = types.find(
      (candidate) => sameApp(candidate.app, input.app) && candidate.id === input.event,
    );
    if (!type) return { error: `${connection.displayName} has no such event.` };
    const params = paramsFor(type, input.params);
    if ("error" in params) return params;
    const key = JSON.stringify([connection.id, type.id, params.params]);
    if (seen.has(key)) continue;
    seen.add(key);
    const checked = !type.push;
    if (checked) {
      if (!type.poll) return { error: `${connection.displayName} can't deliver this event here.` };
      if (watch) return { error: "Only one app event can be checked for changes per routine." };
      const poll = type.poll(params.params);
      watch = RoutineWatchSchema.parse({ kind: "tool", ...poll, everyMinutes: 5 });
    }
    events.push({
      connectionId: connection.id,
      connectorId: connection.connectorId,
      app: type.app,
      event: type.id,
      params: params.params,
      checked,
    });
  }
  return { ok: true, events, watch };
}

function paramsFor(
  type: ConnectorEventType,
  given: Readonly<Record<string, string>>,
): { params: Record<string, string> } | { error: string } {
  const params: Record<string, string> = {};
  for (const key of Object.keys(given)) {
    if (!type.params.some((param) => param.key === key))
      return { error: `${type.label} has no ${key}.` };
  }
  for (const param of type.params) {
    const value = given[param.key]?.trim() ?? "";
    if (!value) {
      if (param.optional) continue;
      return { error: `Enter ${param.label.toLowerCase()} for ${type.label}.` };
    }
    if (param.pattern && !new RegExp(param.pattern.source).test(value)) {
      return { error: param.pattern.message };
    }
    params[param.key] = value;
  }
  return { params };
}

const eventKey = (row: { connectionId: string; app: string; event: string }, params: unknown) =>
  JSON.stringify([row.connectionId, row.app, row.event, sortedParams(params)]);

function sortedParams(value: unknown): Array<[string, string]> {
  const parsed = ParamsSchema.safeParse(value);
  return parsed.success ? Object.entries(parsed.data).sort(([a], [b]) => a.localeCompare(b)) : [];
}

/** Whether the routine's change check is its checked app event's. */
export async function hasCheckedAppEvent(
  prisma: Pick<PrismaClient, "routineAppEvent">,
  routineId: string,
): Promise<boolean> {
  return (await prisma.routineAppEvent.count({ where: { routineId, checked: true } })) > 0;
}

type Release = BackgroundJobPayloads["app-event.release"];

/**
 * Replace the routine's app events with `events`, keeping the ones it already has, in the
 * transaction that saves the routine. A dropped event's subscription is released by a job
 * committed with the drop; the rest are made by a backup job committed with the save, and a
 * pause or resume needs one too (`syncNeeded`). Call `settleRoutineAppEvents` after commit.
 */
export async function saveRoutineAppEventsIn(
  tx: Prisma.TransactionClient,
  jobs: Pick<JobPublisher, "enqueueIn" | "enqueueManyIn">,
  routine: { id: string; spaceId: string; userId: string },
  events: readonly ResolvedAppEvent[] | undefined,
  options: { syncNeeded?: boolean } = {},
): Promise<Release[]> {
  const existing = await tx.routineAppEvent.findMany({ where: { routineId: routine.id } });
  const releases: Release[] = [];
  let pushed = false;
  if (events) {
    const wanted = new Map(events.map((event) => [eventKey(event, event.params), event]));
    const kept = new Set<string>();
    const dropped: string[] = [];
    for (const row of existing) {
      const key = eventKey(row, row.settings);
      if (wanted.get(key)?.checked === row.checked && !kept.has(key)) {
        kept.add(key);
        continue;
      }
      dropped.push(row.id);
      if (row.handle) {
        releases.push({
          spaceId: routine.spaceId,
          userId: routine.userId,
          connectorId: row.connectorId,
          handle: row.handle,
        });
      }
    }
    if (dropped.length) await tx.routineAppEvent.deleteMany({ where: { id: { in: dropped } } });
    const added = [...wanted].filter(([key]) => !kept.has(key)).map(([, event]) => event);
    if (added.length) {
      await tx.routineAppEvent.createMany({
        data: added.map((event) => ({
          spaceId: routine.spaceId,
          routineId: routine.id,
          connectionId: event.connectionId,
          connectorId: event.connectorId,
          app: event.app,
          event: event.event,
          settings: event.params,
          checked: event.checked,
        })),
      });
    }
    if (releases.length) {
      await jobs.enqueueManyIn(
        tx,
        releases.map((release) => appEventReleaseJob(release)),
      );
    }
    pushed = added.some((event) => !event.checked);
  }
  if (pushed || (options.syncNeeded && existing.some((row) => !row.checked))) {
    await jobs.enqueueIn(
      tx,
      routineAppEventsJob(routine.id, new Date(Date.now() + SYNC_BACKUP_MS)),
    );
  }
  return releases;
}

/**
 * The work a save, delete or pause committed jobs for, done now: each released subscription
 * removed and the routine's subscriptions made to match it. A job whose work finished goes;
 * one that failed stays for the queue to retry.
 */
export async function settleRoutineAppEvents(
  deps: AppEventDeps,
  routineId: string | null,
  releases: readonly Release[] = [],
): Promise<void> {
  await Promise.all(
    releases.map(async (release) => {
      const done = await bestEffort("release app event", releaseAppEvent(deps, release));
      if (done)
        await bestEffort(
          "drop app event release job",
          deps.jobs.cancel(appEventReleaseJobKey(release)),
        );
    }),
  );
  if (routineId) await bestEffort("sync routine app events", syncRoutineAppEvents(deps, routineId));
}

/** Remove one subscription at its provider. Resolves true once it is gone. */
export async function releaseAppEvent(deps: Pick<AppEventDeps, "connectors">, release: Release) {
  const provider = deps.connectors?.managed(release.connectorId);
  // Nothing here can reach the provider any more, so nothing is left to try.
  if (!provider?.unsubscribeEvent) {
    getLogger().warn("app event subscription left at a provider this server no longer has", {
      "connector.id": release.connectorId,
    });
    return true;
  }
  await provider.unsubscribeEvent(
    release.handle,
    connectorContext(release, "routines.app-event.release"),
  );
  return true;
}

/**
 * Make the routine's pushed app events match it: subscribed while it is on, released while it is
 * off, and made again before the provider lets one lapse. One process at a time does this for a
 * routine; a sync that finds another holding it leaves the backup job to look again shortly.
 */
export async function syncRoutineAppEvents(deps: AppEventDeps, routineId: string): Promise<void> {
  try {
    await withLease(deps.prisma, `routine-app-events:${routineId}`, { ttlMs: SYNC_BACKUP_MS }, () =>
      syncHeld(deps, routineId),
    );
  } catch (error) {
    if (!(error instanceof LeaseHeldError)) throw error;
    await deps.jobs.enqueue(routineAppEventsJob(routineId, new Date(Date.now() + BUSY_RETRY_MS)));
  }
}

async function syncHeld(deps: AppEventDeps, routineId: string): Promise<void> {
  const routine = await deps.prisma.routine.findUnique({
    where: { id: routineId },
    select: { id: true, spaceId: true, userId: true, botId: true, active: true },
  });
  if (!routine) {
    await deps.jobs.cancel(routineAppEventsJobKey(routineId));
    return;
  }
  const rows = await deps.prisma.routineAppEvent.findMany({ where: { routineId, checked: false } });
  const renewBy = new Date(Date.now() + RENEW_AHEAD_MS);
  for (const row of rows) {
    if (!routine.active) {
      if (!row.handle) continue;
      await releaseAppEvent(deps, { ...routine, connectorId: row.connectorId, handle: row.handle });
      await deps.prisma.routineAppEvent.updateMany({
        where: { id: row.id, handle: row.handle },
        data: { handle: null, renewAt: null },
      });
      continue;
    }
    if (row.handle && (!row.renewAt || row.renewAt > renewBy)) continue;
    await subscribeRow(deps, routine, row);
  }
  const next = await deps.prisma.routineAppEvent.findFirst({
    where: { routineId, handle: { not: null }, renewAt: { not: null } },
    orderBy: { renewAt: "asc" },
    select: { renewAt: true },
  });
  if (routine.active && next?.renewAt) {
    const at = new Date(Math.max(Date.now(), next.renewAt.getTime() - RENEW_AHEAD_MS));
    await deps.jobs.enqueue(routineAppEventsJob(routineId, at));
  } else {
    await deps.jobs.cancel(routineAppEventsJobKey(routineId));
  }
}

async function subscribeRow(
  deps: AppEventDeps,
  routine: { id: string; spaceId: string; userId: string; botId: string },
  row: Prisma.RoutineAppEventGetPayload<object>,
): Promise<void> {
  const fail = (error: string) =>
    deps.prisma.routineAppEvent.updateMany({
      where: { id: row.id, handle: row.handle },
      data: { error },
    });
  const connection = await deps.prisma.connection.findFirst({
    where: {
      id: row.connectionId,
      spaceId: routine.spaceId,
      userId: routine.userId,
      status: "connected",
    },
    select: { providerRef: true },
  });
  if (!connection) {
    await fail(APP_EVENT_RECONNECT);
    return;
  }
  const provider = deps.connectors?.managed(row.connectorId);
  if (!provider?.subscribeEvent) {
    await fail("This server can't receive this app's events now.");
    return;
  }
  const params = readJsonColumn(
    ParamsSchema,
    row.settings,
    { table: "routine_app_events", column: "settings", id: row.id },
    { fallback: {} },
  );
  let subscription: Awaited<ReturnType<NonNullable<ManagedConnectorProvider["subscribeEvent"]>>>;
  try {
    subscription = await provider.subscribeEvent(
      { app: row.app, event: row.event, params, connectionRef: connection.providerRef },
      connectorContext(routine, "routines.app-event.subscribe", routine.botId),
    );
  } catch (error) {
    getLogger().warn("app event subscription failed", {
      error: sanitizeIntegrationError(error),
      "routine.id": routine.id,
    });
    await fail(`Couldn't subscribe: ${clip(sanitizeIntegrationError(error))}`);
    return;
  }
  const release = (handle: string) =>
    bestEffort(
      "release replaced app event",
      releaseAppEvent(deps, { ...routine, connectorId: row.connectorId, handle }),
    );
  let saved: { count: number };
  try {
    saved = await deps.prisma.routineAppEvent.updateMany({
      where: { id: row.id, handle: row.handle },
      data: { handle: subscription.handle, renewAt: subscription.renewAt ?? null, error: null },
    });
  } catch (error) {
    // Unsaved, nothing would ever remove it: it goes, and the backup job tries again.
    await release(subscription.handle);
    throw error;
  }
  // The event was dropped or changed meanwhile: the new subscription belongs to nothing.
  const replaced = saved.count === 1 ? row.handle : subscription.handle;
  if (replaced) await release(replaced);
}

function clip(text: string): string {
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** The routine's app events as its editor shows them. */
export async function routineAppEventViews(
  deps: Pick<AppEventDeps, "prisma" | "connectors">,
  routineIds: readonly string[],
): Promise<Map<string, RoutineAppEvent[]>> {
  const views = new Map<string, RoutineAppEvent[]>();
  if (!routineIds.length) return views;
  const rows = await deps.prisma.routineAppEvent.findMany({
    where: { routineId: { in: [...routineIds] } },
    orderBy: { createdAt: "asc" },
  });
  if (!rows.length) return views;
  const connections = new Map(
    (
      await deps.prisma.connection.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.connectionId))] } },
        select: { id: true, displayName: true, status: true },
      })
    ).map((row) => [row.id, row]),
  );
  const labels = new Map<string, readonly ConnectorEventType[]>();
  for (const connectorId of new Set(rows.map((row) => row.connectorId))) {
    labels.set(connectorId, await eventTypesOf(deps.connectors?.managed(connectorId)));
  }
  for (const row of rows) {
    const connection = connections.get(row.connectionId);
    const type = labels.get(row.connectorId)?.find((t) => t.app === row.app && t.id === row.event);
    const appName = connection?.displayName ?? "App";
    const error = connection?.status !== "connected" ? APP_EVENT_RECONNECT : row.error;
    const list = views.get(row.routineId) ?? [];
    list.push({
      app: row.app,
      event: row.event,
      connectionId: row.connectionId,
      params: readJsonColumn(
        ParamsSchema,
        row.settings,
        { table: "routine_app_events", column: "settings", id: row.id },
        { fallback: {} },
      ),
      label: `${appName}: ${type?.label ?? "Event"}`,
      checked: row.checked,
      error,
    });
    views.set(row.routineId, list);
  }
  return views;
}

/**
 * Before a routine is deleted: its subscriptions' release jobs, committed with the delete.
 * Run them with `settleRoutineAppEvents` after commit.
 */
export async function releaseRoutineAppEventsIn(
  tx: Prisma.TransactionClient,
  jobs: Pick<JobPublisher, "enqueueManyIn">,
  routine: { id: string; spaceId: string; userId: string },
): Promise<Release[]> {
  const rows = await tx.routineAppEvent.findMany({
    where: { routineId: routine.id, handle: { not: null } },
    select: { connectorId: true, handle: true },
  });
  const releases = rows.map((row) => ({
    spaceId: routine.spaceId,
    userId: routine.userId,
    connectorId: row.connectorId,
    handle: row.handle!,
  }));
  if (releases.length)
    await jobs.enqueueManyIn(
      tx,
      releases.map((release) => appEventReleaseJob(release)),
    );
  return releases;
}

/**
 * A removed connection starts nothing: its events' subscriptions are released and each says to
 * reconnect, until the owner connects the app again and saves the routine.
 */
export async function releaseConnectionAppEvents(
  deps: AppEventDeps,
  connection: { id: string; spaceId: string; userId: string },
): Promise<void> {
  const releases = await deps.prisma.$transaction(async (tx) => {
    const rows = await tx.routineAppEvent.findMany({
      where: { connectionId: connection.id, spaceId: connection.spaceId },
      select: { id: true, connectorId: true, handle: true },
    });
    if (!rows.length) return [];
    await tx.routineAppEvent.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { handle: null, renewAt: null, error: APP_EVENT_RECONNECT },
    });
    const releases = rows.flatMap((row) =>
      row.handle
        ? [
            {
              spaceId: connection.spaceId,
              userId: connection.userId,
              connectorId: row.connectorId,
              handle: row.handle,
            },
          ]
        : [],
    );
    if (releases.length)
      await deps.jobs.enqueueManyIn(
        tx,
        releases.map((release) => appEventReleaseJob(release)),
      );
    return releases;
  });
  await settleRoutineAppEvents(deps, null, releases);
}
