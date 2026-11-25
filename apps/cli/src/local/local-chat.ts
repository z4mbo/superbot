import { randomUUID } from "node:crypto";
import type { Client } from "@rakazo/cli-client";
import { retry } from "@rakazo/core";
import type { ChatThread } from "../chat/follow.js";
import { printMessage } from "../chat/transcript.js";
import { authHint, CommandError, hinted, isRetryable, withContext } from "../output/errors.js";
import type { AgentRef, SpaceRef } from "../session/catalog.js";
import type { CliContext } from "../session/context.js";
import { line } from "../terminal/io.js";
import { isAppCommand, LocalAppChat } from "./local-app-chat.js";
import type { LocalHistoryTurn } from "./local-chat.prompt.js";
import { localConversationPrompt, withAgentInstructions } from "./local-chat.prompt.js";
import type { LocalModelDrivers } from "./local-model.js";
import { installedModels } from "./local-model.js";
import { LocalModelError } from "./local-model-error.js";
import type { InstalledModel, PendingHistory } from "./local-model-store.js";
import { LocalModelStore } from "./local-model-store.js";

const HISTORY_TURNS = 40;

/**
 * A chat with an agent that uses a model installed on this device: the model runs here on recent
 * shared history, and the turn is saved to the conversation afterwards. A turn the server did not
 * save waits for `/retry`.
 */
export class LocalChat {
  readonly #store: LocalModelStore;
  readonly #drivers: LocalModelDrivers;
  readonly #space: string;
  readonly #bot: string;
  readonly #historyKey: string;
  readonly #apps: LocalAppChat;

  private constructor(
    context: CliContext,
    store: LocalModelStore,
    space: SpaceRef,
    agent: AgentRef,
    conversation: string | undefined,
  ) {
    this.#store = store;
    this.#drivers = context.localModels ?? installedModels;
    this.#space = space.id;
    this.#bot = agent.id;
    this.#historyKey = conversation === undefined ? agent.id : `thread:${conversation}`;
    this.#apps = new LocalAppChat(context.io, this.#drivers);
  }

  /** The local settings for this account, Space and agent, or undefined when there are none. */
  static open(
    context: CliContext,
    client: Client,
    account: string,
    space: SpaceRef,
    agent: AgentRef,
    conversation: string | undefined,
  ): LocalChat | undefined {
    const store = LocalModelStore.forWorkspace(context.settings, client.server, account, space.id);
    return store && new LocalChat(context, store, space, agent, conversation);
  }

  selection(): Promise<InstalledModel | undefined> {
    return this.#store.selection(this.#bot);
  }

  async hasPending(): Promise<boolean> {
    return (await this.#store.pendingHistory(this.#historyKey)) !== undefined;
  }

  /** Handles a line typed in the chat; false when it is for the server's model instead. */
  async handle(client: Client, thread: ChatThread, input: string): Promise<boolean> {
    if (isAppCommand(input)) {
      await this.#apps.handle(
        client,
        this.#space,
        this.#bot,
        this.#store,
        await this.selection(),
        input,
      );
      return true;
    }
    let pending = await this.#store.pendingHistory(this.#historyKey);
    if (pending && input !== "/retry") {
      throw new CommandError(
        "Type /retry to save the pending local message before sending another.",
      );
    }
    if (!pending) {
      const model = await this.selection();
      if (!model) return false;
      if (input === "/retry") {
        line(thread.io, "No local message is waiting to be saved.");
        return true;
      }
      pending = await this.#runModel(client, thread, model, input);
    }
    await this.#save(client, thread, pending);
    await this.#store.clearHistory(this.#historyKey, pending);
    if (pending.reply !== null)
      printMessage(thread.io, thread.agent.name, "bot", undefined, pending.reply);
    return true;
  }

  async #runModel(
    client: Client,
    thread: ChatThread,
    model: InstalledModel,
    input: string,
  ): Promise<PendingHistory> {
    const snapshot = await hinted(thread.snapshot());
    const history: LocalHistoryTurn[] = snapshot.messages
      .slice(-HISTORY_TURNS)
      .flatMap((message) => {
        const role =
          message.role === "user" ? "user" : message.role === "bot" ? "assistant" : undefined;
        const block = message.blocks[0];
        if (!role || block?.kind !== "text" || typeof block.text !== "string") return [];
        return [{ role, content: block.text }];
      });
    const conversation = localConversationPrompt(snapshot.messages.length === 0, history, input);
    const bot = await hinted(client.rpc("bots/get", this.#space, { botId: this.#bot }));
    const prompt = withAgentInstructions(bot.instructions, conversation);
    let reply: string;
    try {
      reply = await this.#drivers.run(this.#store, model, prompt, "chat");
    } catch (error) {
      if (error instanceof LocalModelError) throw new CommandError(error.message);
      throw error;
    }
    const pending: PendingHistory = { id: randomUUID(), text: input, reply };
    await this.#store.stageHistory(this.#historyKey, pending);
    return pending;
  }

  async #save(client: Client, thread: ChatThread, pending: PendingHistory): Promise<void> {
    const target = thread.target();
    const send = () =>
      pending.reply === null
        ? client.appendLocalNote(this.#space, target, pending.id, pending.text)
        : client.appendLocalTurn(this.#space, target, pending.id, pending.text, pending.reply);
    try {
      await retry(send, { attempts: 2, delayMs: 0, retryable: isRetryable });
    } catch (error) {
      throw withContext(
        "Could not save the local message. Use /retry in this chat to save it",
        authHint(error),
      );
    }
  }
}
