import type {
  AdapterContext,
  MemoryReadRequest,
  MemorySnapshot,
  MemoryStore,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { loadAgentMemoryContext, readAgentMemory } from "./memory-context.js";
import { buildAgentMemoryPrompt } from "./memory-context.prompt.js";

const context: AdapterContext = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "space-1",
  userId: "ana",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

function doc(path: string, content: string, updatedAt = "2026-08-15T12:00:00.000Z") {
  return { id: path, path, content, revision: 1, updatedAt };
}

/** Bot and Space documents as the markdown store returns them for each scope. */
function store(bot: MemorySnapshot["documents"], space: MemorySnapshot["documents"] = []) {
  const read = vi.fn(async (request: MemoryReadRequest) => ({
    documents: request.scope === "bot" ? bot : space,
  }));
  return {
    read,
    store: {
      describe: vi.fn<MemoryStore["describe"]>(),
      read,
      search: vi.fn<MemoryStore["search"]>(),
      commit: vi.fn<MemoryStore["commit"]>(),
      remove: vi.fn<MemoryStore["remove"]>(),
      exportMarkdown: vi.fn<MemoryStore["exportMarkdown"]>(),
      importMarkdown: vi.fn<MemoryStore["importMarkdown"]>(),
    } satisfies MemoryStore,
  };
}

const layered = [
  // Newer than the layers, which still come first.
  doc("MEMORY.md", "Project Alpha ships in May.", "2026-08-16T12:00:00.000Z"),
  doc("SOUL.md", "Calm and direct."),
  doc("IDENTITY.md", "Name: Pebble"),
  doc("people/ana.md", "Ana prefers metric units."),
  doc("people/ben.md", "Ben is planning a surprise for Ana."),
];

describe("named memory layers at session start", () => {
  it("loads the bot's identity and soul and the current person's profile, ahead of other memory", async () => {
    const { store: memory } = store(layered, [doc("MEMORY.md", "Team uses Fridays for demos.")]);

    const text = await loadAgentMemoryContext(memory, "bot-1", context, undefined, ["ana"]);

    expect(text).toContain("## Your identity: IDENTITY.md (revision 1)\nName: Pebble");
    expect(text).toContain("## Your soul: SOUL.md (revision 1)\nCalm and direct.");
    expect(text).toContain(
      "## Profile of the person you are working for: people/ana.md (revision 1, 25 of 4096 bytes)\nAna prefers metric units.",
    );
    expect(text).toContain("Your identity and soul describe who you are");
    const order = ["Name: Pebble", "Calm and direct.", "Ana prefers", "Project Alpha", "Fridays"];
    const positions = order.map((fact) => text!.indexOf(fact));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it("never loads another person's profile", async () => {
    const { store: memory } = store(layered);

    const forAna = await loadAgentMemoryContext(memory, "bot-1", context, undefined, ["ana"]);
    expect(forAna).not.toContain("people/ben.md");
    expect(forAna).not.toContain("surprise");

    // A run with no person in the conversation reads no profile at all.
    const forNobody = await loadAgentMemoryContext(memory, "bot-1", context);
    expect(forNobody).not.toContain("people/");
    expect(forNobody).toContain("Calm and direct.");
  });

  it("reports only the viewer's own profile in the memory budget", async () => {
    const { store: memory } = store(layered);

    const documents = await readAgentMemory(memory, "bot-1", context, ["ben"]);
    const { plan } = buildAgentMemoryPrompt(documents);

    expect(plan.documents.map((entry) => entry.path)).toEqual([
      "IDENTITY.md",
      "SOUL.md",
      "people/ben.md",
      "MEMORY.md",
    ]);
  });

  it("falls back to existing memory, worded as before, when a bot has no layers yet", async () => {
    // A bot from before named layers: its notes, an imported USER.md, and Space memory.
    const legacy = [doc("MEMORY.md", "Likes tea."), doc("USER.md", "Prefers metric units.")];
    const space = [doc("USER.md", "The team is in Lisbon.", "2026-08-14T12:00:00.000Z")];
    const { store: memory, read } = store(legacy, space);

    const text = await loadAgentMemoryContext(memory, "bot-1", context, undefined, ["ana"]);
    const before = buildAgentMemoryPrompt([
      ...legacy.map((document) => ({ ...document, scope: "bot" as const })),
      ...space.map((document) => ({ ...document, scope: "user" as const })),
    ]).text;

    expect(read).toHaveBeenCalledTimes(4);
    expect(text).toBe(before);
    expect(text).toContain("## Your memory: USER.md (revision 1)\nPrefers metric units.");
    expect(text).toContain("## Shared memory: USER.md (revision 1)\nThe team is in Lisbon.");
    expect(text).not.toContain("Your identity and soul");
  });

  it("loads the layers that exist when others are missing", async () => {
    const { store: memory } = store([doc("SOUL.md", "Calm and direct."), doc("MEMORY.md", "x")]);

    const text = await loadAgentMemoryContext(memory, "bot-1", context, undefined, ["ana"]);

    expect(text).toContain("## Your soul: SOUL.md");
    expect(text).not.toContain("Your identity:");
    expect(text).not.toContain("Profile of the person");
  });
});
