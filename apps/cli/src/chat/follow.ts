import type { Client } from "@rakazo/cli-client";
import { abortableDelay, deadlineSignal } from "@rakazo/core";
import type { Outcome } from "../approvals/approvals.js";
import { offerApproval, waitingRuns } from "../approvals/approvals.js";
import {
  authHint,
  CommandError,
  describeError,
  isRetryable,
  isUnauthorized,
} from "../output/errors.js";
import { terminalText } from "../output/text.js";
import type { AgentRef } from "../session/catalog.js";
import type { Io } from "../terminal/io.js";
import { errorLine } from "../terminal/io.js";
import type { AgentThread, Snapshot } from "../threads/thread-api.js";
import { subscribeThread, targetFor, threadSnapshot } from "../threads/thread-api.js";
import type { Sink } from "./line-printer.js";
import { LinePrinter } from "./line-printer.js";
import { Reply } from "./reply.js";

/** The cursor of the last event shown, which a reconnect resumes after. */
export type Cursor = { value: number };

/** One open conversation with an agent, as the chat and `send` follow it. */
export class ChatThread {
  readonly client: Client;
  readonly spaceId: string;
  readonly agent: AgentRef;
  readonly conversation: string | undefined;
  readonly interactive: boolean;
  readonly io: Io;

  constructor(options: {
    client: Client;
    spaceId: string;
    agent: AgentRef;
    conversation?: string;
    interactive: boolean;
    io: Io;
  }) {
    this.client = options.client;
    this.spaceId = options.spaceId;
    this.agent = options.agent;
    this.conversation = options.conversation;
    this.interactive = options.interactive;
    this.io = options.io;
  }

  target(): AgentThread {
    return targetFor(this.agent.id, this.conversation);
  }

  snapshot(): Promise<Snapshot> {
    return threadSnapshot(this.client, this.spaceId, this.target());
  }

  /** Offers the card a waiting run stopped on; a failure to answer leaves it pending. */
  async offer(
    snapshot: Snapshot,
    runId: string,
    read: () => Promise<string | null>,
  ): Promise<Outcome> {
    try {
      return await offerApproval(
        this.io,
        this.client,
        this.spaceId,
        this.target(),
        snapshot,
        runId,
        this.interactive,
        read,
      );
    } catch (error) {
      if (isUnauthorized(error)) throw authHint(error);
      errorLine(this.io, `Could not answer the approval. ${terminalText(describeError(error))}`);
      return "leftPending";
    }
  }
}

const RECONNECTS = 3;

/**
 * Follows the thread until every pending run ends or one waits for an answer, which it returns.
 * A dropped stream reconnects after the last event seen, three times before giving up.
 */
export async function followUntilWaiting(
  thread: ChatThread,
  cursor: Cursor,
  pending: string[],
  sentSeq: number | undefined,
  reply: Reply,
  sink: Sink,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let reconnects = 0;
  for (;;) {
    let events: Awaited<ReturnType<typeof subscribeThread>> | undefined;
    try {
      events = await subscribeThread(
        thread.client,
        thread.spaceId,
        thread.target(),
        cursor.value,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (!isRetryable(error)) throw authHint(error);
    }
    if (events) {
      try {
        for await (const event of events) {
          if (event.type === "heartbeat" || event.seq <= cursor.value) continue;
          cursor.value = event.seq;
          reconnects = 0;
          for (const update of reply.apply(event)) {
            const shown =
              update.kind === "message"
                ? update.message.role === "bot" ||
                  (update.message.role === "user" && update.message.seq !== sentSeq)
                : update.kind === "runEnded"
                  ? pending.includes(update.runId)
                  : true;
            if (!shown) continue;
            sink.update(update);
            if (update.kind !== "runEnded") continue;
            if (update.end.kind === "waitingInput") return update.runId;
            const at = pending.indexOf(update.runId);
            if (at !== -1) pending.splice(at, 1);
            if (pending.length === 0) return undefined;
          }
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (!isRetryable(error)) throw authHint(error);
      }
    }
    if (reconnects >= RECONNECTS) {
      throw new CommandError(
        "The reply stream disconnected. Reopen the chat to see its latest messages.",
      );
    }
    reconnects += 1;
    await abortableDelay(300 * reconnects, signal);
    signal?.throwIfAborted();
  }
}

/** Runs `follow` within the reply budget; resolves to "timeout" when the budget runs out. */
export async function withinBudget<T>(
  budgetMs: number,
  follow: (signal: AbortSignal) => Promise<T>,
): Promise<T | "timeout"> {
  const signal = deadlineSignal(budgetMs);
  try {
    return await follow(signal);
  } catch (error) {
    if (signal.aborted) return "timeout";
    throw error;
  }
}

/**
 * Prints the reply to the runs a message started, offering each approval card a run stops on and
 * following the run again once it is answered.
 */
export async function followReply(
  thread: ChatThread,
  cursor: Cursor,
  runs: string[],
  sentSeq: number | undefined,
  read: () => Promise<string | null>,
  budgetMs: number,
): Promise<void> {
  const reply = new Reply();
  const printer = new LinePrinter(
    (text) => thread.io.out(text),
    (text) => thread.io.err(text),
    thread.agent.name,
    true,
  );
  while (runs.length > 0) {
    let runId: string | undefined;
    try {
      const waiting = await withinBudget(budgetMs, (signal) =>
        followUntilWaiting(thread, cursor, runs, sentSeq, reply, printer, signal),
      );
      if (waiting === "timeout") {
        errorLine(
          thread.io,
          "Still waiting after 10 minutes. Reopen the chat to see its latest messages.",
        );
        return;
      }
      runId = waiting;
    } catch (error) {
      if (isUnauthorized(error)) throw error;
      errorLine(thread.io, terminalText(describeError(error)));
      return;
    }
    if (runId === undefined) return;
    let outcome: Outcome;
    try {
      outcome = await thread.offer(await thread.snapshot(), runId, read);
    } catch (error) {
      if (isUnauthorized(error)) throw authHint(error);
      errorLine(thread.io, `Could not load the approval. ${terminalText(describeError(error))}`);
      outcome = "leftPending";
    }
    if (outcome === "leftPending") {
      const at = runs.indexOf(runId);
      if (at !== -1) runs.splice(at, 1);
    }
  }
}

/** Offers the approvals a reopened chat is still waiting on, then follows the answered runs. */
export async function resumeWaiting(
  thread: ChatThread,
  snapshot: Snapshot,
  cursor: Cursor,
  read: () => Promise<string | null>,
  budgetMs: number,
): Promise<void> {
  const resumed: string[] = [];
  for (const runId of waitingRuns(snapshot)) {
    if ((await thread.offer(snapshot, runId, read)) === "answered") resumed.push(runId);
  }
  await followReply(thread, cursor, resumed, undefined, read, budgetMs);
}
