import type { BotConversation, Client } from "@rakazo/cli-client";
import { messageText } from "../approvals/approvals.js";
import { speaker } from "../chat/reply.js";
import { CommandError, hinted } from "../output/errors.js";
import { jsonText, terminalText, textLines } from "../output/text.js";
import type { AgentRef } from "../session/catalog.js";
import type { Io } from "../terminal/io.js";
import { line } from "../terminal/io.js";
import type { Snapshot } from "../threads/thread-api.js";
import { botConversations, targetFor, threadHead, threadSnapshot } from "../threads/thread-api.js";

/** One row of an agent's conversation list. */
export type Conversation = {
  threadId: string;
  /** The agent's first conversation, which `chat` and `send` open without `--conversation`. */
  first: boolean;
  title: string | null;
  preview: string | null;
};

/** The name the conversation lists under, as the desktop names it. */
export function conversationLabel(row: Conversation): string {
  const label = row.title ?? row.preview;
  if (label !== null && label.trim() !== "") return label;
  return row.first ? "First conversation" : "New conversation";
}

/** The agent's first conversation, then its added ones that are not archived, newest first. */
export async function conversations(
  client: Client,
  spaceId: string,
  agentId: string,
): Promise<Conversation[]> {
  const first = await hinted(threadHead(client, spaceId, targetFor(agentId)));
  const added = await hinted(botConversations(client, spaceId, agentId));
  return conversationRows(first.threadId, added);
}

export function conversationRows(first: string, added: BotConversation[]): Conversation[] {
  return [
    { threadId: first, first: true, title: null, preview: null },
    ...added
      .filter((conversation) => !conversation.archivedAt && conversation.threadId !== first)
      .map((conversation) => ({
        threadId: conversation.threadId,
        first: false,
        title: conversation.title ?? null,
        preview: conversation.preview ?? null,
      })),
  ];
}

export function printConversations(io: Io, rows: Conversation[], json: boolean): void {
  if (json) {
    line(io, jsonText(rows));
    return;
  }
  for (const row of rows) {
    line(io, `${row.threadId}  ${listLabel(terminalText(conversationLabel(row)))}`);
  }
}

export const LABEL_CHARS = 72;

/** A label's first line, cut to fit one terminal row. */
export function listLabel(text: string): string {
  const first = (textLines(text)[0] ?? "").trim();
  const chars = [...first];
  if (chars.length <= LABEL_CHARS) return first;
  return `${chars
    .slice(0, LABEL_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}

export async function showConversation(
  io: Io,
  client: Client,
  spaceId: string,
  agent: AgentRef,
  threadId: string | undefined,
  json: boolean,
): Promise<void> {
  const snapshot = await hinted(threadSnapshot(client, spaceId, targetFor(agent.id, threadId)));
  if (threadId !== undefined && threadId !== snapshot.threadId) {
    throw new CommandError("The server did not open the requested conversation.");
  }
  if (json) line(io, jsonText(transcriptJson(snapshot)));
  else io.out(transcript(snapshot, agent.name));
}

/** The snapshot's messages as transcript lines, leaving out messages without text. */
export function transcript(snapshot: Snapshot, agentName: string): string {
  let lines = "";
  for (const message of snapshot.messages) {
    const text = messageText(message);
    if (text.trim() === "") continue;
    const name = speaker(agentName, message.role, message.author);
    lines += `${terminalText(name)} > ${terminalText(text)}\n`;
  }
  return lines;
}

export function transcriptJson(snapshot: Snapshot): unknown {
  return {
    threadId: snapshot.threadId,
    messages: snapshot.messages.map((message) => ({
      id: message.id,
      role: message.role,
      author: message.author ? { id: message.author.id, name: message.author.name } : null,
      text: messageText(message),
      createdAt: message.createdAt,
    })),
  };
}
