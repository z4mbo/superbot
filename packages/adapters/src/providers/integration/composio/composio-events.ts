import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  AdapterContext,
  ConnectorEventDelivery,
  ConnectorEventDeliveryRequest,
  ConnectorEventParam,
  ConnectorEventPoll,
  ConnectorEventSource,
  ConnectorEventSubscribeRequest,
  ConnectorEventSubscription,
  ConnectorEventType,
} from "@rakazo/adapter-kit";
import type { ComposioClient } from "./composio-connector.js";
import { isComposioNotFoundError } from "./composio-errors.js";

/**
 * Composio triggers as app events. Composio delivers every trigger of the project to the one
 * webhook URL set in its dashboard, signed with that subscription's secret; without the secret this
 * server cannot tell a real delivery from a forged one, so the events are only checked by polling.
 */
type ComposioEvent = {
  app: string;
  id: string;
  label: string;
  trigger: string;
  params: readonly ConnectorEventParam[];
  config(params: Readonly<Record<string, string>>): Record<string, unknown>;
  poll(params: Readonly<Record<string, string>>): ConnectorEventPoll;
};

const REPOSITORY: ConnectorEventParam = {
  key: "repository",
  label: "Repository",
  placeholder: "owner/name",
  pattern: {
    source: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
    message: "Enter the repository as owner/name.",
  },
};

function repository(params: Readonly<Record<string, string>>): { owner: string; repo: string } {
  const [owner = "", repo = ""] = (params.repository ?? "").split("/");
  return { owner, repo };
}

const COMPOSIO_EVENTS: readonly ComposioEvent[] = [
  {
    app: "github",
    id: "issue_added",
    label: "New issue",
    trigger: "GITHUB_ISSUE_ADDED_EVENT",
    params: [REPOSITORY],
    config: repository,
    poll: (params) => ({
      tool: "GITHUB_LIST_REPOSITORY_ISSUES",
      args: {
        ...repository(params),
        state: "open",
        sort: "created",
        direction: "desc",
        per_page: 20,
      },
      track: ["id"],
    }),
  },
  {
    app: "github",
    id: "pull_request",
    label: "Pull request opened or changed",
    trigger: "GITHUB_PULL_REQUEST_EVENT",
    params: [REPOSITORY],
    config: repository,
    poll: (params) => ({
      tool: "GITHUB_LIST_PULL_REQUESTS",
      args: {
        ...repository(params),
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 20,
      },
      track: ["id", "updated_at"],
    }),
  },
  {
    app: "github",
    id: "commit",
    label: "New commit",
    trigger: "GITHUB_COMMIT_EVENT",
    params: [REPOSITORY],
    config: repository,
    poll: (params) => ({
      tool: "GITHUB_LIST_COMMITS",
      args: { ...repository(params), per_page: 20 },
      track: ["sha"],
    }),
  },
  {
    app: "gmail",
    id: "new_message",
    label: "New email",
    trigger: "GMAIL_NEW_GMAIL_MESSAGE",
    params: [
      {
        key: "query",
        label: "Only mail matching",
        placeholder: "from:alerts@example.com",
        optional: true,
      },
    ],
    config: (params) => ({
      userId: "me",
      labelIds: "INBOX",
      ...(params.query ? { query: params.query } : {}),
    }),
    poll: (params) => ({
      tool: "GMAIL_FETCH_EMAILS",
      args: { query: params.query ? `in:inbox ${params.query}` : "in:inbox", max_results: 10 },
      track: ["messageId"],
    }),
  },
];

/** How old a delivery may be, as the vendor's own verifier allows: a replay after it is refused. */
const DELIVERY_TOLERANCE_MS = 5 * 60_000;

function findEvent(app: string, id: string): ComposioEvent | undefined {
  const key = app.trim().toLowerCase();
  return COMPOSIO_EVENTS.find((event) => event.app === key && event.id === id);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** The trigger a delivery names and its data, in any of the vendor's payload versions. */
export function composioDeliveryParts(
  body: unknown,
): { handles: string[]; data: Record<string, unknown> } | undefined {
  const payload = record(body);
  if (!payload) return undefined;
  const metadata = record(payload.metadata);
  const data = record(payload.data);
  // Current version: the trigger in metadata, the event in data.
  const current = text(metadata?.trigger_id);
  if (current) return { handles: [current], data: data ?? {} };
  // Previous version: ids mixed into data.
  if (data && (text(data.trigger_nano_id) || text(data.trigger_id))) {
    const {
      trigger_nano_id: nano,
      trigger_id: id,
      connection_id: _connection,
      connection_nano_id: _connectionNano,
      user_id: _user,
      ...rest
    } = data;
    return { handles: [text(nano), text(id)].filter((h): h is string => Boolean(h)), data: rest };
  }
  // First version.
  const first = text(payload.trigger_id);
  if (first) return { handles: [first], data: record(payload.payload) ?? {} };
  return undefined;
}

function signatureMatches(secret: string, signed: string, header: string): boolean {
  const expected = Buffer.from(createHmac("sha256", secret).update(signed).digest("base64"));
  return header.split(" ").some((part) => {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** A signed request as the vendor sends it, for tests and the fake. */
export function signComposioDelivery(
  secret: string,
  body: string,
  options: { id?: string; timestamp?: number } = {},
): Headers {
  const id = options.id ?? `msg_${randomUUID()}`;
  const timestamp = String(Math.floor((options.timestamp ?? Date.now()) / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return new Headers({
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  });
}

export function composioEventSource(
  sdk: () => Promise<ComposioClient>,
  webhookSecret: string | undefined,
): Required<ConnectorEventSource> {
  const push = Boolean(webhookSecret);
  return {
    async eventTypes(): Promise<readonly ConnectorEventType[]> {
      return COMPOSIO_EVENTS.map((event) => ({
        app: event.app,
        id: event.id,
        label: event.label,
        params: event.params,
        push,
        poll: event.poll,
      }));
    },

    async subscribeEvent(
      request: ConnectorEventSubscribeRequest,
      context: AdapterContext,
    ): Promise<ConnectorEventSubscription> {
      const event = findEvent(request.app, request.event);
      if (!event) throw new Error("This app has no such event.");
      if (!push) throw new Error("This server does not receive app events.");
      const client = await sdk();
      if (!client.triggers) throw new Error("This server does not receive app events.");
      const accountId = request.connectionRef?.trim();
      const created = await client.triggers.create(context.userId, event.trigger, {
        // A slug-only ref names no account, and without one the vendor picks the newest.
        ...(accountId && accountId.toLowerCase() !== event.app
          ? { connectedAccountId: accountId }
          : {}),
        triggerConfig: event.config(request.params),
      });
      return { handle: created.triggerId };
    },

    async unsubscribeEvent(handle: string): Promise<void> {
      const client = await sdk();
      if (!client.triggers) return;
      try {
        await client.triggers.delete(handle);
      } catch (error) {
        if (isComposioNotFoundError(error)) return;
        throw error;
      }
    },

    async verifyEventDelivery(
      request: ConnectorEventDeliveryRequest,
    ): Promise<ConnectorEventDelivery | null> {
      if (!webhookSecret) return null;
      const id = request.headers.get("webhook-id")?.trim();
      const timestamp = request.headers.get("webhook-timestamp")?.trim();
      const signature = request.headers.get("webhook-signature")?.trim();
      if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return null;
      if (Math.abs(Date.now() - Number(timestamp) * 1000) > DELIVERY_TOLERANCE_MS) return null;
      const body = Buffer.from(request.body).toString("utf8");
      if (!signatureMatches(webhookSecret, `${id}.${timestamp}.${body}`, signature)) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return null;
      }
      const parts = composioDeliveryParts(parsed);
      if (!parts?.handles[0]) return null;
      return { deliveryId: id, handle: parts.handles[0], payload: parts.data };
    },
  };
}
