import { MEMORY_REVISION_CONFLICT_ERROR, MemoryRevisionConflictError } from "@rakazo/adapter-kit";
import { HistoryReadInputSchema, HistorySearchInputSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { memoryTools, namesMemoryIndex, withoutBlankFields } from "./run-tools-memory.js";

describe("history tool arguments", () => {
  it("treats blank and null optional fields as not given", () => {
    expect(
      HistorySearchInputSchema.parse(
        withoutBlankFields({ queries: ["Aurora"], botId: "", before: " ", query: null }),
      ),
    ).toEqual({ queries: ["Aurora"] });
    expect(
      HistoryReadInputSchema.parse(
        withoutBlankFields({
          messageId: "cmw3l7emsa1sfb5bml8d0doe0",
          linkedRunId: "",
          threadId: "",
        }),
      ),
    ).toEqual({ messageId: "cmw3l7emsa1sfb5bml8d0doe0" });
  });
});

it.each(["isolated", "shared"])(
  "applies outside-input protections to explicit recall in %s scope",
  async (scope) => {
    const response = { ok: true, value: [{ memory: "A shared preference", score: 1 }] };
    const ctx = {
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { historyCompactedUpToSeq: null },
      context: {},
      state: { tainted: false },
      memory: { scope, semantic: { recall: vi.fn(async () => response) } },
      deps: { prisma: { run: { updateMany: vi.fn(async () => ({ count: 1 })) } } },
    };
    expect(
      await memoryTools.recall_memory!(ctx as never, { args: { query: "preference" } } as never),
    ).toEqual(response);
    expect(ctx.state.tainted).toBe(true);
  },
);

it.each(["Provider-generated context", ""])(
  "records reflection exposure only for a nonempty answer: %j",
  async (text) => {
    const ctx = {
      runId: "run-1",
      bot: { id: "bot-1" },
      context: {},
      state: { tainted: false },
      memory: { semantic: { reflect: vi.fn(async () => ({ ok: true, value: text })) } },
      deps: { prisma: { run: { updateMany: vi.fn(async () => ({ count: 1 })) } } },
    };
    await memoryTools.reflect_memory!(ctx as never, { args: { query: "Question" } } as never);
    expect(ctx.state.tainted).toBe(Boolean(text));
  },
);

describe("deleting a shared memory document", () => {
  const del = (path: string, documents: Array<{ id: string; path: string }>, removed = true) => {
    const memory = {
      read: vi.fn(async () => ({ documents })),
      remove: vi.fn(async () => ({ removed })),
    };
    const ctx = { context: { spaceId: "space-1" }, deps: { memory } };
    const result = memoryTools.delete_shared_memory!(
      ctx as never,
      { args: { path }, finish: (value: unknown) => value } as never,
    );
    return { memory, result };
  };

  it("removes exactly the document it read", async () => {
    const { memory, result } = del(" team.md ", [{ id: "doc-1", path: "team.md" }]);
    await expect(result).resolves.toEqual({ ok: true, path: "team.md" });
    expect(memory.read).toHaveBeenCalledWith(
      { scope: "user", path: "team.md" },
      { spaceId: "space-1" },
    );
    expect(memory.remove).toHaveBeenCalledWith(
      { id: "doc-1", scope: "user", path: "team.md" },
      { spaceId: "space-1" },
    );
  });

  it.each([
    "MEMORY.md",
    "memory.md",
    " Memory.MD ",
    "./MEMORY.md",
    "/MEMORY.md",
    "//MEMORY.md/",
    ".\\MEMORY.md",
    "notes/../MEMORY.md",
    "../MEMORY.md",
  ])("keeps MEMORY.md, which is edited instead, when asked for %j", async (path) => {
    const { memory, result } = del(path, [{ id: "doc-1", path: "MEMORY.md" }]);
    await expect(result).resolves.toEqual({
      error: "MEMORY.md cannot be deleted; edit its content instead.",
    });
    expect(memory.read).not.toHaveBeenCalled();
    expect(memory.remove).not.toHaveBeenCalled();
  });

  it("keeps MEMORY.md when a memory store resolves another name to it", async () => {
    const { memory, result } = del("index", [{ id: "doc-1", path: "MEMORY.md" }]);
    await expect(result).resolves.toEqual({
      error: "MEMORY.md cannot be deleted; edit its content instead.",
    });
    expect(memory.remove).not.toHaveBeenCalled();
  });

  it("does not mistake other documents for MEMORY.md", () => {
    for (const path of ["MEMORY.md.bak", "notes/MEMORY.md", "MEMORY", "team.md"]) {
      expect(namesMemoryIndex(path)).toBe(false);
    }
  });

  it("reports a document that does not exist", async () => {
    const { memory, result } = del("gone.md", []);
    await expect(result).resolves.toEqual({ error: "No shared memory document named gone.md." });
    expect(memory.remove).not.toHaveBeenCalled();
  });

  it("reports a document someone else deleted first", async () => {
    const { result } = del("team.md", [{ id: "doc-1", path: "team.md" }], false);
    await expect(result).resolves.toEqual({ error: "team.md was already deleted." });
  });
});

describe("saving shared memory over a newer revision", () => {
  const save = (failure: Error) => {
    const finish = vi.fn((result: unknown) => result);
    const ctx = {
      runId: "run-1",
      thread: { id: "thread-1" },
      context: {},
      deps: {
        memory: {
          read: vi.fn(async () => ({ documents: [{ revision: 1 }] })),
          commit: vi.fn().mockRejectedValue(failure),
        },
      },
    };
    return memoryTools.save_shared_memory!(
      ctx as never,
      { args: { path: "team.md", content: "new" }, finish } as never,
    );
  };

  it("tells the bot to read again", async () => {
    await expect(save(new MemoryRevisionConflictError())).resolves.toEqual({
      error: MEMORY_REVISION_CONFLICT_ERROR,
    });
  });

  it("lets another failure through, even one quoting the conflict", async () => {
    const failure = new Error(MEMORY_REVISION_CONFLICT_ERROR);
    await expect(save(failure)).rejects.toBe(failure);
  });
});

describe("remember into a named layer", () => {
  /** A store holding one bot's documents by path, with the commits it received. */
  const remember = async (args: Record<string, unknown>, profilePersonId?: string) => {
    const documents = new Map<string, { content: string; revision: number }>([
      ["MEMORY.md", { content: "# Pebble\n\n", revision: 1 }],
      ["people/ben.md", { content: "Ben likes tea.\n", revision: 3 }],
    ]);
    const commit = vi.fn(async (request: { path: string; content: string }) => request);
    const ctx = {
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { id: "thread-1" },
      context: {},
      memory: { semantic: null, scope: null, profilePersonId },
      deps: {
        memory: {
          read: vi.fn(async (request: { path: string }) => {
            const found = documents.get(request.path);
            return { documents: found ? [{ path: request.path, ...found }] : [] };
          }),
          commit,
        },
      },
    };
    const finish = vi.fn((result: unknown) => result);
    const result = await memoryTools.remember!(ctx as never, { args, finish } as never);
    return { result, commit };
  };

  it("keeps saving to the bot's own memory by default", async () => {
    const { result, commit } = await remember({ content: "Ships in May." }, "ana");
    expect(result).toEqual({ ok: true });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "bot",
        botId: "bot-1",
        path: "MEMORY.md",
        content: "# Pebble\n\nShips in May.\n",
        expectedRevision: 1,
      }),
      {},
    );
  });

  it("saves a fact about the current person to that person's profile", async () => {
    const { result, commit } = await remember(
      { content: "Prefers metric units.", layer: "profile" },
      "ana",
    );
    expect(result).toEqual({ ok: true });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "bot",
        botId: "bot-1",
        path: "people/ana.md",
        content: "Prefers metric units.\n",
        expectedRevision: 0,
      }),
      {},
    );
  });

  it("edits only the current person's existing profile", async () => {
    const { commit } = await remember(
      { content: "Ben likes coffee.", old_text: "Ben likes tea.", layer: "profile" },
      "ben",
    );
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "people/ben.md",
        content: "Ben likes coffee.\n",
        expectedRevision: 3,
      }),
      {},
    );
  });

  it("saves no profile when the run has no person, and accepts no other layer", async () => {
    const without = await remember({ content: "Prefers metric units.", layer: "profile" });
    expect(without.result).toMatchObject({ error: expect.stringContaining("No person") });
    expect(without.commit).not.toHaveBeenCalled();

    const soul = await remember({ content: "Be loud.", layer: "soul" }, "ana");
    expect(soul.result).toMatchObject({ error: expect.stringContaining("layer") });
    expect(soul.commit).not.toHaveBeenCalled();
  });
});
