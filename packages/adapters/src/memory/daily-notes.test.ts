import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryReadRequest,
  MemorySnapshot,
  MemoryStore,
} from "@rakazo/adapter-kit";
import { MEMORY_INDEX_PATH } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runs/assembly/run-context.js";
import type { ToolCall } from "../runs/tools/run-tool-gate.js";
import { memoryTools } from "../runs/tools/run-tools-memory.js";
import {
  appendDailyNote,
  DAILY_NOTE_EDIT_ERROR,
  dailyNoteDateOf,
  dailyNotePath,
  recentDailyNotePaths,
} from "./daily-notes.js";
import { loadAgentMemoryContext, readAgentMemory } from "./memory-context.js";

const context: AdapterContext = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

type StoredDocument = MemorySnapshot["documents"][number] & { scope: "bot" | "user" };

/** An offline store that honours the read filters the markdown store applies. */
function memoryStore(documents: StoredDocument[] = []) {
  const read = vi.fn(async (request: MemoryReadRequest) => ({
    documents: documents
      .filter(
        (doc) =>
          doc.scope === request.scope &&
          (!request.path || doc.path === request.path) &&
          (!request.excludePathPrefix || !doc.path.startsWith(request.excludePathPrefix)),
      )
      .map(({ scope: _scope, ...doc }) => doc),
  }));
  const commit = vi.fn(async (request: MemoryCommitRequest) => {
    const existing = documents.find(
      (doc) => doc.scope === request.scope && doc.path === request.path,
    );
    if (existing) {
      existing.content = request.content;
      existing.revision += 1;
      return { ...existing };
    }
    const created = {
      id: `doc-${documents.length + 1}`,
      scope: request.scope,
      path: request.path,
      content: request.content,
      revision: 1,
    };
    documents.push(created);
    return { ...created };
  });
  const store: MemoryStore = {
    describe: vi.fn<MemoryStore["describe"]>(),
    read,
    search: vi.fn<MemoryStore["search"]>(),
    commit,
    remove: vi.fn<MemoryStore["remove"]>(),
    exportMarkdown: vi.fn<MemoryStore["exportMarkdown"]>(),
    importMarkdown: vi.fn<MemoryStore["importMarkdown"]>(),
  };
  return { store, documents, read, commit };
}

function botDocument(path: string, content: string, updatedAt: string): StoredDocument {
  return { id: path, scope: "bot", path, content, revision: 1, updatedAt };
}

describe("daily note paths", () => {
  it("names one note per UTC day", () => {
    expect(dailyNotePath(new Date("2026-11-24T23:59:59.000Z"))).toBe("daily/2026-11-24.md");
    expect(dailyNotePath(new Date("2026-11-25T00:00:00.000Z"))).toBe("daily/2026-11-25.md");
  });

  it("lists today and yesterday, across a month boundary", () => {
    expect(recentDailyNotePaths(new Date("2026-12-01T08:00:00.000Z"))).toEqual([
      "daily/2026-12-01.md",
      "daily/2026-11-30.md",
    ]);
  });

  it("recognises only dated notes in the daily folder", () => {
    expect(dailyNoteDateOf("daily/2026-11-24.md")).toBe("2026-11-24");
    expect(dailyNoteDateOf(MEMORY_INDEX_PATH)).toBeUndefined();
    expect(dailyNoteDateOf("daily/plans.md")).toBeUndefined();
    expect(dailyNoteDateOf("projects/daily/2026-11-24.md")).toBeUndefined();
  });
});

describe("appendDailyNote", () => {
  it("adds an entry after the day's earlier ones", () => {
    expect(appendDailyNote("Met the design team.\n", "Shipped the release.")).toEqual({
      content: "Met the design team.\nShipped the release.\n",
    });
  });

  it("refuses an entry that would pass the cap and keeps the note as it was", () => {
    const result = appendDailyNote("a".repeat(30), "b".repeat(10), 32);
    expect(result).toEqual({ error: expect.stringContaining("Today's note is full") });
  });
});

describe("remember with daily", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function remember(store: MemoryStore, args: Record<string, unknown>) {
    const ctx = {
      deps: { memory: store },
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { id: "thread-1" },
      context,
    } as unknown as RunContext;
    const call = { name: "remember", args, finish: (result: unknown) => result };
    return memoryTools.remember!(ctx, call as unknown as ToolCall);
  }

  it("appends to today's note and never replaces the day's earlier entries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T09:00:00.000Z"));
    const { store, documents, commit } = memoryStore([
      botDocument(MEMORY_INDEX_PATH, "# Bot\n", "2026-11-01T00:00:00.000Z"),
    ]);

    await expect(remember(store, { content: "Drafted the plan.", daily: true })).resolves.toEqual({
      ok: true,
    });
    vi.setSystemTime(new Date("2026-11-24T17:30:00.000Z"));
    await expect(remember(store, { content: "Plan approved.", daily: true })).resolves.toEqual({
      ok: true,
    });

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]?.[0]).toMatchObject({
      scope: "bot",
      botId: "bot-1",
      path: "daily/2026-11-24.md",
      expectedRevision: 1,
    });
    expect(documents.find((doc) => doc.path === "daily/2026-11-24.md")).toMatchObject({
      content: "Drafted the plan.\nPlan approved.\n",
      revision: 2,
    });
    expect(documents.find((doc) => doc.path === MEMORY_INDEX_PATH)?.content).toBe("# Bot\n");
  });

  it("starts a new note on a new day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T22:00:00.000Z"));
    const { store, documents } = memoryStore();

    await remember(store, { content: "Late call with the client.", daily: true });
    vi.setSystemTime(new Date("2026-11-25T07:00:00.000Z"));
    await remember(store, { content: "Sent the follow-up.", daily: true });

    expect(documents.map((doc) => [doc.path, doc.content])).toEqual([
      ["daily/2026-11-24.md", "Late call with the client.\n"],
      ["daily/2026-11-25.md", "Sent the follow-up.\n"],
    ]);
  });

  it("refuses old_text on a daily note so entries stay as written", async () => {
    const { store, commit } = memoryStore();
    await expect(
      remember(store, { content: "new", old_text: "old", daily: true }),
    ).resolves.toEqual({ error: DAILY_NOTE_EDIT_ERROR });
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("daily notes in the prompt", () => {
  const now = new Date("2026-11-24T12:00:00.000Z");
  const stored = () => [
    botDocument(MEMORY_INDEX_PATH, "# Bot\nPrefers short answers.\n", "2026-11-20T00:00:00.000Z"),
    botDocument("projects/launch.md", "Launch is in December.\n", "2026-11-19T00:00:00.000Z"),
    botDocument("daily/2026-11-24.md", "today entry\n", "2026-11-24T10:00:00.000Z"),
    botDocument("daily/2026-11-23.md", "yesterday entry\n", "2026-11-23T18:00:00.000Z"),
    botDocument("daily/2026-11-22.md", "older entry\n", "2026-11-22T18:00:00.000Z"),
    {
      id: "shared",
      scope: "user" as const,
      path: "team.md",
      content: "Shared fact.\n",
      revision: 3,
      updatedAt: "2026-11-21T00:00:00.000Z",
    },
  ];

  it("loads today's and yesterday's notes and leaves older ones out", async () => {
    const { store } = memoryStore(stored());

    const text = await loadAgentMemoryContext(store, "bot-1", context, undefined, [], now);

    expect(text).toContain("## Your memory: daily/2026-11-24.md (revision 1)\ntoday entry");
    expect(text).toContain("## Your memory: daily/2026-11-23.md (revision 1)\nyesterday entry");
    expect(text).not.toContain("daily/2026-11-22.md");
    expect(text).not.toContain("older entry");
  });

  it("loads every other document exactly as before", async () => {
    const { store, read } = memoryStore(stored());

    const documents = await readAgentMemory(store, "bot-1", context, [], now);

    expect(documents.filter((doc) => !doc.path.startsWith("daily/"))).toEqual([
      { ...stored()[0], scope: "bot" },
      { ...stored()[1], scope: "bot" },
      { ...stored()[5], scope: "user" },
    ]);
    // Older notes are never fetched for the prompt, only today's and yesterday's by name.
    expect(read).toHaveBeenCalledWith(
      { scope: "bot", botId: "bot-1", excludePathPrefix: "daily/" },
      context,
    );
    expect(read).toHaveBeenCalledWith(
      { scope: "bot", botId: "bot-1", path: "daily/2026-11-24.md" },
      context,
    );
    expect(read).toHaveBeenCalledWith(
      { scope: "bot", botId: "bot-1", path: "daily/2026-11-23.md" },
      context,
    );
  });
});
