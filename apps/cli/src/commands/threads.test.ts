import type { BotConversation } from "@rakazo/cli-client";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../threads/thread-api.js";
import {
  conversationLabel,
  conversationRows,
  LABEL_CHARS,
  listLabel,
  transcript,
  transcriptJson,
} from "./threads.js";

function added(id: string, title: string | null, archived: boolean): BotConversation {
  return {
    threadId: id,
    botId: "bot-1",
    createdAt: "2026-11-20T00:00:00Z",
    title,
    pinnedAt: null,
    archivedAt: archived ? "2026-11-21T00:00:00Z" : null,
    preview: "Last reply",
  } as BotConversation;
}

describe("threads", () => {
  it("lists the first conversation, then open added ones", () => {
    const rows = conversationRows("thread-1", [
      added("thread-3", "Launch plan", false),
      added("thread-2", null, true),
      added("thread-4", null, false),
    ]);
    expect(rows.map((row) => [row.threadId, conversationLabel(row)])).toEqual([
      ["thread-1", "First conversation"],
      ["thread-3", "Launch plan"],
      ["thread-4", "Last reply"],
    ]);
    expect(rows[0]?.first && !rows[1]?.first).toBe(true);
    expect(
      conversationLabel({ threadId: "thread-5", first: false, title: null, preview: "  " }),
    ).toBe("New conversation");
    expect(listLabel("Plan\nsecond line")).toBe("Plan");
    const long = listLabel("word ".repeat(30));
    expect([...long]).toHaveLength(LABEL_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("names speakers in the transcript and skips cards", () => {
    const snapshot = {
      threadId: "thread-1",
      cursor: 4,
      messages: [
        {
          id: "m1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          createdAt: "2026-11-20T00:00:00Z",
          author: { id: "user-1", name: "Ada" },
          blocks: [{ kind: "text", text: "Hello" }],
        },
        {
          id: "m2",
          threadId: "thread-1",
          seq: 2,
          role: "bot",
          createdAt: "2026-11-20T00:00:01Z",
          blocks: [{ kind: "ask", text: "Allow?" }],
        },
        {
          id: "m3",
          threadId: "thread-1",
          seq: 3,
          role: "bot",
          createdAt: "2026-11-20T00:00:02Z",
          blocks: [{ kind: "text", text: "Hi Ada" }],
        },
      ],
    } satisfies Snapshot;
    expect(transcript(snapshot, "Research")).toBe("Ada > Hello\nResearch > Hi Ada\n");
    expect(transcriptJson(snapshot)).toEqual({
      threadId: "thread-1",
      messages: [
        {
          id: "m1",
          role: "user",
          author: { id: "user-1", name: "Ada" },
          text: "Hello",
          createdAt: "2026-11-20T00:00:00Z",
        },
        { id: "m2", role: "bot", author: null, text: "", createdAt: "2026-11-20T00:00:01Z" },
        { id: "m3", role: "bot", author: null, text: "Hi Ada", createdAt: "2026-11-20T00:00:02Z" },
      ],
    });
  });
});
