import type { Client } from "@rakazo/cli-client";
import { printWaiting, waitingJson } from "../approvals/approvals.js";
import type { Cursor } from "../chat/follow.js";
import { ChatThread, followUntilWaiting, withinBudget } from "../chat/follow.js";
import type { Sink } from "../chat/line-printer.js";
import { LinePrinter } from "../chat/line-printer.js";
import type { RunEnd, Update } from "../chat/reply.js";
import { Reply } from "../chat/reply.js";
import { LocalChat } from "../local/local-chat.js";
import { CommandError, Exit, hinted } from "../output/errors.js";
import { jsonText, terminalText } from "../output/text.js";
import { accountId } from "../session/account.js";
import { discover, findAgent } from "../session/catalog.js";
import type { CliContext } from "../session/context.js";
import { REPLY_BUDGET_MS } from "../session/context.js";
import { errorLine, line } from "../terminal/io.js";
import type { Snapshot } from "../threads/thread-api.js";
import { sendMessage, startedRuns } from "../threads/thread-api.js";

/** Exit status of a `send` whose reply stopped on a card that needs an answer. */
export const WAITING_EXIT = 3;

export type SendArgs = {
  agent: string;
  message: string[];
  newConversation: boolean;
  conversation: string | undefined;
};

/** Joins the words given on the command line, or reads the message from redirected input. */
export async function messageText(words: string[], stdin: () => Promise<string>): Promise<string> {
  let text: string;
  if (words.length > 0) {
    text = words.join(" ");
  } else {
    try {
      text = await stdin();
    } catch (error) {
      throw new CommandError(
        `Could not read the message from standard input: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (text.trim() === "") {
    throw new CommandError("Type a message after the agent name, or pipe one in.");
  }
  return text;
}

/** Records what a reply said for `send --json` instead of printing it as it streams. */
export class Collected implements Sink {
  readonly messages: Array<[id: string, text: string]> = [];
  end: RunEnd | undefined;

  update(update: Update): void {
    if (update.kind === "message" && update.message.role === "bot" && update.message.text !== "") {
      const known = this.messages.find(([id]) => id === update.message.id);
      if (known) known[1] = update.message.text;
      else this.messages.push([update.message.id, update.message.text]);
    } else if (update.kind === "runEnded" && this.end?.kind !== "failed") {
      this.end = update.end;
    }
  }
}

export function replyStatus(end: RunEnd | undefined): string {
  switch (end?.kind) {
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "waitingInput":
      return "waiting";
    default:
      return "completed";
  }
}

export async function sendCommand(
  context: CliContext,
  client: Client,
  spaceName: string | undefined,
  args: SendArgs,
  json: boolean,
): Promise<void> {
  const { io } = context;
  const text = await messageText(args.message, () =>
    io.stdinIsTerminal ? Promise.resolve("") : io.readAll(),
  );
  const catalog = await discover(client, spaceName);
  const { space, agent } = findAgent(catalog, args.agent);
  const account = await accountId(client);
  const local = LocalChat.open(context, client, account, space, agent, args.conversation);
  if (local && (await local.selection())) {
    throw new CommandError(
      "This agent uses a local model on this device. Use superbot chat to talk to it.",
    );
  }
  let conversation = args.conversation;
  if (args.newConversation) {
    const created = await hinted(client.createBotConversation(space.id, agent.id));
    if (!json) errorLine(io, `Conversation ${terminalText(created.threadId)}`);
    conversation = created.threadId;
  }
  const thread = new ChatThread({
    client,
    spaceId: space.id,
    agent,
    conversation,
    interactive: false,
    io,
  });
  const snapshot = await hinted(thread.snapshot());
  if (conversation !== undefined && conversation !== snapshot.threadId) {
    throw new CommandError("The server did not open the requested conversation.");
  }
  const receipt = await hinted(sendMessage(client, space.id, thread.target(), text));
  const runs = startedRuns(receipt);
  const pending = [...runs];
  const cursor: Cursor = { value: snapshot.cursor };
  const printer = new LinePrinter(
    (output) => io.out(output),
    (output) => io.err(output),
    agent.name,
    false,
  );
  const collected = new Collected();
  const waiting = await withinBudget(context.replyBudgetMs ?? REPLY_BUDGET_MS, (signal) =>
    followUntilWaiting(
      thread,
      cursor,
      pending,
      receipt.seq,
      new Reply(),
      json ? collected : printer,
      signal,
    ),
  );
  if (waiting === "timeout") {
    throw new CommandError(
      "Still waiting after 10 minutes. Open the chat to see its latest messages.",
    );
  }
  let waitingCard: [runId: string, snapshot: Snapshot] | undefined;
  if (waiting !== undefined) waitingCard = [waiting, await hinted(thread.snapshot())];
  if (json) {
    if (waiting !== undefined) collected.end = { kind: "waitingInput" };
    const output: Record<string, unknown> = {
      threadId: snapshot.threadId,
      runIds: runs,
      status: replyStatus(collected.end),
      reply: collected.messages.map(([, reply]) => reply).join("\n"),
    };
    if (collected.end?.kind === "failed") output.error = collected.end.reason;
    if (waitingCard) output.approval = waitingJson(waitingCard[1], waitingCard[0]);
    line(io, jsonText(output));
    if (collected.end?.kind === "waitingInput") throw new Exit(WAITING_EXIT);
    if (collected.end?.kind === "failed" || collected.end?.kind === "cancelled") throw new Exit(1);
    return;
  }
  if (waitingCard) {
    printWaiting(io, waitingCard[1], waitingCard[0]);
    throw new Exit(WAITING_EXIT);
  }
  if (printer.failed) throw new Exit(1);
}
