/**
 * `superbot tui`: the full-screen chat. Reads once, then follows the open conversation's live
 * events and the Space's change signals, reading again only when a signal says to.
 */
import type { Client } from "@rakazo/cli-client";
import { abortableDelay } from "@rakazo/core";
import type { Key as InkKey } from "ink";
import { render, useApp, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { pendingApprovals, resolveApproval } from "../approvals/approvals.js";
import { Reply } from "../chat/reply.js";
import { conversations } from "../commands/threads.js";
import { CommandError, describeError, isRetryable } from "../output/errors.js";
import { discover } from "../session/catalog.js";
import { sendMessage, subscribeThread, targetFor, threadSnapshot } from "../threads/thread-api.js";
import type { App, Effect, Key, Msg, OpenChat } from "./state.js";
import { catalogOf, newApp, pressKey, receive, start } from "./state.js";
import { TuiView } from "./view.js";

const MAX_RECONNECT_WAIT_MS = 5_000;

export function reconnectWait(failures: number): number {
  return Math.min(250 * 2 ** Math.min(failures, 5), MAX_RECONNECT_WAIT_MS);
}

/** Ink's key report as the keys the state reads; pasted text arrives as one key per character. */
export function keysFrom(input: string, key: InkKey): Key[] {
  const ctrl = key.ctrl;
  if (key.tab) return [{ code: key.shift ? "backTab" : "tab" }];
  if (key.pageUp) return [{ code: "pageUp" }];
  if (key.pageDown) return [{ code: "pageDown" }];
  if (key.upArrow) return [{ code: "up" }];
  if (key.downArrow) return [{ code: "down" }];
  if (key.return) return [{ code: "enter" }];
  if (key.escape) return [{ code: "esc" }];
  if (key.backspace || key.delete) return [{ code: "backspace" }];
  return [...input].map((char) => ({ code: "char", char, ctrl }));
}

/** Runs effects in the background; each reports back through `dispatch`. */
export class Tasks {
  readonly #client: Client;
  readonly #spaceId: string;
  readonly #dispatch: (message: Msg) => void;
  #follow: AbortController | undefined;
  readonly #stopped = new AbortController();

  constructor(client: Client, spaceId: string, dispatch: (message: Msg) => void) {
    this.#client = client;
    this.#spaceId = spaceId;
    this.#dispatch = dispatch;
  }

  run(app: App, effect: Effect): void {
    if (effect.kind === "follow") {
      this.#follow?.abort();
      this.#follow = new AbortController();
      void this.#followChat(effect.chat, effect.generation, this.#follow.signal);
      return;
    }
    if (effect.kind === "loadApprovals") {
      const catalog = catalogOf(app);
      void pendingApprovals(this.#client, catalog).then(
        (found) => this.#send({ kind: "approvals", found }),
        (error: unknown) =>
          this.#send({
            kind: "failed",
            reason: `Could not read approvals. ${describeError(error)}`,
          }),
      );
      return;
    }
    void this.#oneShot(effect).then(
      (message) => message && this.#send(message),
      (error: unknown) => this.#send({ kind: "failed", reason: describeError(error) }),
    );
  }

  /** Follows the Space's change signals until stopped. */
  followSignals(): void {
    void this.#followSignals(this.#stopped.signal);
  }

  stop(): void {
    this.#follow?.abort();
    this.#stopped.abort();
  }

  #send(message: Msg): void {
    if (!this.#stopped.signal.aborted) this.#dispatch(message);
  }

  async #oneShot(effect: Effect): Promise<Msg | undefined> {
    const client = this.#client;
    const spaceId = this.#spaceId;
    switch (effect.kind) {
      case "loadAgents":
        return { kind: "agents", bots: await client.rpc("bots/list", spaceId, {}) };
      case "loadConversations":
        return {
          kind: "conversations",
          agentId: effect.agentId,
          rows: await conversations(client, spaceId, effect.agentId),
        };
      case "send":
        try {
          await sendMessage(
            client,
            spaceId,
            targetFor(effect.chat.agentId, effect.chat.threadId),
            effect.text,
          );
        } catch (error) {
          throw new CommandError(`Could not send the message. ${describeError(error)}`);
        }
        return undefined;
      case "newConversation": {
        const created = await client.createBotConversation(spaceId, effect.agentId);
        return { kind: "created", agentId: effect.agentId, threadId: created.threadId };
      }
      case "answer": {
        const outcome = await resolveApproval(client, effect.approval, effect.answer);
        return outcome === "answered"
          ? { kind: "answered" }
          : { kind: "failed", reason: "This approval is no longer awaiting an answer." };
      }
      default:
        return undefined;
    }
  }

  /**
   * Reads the conversation, then follows its events from that point, reconnecting from the last
   * event seen. A refused stream (signed out, no access) ends with a notice.
   */
  async #followChat(chat: OpenChat, generation: number, signal: AbortSignal): Promise<void> {
    const target = targetFor(chat.agentId, chat.threadId);
    let cursor: number;
    try {
      const snapshot = await threadSnapshot(this.#client, this.#spaceId, target);
      if (signal.aborted) return;
      cursor = snapshot.cursor;
      this.#send({ kind: "snapshot", generation, snapshot });
    } catch (error) {
      if (!signal.aborted) {
        this.#send({ kind: "failed", reason: `Could not open the chat. ${describeError(error)}` });
      }
      return;
    }
    const reply = new Reply();
    let failures = 0;
    while (!signal.aborted) {
      try {
        const events = await subscribeThread(this.#client, this.#spaceId, target, cursor, signal);
        for await (const event of events) {
          failures = 0;
          if (event.type === "heartbeat" || event.seq <= cursor) continue;
          cursor = event.seq;
          let updates: ReturnType<Reply["apply"]> = [];
          try {
            updates = reply.apply(event);
          } catch {
            // A malformed event is skipped; the next snapshot shows the saved message.
          }
          if (updates.length > 0 && !signal.aborted) {
            this.#send({ kind: "updates", generation, updates });
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        if (!isRetryable(error)) {
          this.#send({ kind: "failed", reason: `The chat stopped. ${describeError(error)}` });
          return;
        }
      }
      failures += 1;
      await abortableDelay(reconnectWait(failures), signal);
    }
  }

  /** The stream sends each kind when it opens, so reconnecting also catches up on anything missed. */
  async #followSignals(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const signals = await this.#client.subscribeNotifications(this.#spaceId, { signal });
        for await (const kind of signals) {
          failures = 0;
          if (kind === "roster") this.#send({ kind: "rosterChanged" });
          else if (kind === "runs") this.#send({ kind: "runsChanged" });
        }
      } catch {
        // A dropped or refused stream is opened again after a pause.
      }
      failures += 1;
      await abortableDelay(reconnectWait(failures), signal);
    }
  }
}

type Size = { width: number; height: number };

function useTerminalSize(): Size {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const read = () => ({ width: stdout.columns || 80, height: stdout.rows || 24 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const resized = () => setSize({ width: stdout.columns || 80, height: stdout.rows || 24 });
    stdout.on("resize", resized);
    return () => {
      stdout.off("resize", resized);
    };
  }, [stdout]);
  return size;
}

/** The screen with its keys and background work; `tasks` is created by the caller to test it. */
export function TuiApp(props: {
  app: App;
  createTasks: (dispatch: (message: Msg) => void) => Tasks;
  size?: Size;
}) {
  const { exit } = useApp();
  const terminal = useTerminalSize();
  const size = props.size ?? terminal;
  const [, redraw] = useState(0);
  const tasks = useRef<Tasks | undefined>(undefined);
  const app = props.app;

  const perform = (effects: Effect[]) => {
    for (const effect of effects) tasks.current?.run(app, effect);
    redraw((count) => count + 1);
    if (app.quit) exit();
  };

  useEffect(() => {
    const created = props.createTasks((message) => perform(receive(app, message)));
    tasks.current = created;
    created.followSignals();
    perform(start());
    return () => created.stop();
  }, []);

  useInput((input, key) => {
    perform(keysFrom(input, key).flatMap((pressed) => pressKey(app, pressed)));
  });

  return <TuiView app={app} width={size.width} height={size.height} />;
}

export async function runTui(client: Client, spaceName: string | undefined): Promise<void> {
  const catalog = await discover(client, spaceName);
  const space = catalog[0]?.space;
  if (!space) throw new CommandError("No spaces found for this account.");
  const app = newApp(space);
  const instance = render(
    <TuiApp app={app} createTasks={(dispatch) => new Tasks(client, space.id, dispatch)} />,
    { exitOnCtrlC: false, alternateScreen: true, patchConsole: false },
  );
  await instance.waitUntilExit();
}
