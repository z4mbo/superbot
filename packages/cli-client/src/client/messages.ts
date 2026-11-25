import type { MessageAuthor, ProductEvent, ThreadMessage } from "@rakazo/contracts";
import { SuperbotError } from "../errors.js";

/** The chat to read or follow: a bot's main chat, one of its conversations, or a group. */
export type ThreadTarget =
  | { botId: string; threadId?: string; groupId?: never }
  | { groupId: string; botId?: never; threadId?: never };

/** A message as a terminal shows it: its text blocks joined, with who said it. */
export type ChatMessage = Pick<ThreadMessage, "id" | "role" | "seq"> & {
  text: string;
  /** The human who wrote it; older messages may lack one. */
  author?: MessageAuthor;
  origin?: string;
  botId?: string;
  runId?: string;
};

/** One event of a thread stream. Heartbeats carry no message; skip them when saving a cursor. */
export type ThreadEvent = ProductEvent;

type WireMessage = {
  id: string;
  role: string;
  seq: number;
  author?: MessageAuthor | null;
  origin?: string | null;
  botId?: string | null;
  runId?: string | null;
  blocks: readonly unknown[];
};

export function toChatMessage(message: WireMessage): ChatMessage {
  const text = message.blocks
    .flatMap((block) => {
      if (typeof block !== "object" || block === null) return [];
      const { kind, text } = block as { kind?: unknown; text?: unknown };
      return kind === "text" && typeof text === "string" ? [text] : [];
    })
    .join("\n");
  return withoutEmpty({
    id: message.id,
    role: message.role as ChatMessage["role"],
    seq: message.seq,
    text,
    author: message.author ?? undefined,
    origin: message.origin ?? undefined,
    botId: message.botId ?? undefined,
    runId: message.runId ?? undefined,
  });
}

/** History messages from an RPC result, refusing a reply that is not a message list. */
export function toChatMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages) || !messages.every(isWireMessage)) {
    throw SuperbotError.protocol("invalid RPC response");
  }
  return messages.map(toChatMessage);
}

/**
 * The message a `thread.message.created` or `thread.message.updated` event carries, or null for
 * any other event. A bot's reply names its bot; local command-line history is the member's own.
 */
export function eventMessage(event: ThreadEvent): ChatMessage | null {
  if (event.type !== "thread.message.created" && event.type !== "thread.message.updated") {
    return null;
  }
  const payload = event.payload;
  const blocks = payload.blocks ?? [];
  if (
    !optional(payload.messageId, isString) ||
    !optional(payload.seq, Number.isInteger) ||
    !optional(payload.role, isString) ||
    !optional(payload.author, isAuthor) ||
    !optional(payload.origin, isString) ||
    !optional(payload.botId, isString) ||
    !Array.isArray(blocks)
  ) {
    throw SuperbotError.protocol("invalid message event");
  }
  const role = (payload.role as string | null | undefined) ?? "bot";
  const origin = payload.origin as string | null | undefined;
  const payloadBot = (payload.botId as string | null | undefined) ?? undefined;
  const botId = role === "bot" && origin !== "local_cli" ? (payloadBot ?? event.botId) : payloadBot;
  return toChatMessage({
    id: (payload.messageId as string | null | undefined) ?? event.id,
    seq: (payload.seq as number | null | undefined) ?? event.seq,
    role,
    author: payload.author as MessageAuthor | null | undefined,
    origin,
    botId,
    runId: event.runId,
    blocks,
  });
}

/** Checks the fields every thread event has, so a malformed stream fails loudly. */
export function assertThreadEvent(event: unknown): asserts event is ThreadEvent {
  const fields = (typeof event === "object" && event !== null ? event : {}) as Record<
    string,
    unknown
  >;
  if (
    !isString(fields.id) ||
    !Number.isInteger(fields.seq) ||
    !isString(fields.type) ||
    !("payload" in fields) ||
    !optional(fields.botId, isString) ||
    !optional(fields.runId, isString)
  ) {
    throw SuperbotError.protocol("invalid event payload");
  }
}

function isWireMessage(value: unknown): value is WireMessage {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Record<string, unknown>;
  return (
    isString(fields.id) &&
    isString(fields.role) &&
    Number.isInteger(fields.seq) &&
    Array.isArray(fields.blocks) &&
    optional(fields.author, isAuthor) &&
    optional(fields.origin, isString) &&
    optional(fields.botId, isString) &&
    optional(fields.runId, isString)
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isAuthor(value: unknown): value is MessageAuthor {
  if (typeof value !== "object" || value === null) return false;
  const { id, name } = value as { id?: unknown; name?: unknown };
  return isString(id) && isString(name);
}

function optional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || value === null || check(value);
}

function withoutEmpty<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}
