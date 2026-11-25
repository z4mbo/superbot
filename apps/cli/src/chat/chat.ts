import type { Client } from "@rakazo/cli-client";
import { messageText } from "../approvals/approvals.js";
import { isAppCommand } from "../local/local-app-chat.js";
import { LocalChat } from "../local/local-chat.js";
import { supportsAppAssistance } from "../local/local-model.js";
import { authHint, CommandError, describeError, hinted, isUnauthorized } from "../output/errors.js";
import { terminalText } from "../output/text.js";
import { accountId } from "../session/account.js";
import type { AgentRef, Catalog, SpaceRef } from "../session/catalog.js";
import { agentsIn, findAgent } from "../session/catalog.js";
import type { CliContext } from "../session/context.js";
import { REPLY_BUDGET_MS } from "../session/context.js";
import { errorLine, line } from "../terminal/io.js";
import { sendMessage, startedRuns } from "../threads/thread-api.js";
import type { Cursor } from "./follow.js";
import { ChatThread, followReply, resumeWaiting } from "./follow.js";
import { printMessage } from "./transcript.js";

export type ChatTarget = {
  /** The agent to open; the picker when undefined. */
  agent: string | undefined;
  newConversation: boolean;
  conversation: string | undefined;
};

/** `superbot [AGENT]` and `superbot chat AGENT`: a direct chat, or the picker. */
export async function chatCommand(
  context: CliContext,
  client: Client,
  catalog: Catalog,
  target: ChatTarget,
): Promise<void> {
  const { io } = context;
  const account = await accountId(client);
  if (target.agent !== undefined) {
    const { space, agent } = findAgent(catalog, target.agent);
    let conversation = target.conversation;
    if (target.newConversation) {
      const created = await hinted(client.createBotConversation(space.id, agent.id));
      line(io, `Conversation ${terminalText(created.threadId)}`);
      conversation = created.threadId;
    }
    await chat(context, client, account, space, agent, conversation);
    return;
  }
  for (;;) {
    const options = agentsIn(catalog);
    if (options.length === 0) {
      throw new CommandError("No agents found. Create an agent in this workspace first.");
    }
    line(io, "Choose an agent");
    options.forEach(({ space, agent }, index) => {
      line(io, `  ${index + 1}. ${terminalText(space.name)} / ${terminalText(agent.name)}`);
    });
    const selection = await io.prompt("Agent number (Enter to quit): ");
    if (selection === null || selection.trim() === "") return;
    const number = /^\+?\d+$/.test(selection.trim()) ? Number(selection.trim()) : 0;
    const chosen = number >= 1 ? options[number - 1] : undefined;
    if (!chosen) {
      errorLine(io, `Choose a number from 1 to ${options.length}.`);
      continue;
    }
    if (!(await chat(context, client, account, chosen.space, chosen.agent, undefined))) return;
  }
}

/** One chat with an agent; true when the person asked to go back to the picker. */
async function chat(
  context: CliContext,
  client: Client,
  account: string,
  space: SpaceRef,
  agent: AgentRef,
  conversation: string | undefined,
): Promise<boolean> {
  const { io } = context;
  const budget = context.replyBudgetMs ?? REPLY_BUDGET_MS;
  const local = LocalChat.open(context, client, account, space, agent, conversation);
  const thread = new ChatThread({
    client,
    spaceId: space.id,
    agent,
    conversation,
    interactive: io.stdinIsTerminal && io.stdoutIsTerminal,
    io,
  });
  const snapshot = await hinted(thread.snapshot());
  if (conversation !== undefined && conversation !== snapshot.threadId) {
    throw new CommandError("The server did not open the requested conversation.");
  }
  const cursor: Cursor = { value: snapshot.cursor };
  const readApproval = () => io.prompt("Approval (Enter to leave pending): ");
  line(io, `${terminalText(space.name)} / ${terminalText(agent.name)}`);
  for (const message of snapshot.messages) {
    printMessage(io, agent.name, message.role, message.author, messageText(message));
  }
  const pending = local ? await local.hasPending() : false;
  const model = pending || !local ? undefined : await local.selection();
  if (pending) {
    line(io, "A local message is waiting to be saved. Type /retry to save it.");
  } else if (!model) {
    await resumeWaiting(thread, snapshot, cursor, readApproval, budget);
  }
  line(io, "Type a message and press Enter. /back returns to the picker. /quit exits.");
  if (model && supportsAppAssistance(model)) {
    line(io, "Type /apps to see record apps granted to this agent.");
  }
  for (;;) {
    const input = await io.prompt("You > ");
    if (input === null) return false;
    const typed = input.trim();
    if (typed === "") continue;
    if (typed === "/quit") return false;
    if (typed === "/back") return true;
    if (local) {
      try {
        if (await local.handle(client, thread, typed)) continue;
      } catch (error) {
        if (!thread.interactive) throw error;
        errorLine(io, terminalText(describeError(error)));
        continue;
      }
    }
    if (isAppCommand(typed)) {
      errorLine(io, "App assistance requires a selected prompt-only local model.");
      continue;
    }
    let receipt: Awaited<ReturnType<typeof sendMessage>>;
    try {
      receipt = await sendMessage(client, space.id, thread.target(), input);
    } catch (error) {
      if (isUnauthorized(error)) throw authHint(error);
      errorLine(io, `Could not send the message. ${terminalText(describeError(error))}`);
      continue;
    }
    line(io, `Waiting for ${terminalText(agent.name)}…`);
    await followReply(thread, cursor, startedRuns(receipt), receipt.seq, readApproval, budget);
  }
}
