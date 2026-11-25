import type { ThreadEvent } from "@rakazo/cli-client";
import { describe, expect, it } from "vitest";
import { event } from "../test/loopback.test-support.js";
import { LinePrinter } from "./line-printer.js";
import type { Update } from "./reply.js";
import { Reply } from "./reply.js";

function print(named: boolean, events: unknown[]) {
  const reply = new Reply();
  let out = "";
  let err = "";
  const printer = new LinePrinter(
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
    "Fixture agent",
    named,
  );
  const updates: Update[] = [];
  for (const item of events) {
    for (const update of reply.apply(item as ThreadEvent)) {
      printer.update(update);
      updates.push(update);
    }
  }
  return { out, err, updates, printer };
}

const streamedReply = () => [
  event(1, "run.started", {}),
  event(2, "thread.meta", { activity: { thinking: true } }),
  event(3, "thread.progress", { streaming: true, delta: "The fixture " }),
  event(4, "thread.progress", { streaming: true, delta: "response" }),
  event(5, "thread.progress", { streaming: true, text: "The fixture response is" }),
  event(6, "thread.message.created", {
    messageId: "reply-1",
    seq: 3,
    role: "bot",
    blocks: [{ kind: "text", text: "The fixture response is blue." }],
  }),
  event(7, "run.completed", {}),
];

describe("Reply and LinePrinter", () => {
  it("streams deltas and finishes with the saved text", () => {
    const named = print(true, streamedReply());
    expect(named.out).toBe("Fixture agent > The fixture response is blue.\n");
    expect(named.updates).toContainEqual({ kind: "activity", text: "Thinking…" });
    expect(
      named.updates.flatMap((update) => (update.kind === "draft" ? [update.delta] : [])),
    ).toEqual(["The fixture ", "response", " is"]);
    expect(print(false, streamedReply()).out).toBe("The fixture response is blue.\n");
  });

  it("ends a withdrawn draft's line and prints the saved reply after it", () => {
    const { out, updates } = print(true, [
      event(1, "thread.progress", { streaming: true, delta: "Let me check" }),
      event(2, "thread.progress", { reset: true }),
      event(3, "thread.progress", { text: "Searching the web" }),
      event(4, "thread.message.created", {
        role: "bot",
        blocks: [{ kind: "text", text: "Found it." }],
      }),
    ]);
    expect(out).toBe("Fixture agent > Let me check\nFixture agent > Found it.\n");
    expect(updates).toContainEqual({ kind: "activity", text: "Searching the web" });
  });

  it("carries a run's ending with its reason and marks failures", () => {
    const reply = new Reply();
    const failed = reply.apply(
      event(1, "run.failed", { error: { message: "Model unavailable" } }) as ThreadEvent,
    );
    expect(failed.at(-1)).toEqual({
      kind: "runEnded",
      runId: "run-1",
      end: { kind: "failed", reason: "Model unavailable" },
    });
    const { printer, err } = print(true, [event(1, "run.failed", { error: "Model unavailable" })]);
    expect(printer.failed).toBe(true);
    expect(err).toBe("Agent run failed. Model unavailable\n");
    const waiting = reply.apply(event(2, "run.waiting_input", {}) as ThreadEvent);
    expect(waiting.at(-1)).toMatchObject({ kind: "runEnded", end: { kind: "waitingInput" } });
    expect(
      new Reply().apply(event(3, "run.failed", { error: "  " }) as ThreadEvent).at(-1),
    ).toMatchObject({ end: { reason: "No failure details were provided." } });
  });

  it("names members in the chat and leaves them out of send", () => {
    const member = event(1, "thread.message.created", {
      role: "user",
      author: { id: "user-2", name: "Ada" },
      blocks: [{ kind: "text", text: "Hi \u001b[31mall" }],
    });
    expect(print(true, [member]).out).toBe("Ada > Hi [31mall\n");
    expect(print(false, [member]).out).toBe("");
  });

  it("reports a cancelled run on standard error", () => {
    const { err, printer } = print(false, [event(1, "run.cancelled", {})]);
    expect(err).toBe("Agent run cancelled.\n");
    expect(printer.failed).toBe(true);
  });
});
