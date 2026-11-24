import type { MemorySnapshot } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { botMemoryDocuments, conversationProfilePerson } from "./memory-layers.js";

function snapshot(...paths: string[]): MemorySnapshot {
  return {
    documents: paths.map((path, index) => ({
      id: `doc-${index}`,
      path,
      content: `content of ${path}`,
      revision: 1,
      updatedAt: "2026-08-15T12:00:00.000Z",
    })),
  };
}

describe("the person whose profile a run may use", () => {
  it("is the person the run acts for when they own the conversation", () => {
    expect(
      conversationProfilePerson({ personId: "ana", threadUserId: "ana", authorUserIds: [] }),
    ).toBe("ana");
  });

  it("is the person the run acts for when they wrote in a conversation someone else started", () => {
    expect(
      conversationProfilePerson({
        personId: "ben",
        threadUserId: "ana",
        authorUserIds: [null, "ana", "ben"],
      }),
    ).toBe("ben");
  });

  it("is nobody when the person the run acts for is not part of the conversation", () => {
    expect(
      conversationProfilePerson({
        personId: "cleo",
        threadUserId: "ana",
        authorUserIds: ["ana", "ben", undefined],
      }),
    ).toBeUndefined();
  });

  it("is never one of the other people in the conversation", () => {
    // Ana and Ben both wrote here, but Ben's run reads only Ben's profile.
    expect(
      conversationProfilePerson({
        personId: "ben",
        threadUserId: "ana",
        authorUserIds: ["ana", "ben"],
      }),
    ).not.toBe("ana");
  });
});

describe("a bot's memory documents", () => {
  it("names the soul and identity layers and keeps other memory as it was", () => {
    const documents = botMemoryDocuments(
      snapshot("MEMORY.md", "SOUL.md", "IDENTITY.md", "USER.md", "memory/2026-01-02.md"),
      [],
    );
    expect(documents.map((document) => [document.path, document.layer, document.scope])).toEqual([
      ["MEMORY.md", undefined, "bot"],
      ["SOUL.md", "soul", "bot"],
      ["IDENTITY.md", "identity", "bot"],
      // A USER.md from an earlier import is ordinary memory and still loads.
      ["USER.md", undefined, "bot"],
      ["memory/2026-01-02.md", undefined, "bot"],
    ]);
  });

  it("keeps only the profiles of the given people", () => {
    const documents = botMemoryDocuments(snapshot("MEMORY.md", "people/ana.md", "people/ben.md"), [
      "ben",
    ]);
    expect(documents.map((document) => [document.path, document.layer])).toEqual([
      ["MEMORY.md", undefined],
      ["people/ben.md", "profile"],
    ]);
    expect(JSON.stringify(documents)).not.toContain("people/ana.md");
  });

  it("keeps no profile when no person is given, and never a malformed one", () => {
    const documents = botMemoryDocuments(
      snapshot("people/ana.md", "people/nested/ana.md", "people/.md", "people/ana.txt"),
      [],
    );
    expect(documents).toEqual([]);
    expect(botMemoryDocuments(snapshot("people/nested/ana.md", "people/ana.txt"), ["ana"])).toEqual(
      [],
    );
  });
});
