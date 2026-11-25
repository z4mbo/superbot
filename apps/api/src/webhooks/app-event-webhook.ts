import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { AppEventConnectors } from "@rakazo/adapters";
import { accountDeactivated } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { Hono } from "hono";
import * as z from "zod";
import { readBoundedBytes } from "../http/http-body.js";
import { formatAppEventPrompt } from "../messaging/inbound-delivery.prompt.js";
import type { WebhookDeps } from "./webhook-inbound.js";
import { deliverWebhookEvent, webhookDeliveryResponse } from "./webhook-inbound.js";

/** A new email's body can be long; what reaches the prompt is clipped further. */
export const APP_EVENT_MAX_BODY_BYTES = 512 * 1024;
const MAX_TEXT = 4_000;
const MAX_ITEMS = 50;
const MAX_DEPTH = 6;

const ParamsSchema = z.record(z.string(), z.string());

/** The event's data, small enough for a prompt: long text cut, long lists and deep nesting left out. */
export function clipEventData(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}...` : value;
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "...";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => clipEventData(item, depth + 1));
  }
  const entries = Object.entries(value).slice(0, MAX_ITEMS);
  return Object.fromEntries(entries.map(([key, item]) => [key, clipEventData(item, depth + 1)]));
}

/** The active routine a subscription starts, when its owner can still be acted for. */
async function loadAppEventTarget(deps: WebhookDeps, connectorId: string, handle: string) {
  const row = await deps.prisma.routineAppEvent.findUnique({
    where: { connectorId_handle: { connectorId, handle } },
    select: {
      app: true,
      event: true,
      settings: true,
      connectionId: true,
      routine: {
        select: {
          id: true,
          name: true,
          prompt: true,
          active: true,
          userId: true,
          spaceId: true,
          modelProvider: true,
          modelId: true,
          thinkingLevel: true,
          bot: {
            select: {
              id: true,
              spaceId: true,
              userId: true,
              archivedAt: true,
              thread: { select: { id: true } },
            },
          },
        },
      },
    },
  });
  const routine = row?.routine;
  const bot = routine?.bot;
  // The delivery runs as the bot's creator, so only their own routines may ride on it.
  if (!row || !routine?.active || !bot?.thread || bot.archivedAt) return null;
  if (bot.userId !== routine.userId || bot.spaceId !== routine.spaceId) return null;
  const connection = await deps.prisma.connection.findFirst({
    where: {
      id: row.connectionId,
      spaceId: routine.spaceId,
      userId: routine.userId,
      status: "connected",
    },
    select: { displayName: true },
  });
  if (!connection || (await accountDeactivated(deps.prisma, bot.userId))) return null;
  return {
    target: {
      bot: { id: bot.id, spaceId: bot.spaceId, userId: bot.userId },
      threadId: bot.thread.id,
    },
    routine,
    appName: connection.displayName,
    app: row.app,
    event: row.event,
    params: ParamsSchema.safeParse(row.settings).data ?? {},
  };
}

/**
 * Deliveries of app events, from any integration provider that pushes them. The provider checks
 * its own signature; a delivery it does not vouch for is refused before anything is read.
 */
export function mountAppEventWebhookRoute(
  app: Hono,
  deps: WebhookDeps & { connectors?: AppEventConnectors },
) {
  app.post("/api/v1/app-events/:connectorId", async (c) => {
    const unauthorized = () => c.json({ error: "Unauthorized" }, 401);
    // The signature covers the bytes as sent, so they are kept as they are.
    const raw = await readBoundedBytes(c.req.raw, APP_EVENT_MAX_BODY_BYTES, undefined, {
      preallocateFromContentLength: false,
    });
    if (raw === null) return c.json({ error: "Payload too large" }, 413);
    const connectorId = c.req.param("connectorId");
    const provider = deps.connectors?.managed(connectorId);
    if (!provider?.verifyEventDelivery) return unauthorized();
    let delivery: Awaited<ReturnType<NonNullable<typeof provider.verifyEventDelivery>>>;
    try {
      delivery = await provider.verifyEventDelivery({ headers: c.req.raw.headers, body: raw });
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        return c.json({ error: "Service unavailable" }, 503);
      }
      throw error;
    }
    if (!delivery) return unauthorized();

    const found = await loadAppEventTarget(deps, connectorId, delivery.handle);
    // An authentic delivery for a subscription nothing keeps: answered so the provider stops.
    if (!found) return c.json({ ok: true, ignored: true });
    const types =
      (await bestEffort("list app event types", provider.eventTypes?.() ?? Promise.resolve([]))) ??
      [];
    const label = types.find((type) => type.app === found.app && type.id === found.event)?.label;
    return webhookDeliveryResponse(
      c,
      deliverWebhookEvent(deps, found.target, {
        prompt: formatAppEventPrompt({
          app: found.appName,
          event: label ?? "Event",
          ...(Object.keys(found.params).length ? { settings: found.params } : {}),
          data: clipEventData(delivery.payload),
        }),
        routines: [found.routine],
        source: "app",
        // Every retry of one event carries the same delivery id, so it starts one run.
        idempotencyKey: `${connectorId}:${delivery.deliveryId}`,
      }),
    );
  });
}
