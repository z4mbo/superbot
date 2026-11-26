import type { Actor, GeneratedMediaInfo } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { conversationLibrary } from "./conversation-library.js";

const { generated } = vi.hoisted(() => ({
  generated: {
    kind: "image",
    prompt: "a red fox",
    provider: "provider-a",
    providerName: "Provider A",
    model: "model-a",
  } satisfies GeneratedMediaInfo,
}));

vi.mock("./thread-message-pages.js", () => ({
  loadMessagePage: vi.fn(async () => ({
    messages: [
      {
        id: "message-1",
        role: "bot",
        runId: "run-1",
        createdAt: "2026-11-01T00:00:00.000Z",
        blocks: [
          {
            kind: "image",
            artifactId: "generated-image",
            mimeType: "image/png",
            name: "a.png",
            generated,
          },
          { kind: "file", artifactId: "notes", mimeType: "text/plain", name: "notes.txt", size: 4 },
        ],
      },
    ],
  })),
}));

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

describe("conversationLibrary", () => {
  it("carries what made a generated image, and nothing on other files", async () => {
    const artifact = (id: string, mimeType: string) => ({
      id,
      name: id,
      userId: "user-1",
      botId: "bot-1",
      runId: "run-1",
      mimeType,
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    const prisma = {
      artifact: {
        findMany: vi.fn(async () => [
          artifact("generated-image", "image/png"),
          artifact("notes", "text/plain"),
        ]),
      },
      page: { findMany: vi.fn(async () => []) },
      run: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const items = await conversationLibrary(prisma, actor, "thread-1");
    expect(items.map((item) => [item.id, item.generated])).toEqual([
      ["generated-image", generated],
      ["notes", undefined],
    ]);
  });
});
