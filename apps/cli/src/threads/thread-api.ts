import { randomUUID } from "node:crypto";
import type { Client, SendReceipt, ThreadEvent } from "@rakazo/cli-client";
import type { RpcOutput } from "@rakazo/contracts";
import { retry } from "@rakazo/core";
import { isRetryable } from "../output/errors.js";

/** An agent's first conversation (`botId` only) or one of its added conversations. */
export type AgentThread = { botId: string; threadId?: string };

export function targetFor(agentId: string, threadId?: string | null): AgentThread {
  return threadId ? { botId: agentId, threadId } : { botId: agentId };
}

/** A content block as the server sent it; cards are read field by field. */
export type Block = Record<string, unknown>;

export type SnapshotMessage = {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Block[];
  author?: { id: string; name: string } | null;
  runId?: string | null;
  createdAt: string;
};

/** The latest page of a conversation, with the cursor to follow it from and its active runs. */
export type Snapshot = {
  threadId: string;
  cursor: number;
  messages: SnapshotMessage[];
  run?: { status?: unknown } | null;
  activeRuns?: Array<{ id?: unknown; status?: unknown }>;
};

export async function threadSnapshot(
  client: Client,
  spaceId: string,
  target: AgentThread,
): Promise<Snapshot> {
  const snapshot: RpcOutput<"threads/get"> = await client.rpc("threads/get", spaceId, target);
  return snapshot as unknown as Snapshot;
}

export function threadHead(client: Client, spaceId: string, target: AgentThread) {
  return client.rpc("threads/head", spaceId, target);
}

/** Sends a message once: a send whose answer was lost is asked again with the same nonce. */
export function sendMessage(
  client: Client,
  spaceId: string,
  target: AgentThread,
  text: string,
): Promise<SendReceipt> {
  const clientNonce = randomUUID();
  return retry(() => client.rpc("threads/send", spaceId, { ...target, text, clientNonce }), {
    attempts: 2,
    delayMs: 0,
    retryable: isRetryable,
  });
}

/** The runs a send started. */
export function startedRuns(receipt: SendReceipt): string[] {
  return receipt.runIds && receipt.runIds.length > 0 ? [...receipt.runIds] : [receipt.runId];
}

/** Answers a card with one of the answer IDs it offers. */
export async function answerCard(
  client: Client,
  spaceId: string,
  target: AgentThread,
  runId: string,
  messageId: string,
  answer: string,
): Promise<void> {
  await client.rpc("threads/answer", spaceId, { ...target, runId, messageId, answer });
}

export function botConversations(client: Client, spaceId: string, botId: string) {
  return client.listBotConversations(spaceId, botId);
}

export function subscribeThread(
  client: Client,
  spaceId: string,
  target: AgentThread,
  cursor: number,
  signal?: AbortSignal,
): Promise<AsyncGenerator<ThreadEvent, void, undefined>> {
  return client.subscribeThread(spaceId, target, cursor, { signal });
}
