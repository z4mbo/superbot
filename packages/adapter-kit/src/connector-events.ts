import type { AdapterContext } from "./types.js";

/**
 * Events a connected app can start a routine with, as an integration provider declares them.
 * Shared code lists, subscribes and verifies through these alone; it never reads an event's id or
 * a payload's shape, which belong to the provider.
 */
export interface ConnectorEventType {
  /** The app's catalog id, as its connections store it (`Connection.provider`). */
  app: string;
  /** Stable within the provider and app. Opaque outside the provider. */
  id: string;
  /** What starts it, in a few words: "New issue". */
  label: string;
  /** Values the person fills in, such as a repository. */
  params: readonly ConnectorEventParam[];
  /**
   * Whether the provider pushes this event to the server now. When false, it is only seen by a
   * routine change check that calls the read tool `poll` names.
   */
  push: boolean;
  /** The read-only tool a change check calls when the event is not pushed. */
  poll?: (params: Readonly<Record<string, string>>) => ConnectorEventPoll;
}

export interface ConnectorEventParam {
  key: string;
  label: string;
  placeholder?: string;
  optional?: boolean;
  /** Checked before the subscription is made; the message says what to enter. */
  pattern?: { source: string; message: string };
}

/** A tool call whose result changes when the event happens; see RoutineWatch's `track`. */
export interface ConnectorEventPoll {
  tool: string;
  args: Record<string, unknown>;
  track: string[];
}

export interface ConnectorEventSubscribeRequest {
  app: string;
  event: string;
  params: Readonly<Record<string, string>>;
  /** The connection's reference at the provider (`Connection.providerRef`). */
  connectionRef: string | null;
}

export interface ConnectorEventSubscription {
  /** The provider's id for the subscription: deliveries name it, and it removes it. */
  handle: string;
  /** When the provider lets it lapse unless it is made again. */
  renewAt?: Date;
}

/** One authenticated delivery. */
export interface ConnectorEventDelivery {
  /** The same for every retry of one event, so a retry starts nothing new. */
  deliveryId: string;
  handle: string;
  /** The event's data as the routine reads it: untrusted, outside text. */
  payload: Record<string, unknown>;
}

export interface ConnectorEventDeliveryRequest {
  headers: Headers;
  /** The bytes as sent: a signature covers them, not a decoded copy. */
  body: Uint8Array;
}

/** What a provider adds to its connector to deliver app events; each part is optional. */
export interface ConnectorEventSource {
  /** The events its connected apps can emit, with how each is delivered right now. */
  eventTypes?(): Promise<readonly ConnectorEventType[]>;
  /** Asks the provider to push the event; rejects when it could not. */
  subscribeEvent?(
    request: ConnectorEventSubscribeRequest,
    context: AdapterContext,
  ): Promise<ConnectorEventSubscription>;
  /** Resolves once the subscription is gone, which includes never having existed. */
  unsubscribeEvent?(handle: string, context: AdapterContext): Promise<void>;
  /** The delivery, or null when it is not authentic. */
  verifyEventDelivery?(
    request: ConnectorEventDeliveryRequest,
  ): Promise<ConnectorEventDelivery | null>;
}
