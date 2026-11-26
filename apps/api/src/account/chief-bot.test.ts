import type { Actor, Bot } from "@rakazo/contracts";
import { CHIEF_BOT } from "@rakazo/contracts";
import { ComputerLimitError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ChiefBotDeps } from "./chief-bot.js";
import { ensureChiefBot } from "./chief-bot.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};

function fixture(
  options: {
    marked?: boolean;
    existing?: { id: string; archivedAt: Date | null } | null;
    deleted?: boolean;
    history?: boolean;
    adopted?: number;
    createFails?: Error;
  } = {},
) {
  const order: string[] = [];
  const deps = {
    prisma: {
      space: {
        findUnique: vi.fn(async () => ({
          chiefBotAt: options.marked ? new Date() : null,
          deletingAt: null,
        })),
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => {
          order.push("mark");
          return { count: 1 };
        }),
      },
      bot: {
        findUnique: vi.fn(async () => options.existing ?? null),
        findFirst: vi.fn(async () => (options.history === false ? null : { id: "own" })),
        updateMany: vi.fn(async () => ({ count: options.adopted ?? 0 })),
      },
      chatGroup: { findFirst: vi.fn(async () => null) },
      botDeletion: { findFirst: vi.fn(async () => (options.deleted ? { id: "gone" } : null)) },
    },
    createBot: vi.fn(async () => {
      if (options.createFails) throw options.createFails;
      order.push("create");
      return { id: "chief-new" } as Bot;
    }),
    publishRosterChange: vi.fn(async () => {
      order.push("publish");
    }),
  };
  return {
    deps,
    order,
    run: () => ensureChiefBot(deps as unknown as ChiefBotDeps, actor),
  };
}

describe("ensureChiefBot", () => {
  it("creates the main bot as the product, then marks the Space and signals open rosters", async () => {
    const { deps, order, run } = fixture();
    await expect(run()).resolves.toEqual({ botId: "chief-new" });
    expect(deps.createBot).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        name: CHIEF_BOT.name,
        lookShape: CHIEF_BOT.lookShape,
        lookColor: CHIEF_BOT.lookColor,
        spawnKey: CHIEF_BOT.spawnKey,
        computerMode: "team",
      }),
    );
    expect(order).toEqual(["create", "mark", "publish"]);
    expect(deps.publishRosterChange).toHaveBeenCalledWith({ spaceIds: [actor.spaceId] });
  });

  it("does nothing once the Space is marked", async () => {
    const { deps, run } = fixture({ marked: true });
    await expect(run()).resolves.toEqual({ botId: null });
    expect(deps.prisma.bot.findUnique).not.toHaveBeenCalled();
    expect(deps.createBot).not.toHaveBeenCalled();
    expect(deps.publishRosterChange).not.toHaveBeenCalled();
  });

  it("leaves a person who never chatted to onboarding, unmarked", async () => {
    const { deps, run } = fixture({ history: false });
    await expect(run()).resolves.toEqual({ botId: null });
    expect(deps.createBot).not.toHaveBeenCalled();
    expect(deps.prisma.space.updateMany).not.toHaveBeenCalled();
  });

  it("adopts the main bot already there, signalling only when it changed", async () => {
    const untouched = fixture({ existing: { id: "first", archivedAt: null }, adopted: 1 });
    await expect(untouched.run()).resolves.toEqual({ botId: "first" });
    expect(untouched.deps.createBot).not.toHaveBeenCalled();
    expect(untouched.order).toEqual(["mark", "publish"]);
    // Only a bot still carrying the first-run name, or no look at all, is changed.
    expect(untouched.deps.prisma.bot.updateMany).toHaveBeenCalledWith({
      where: { id: "first", name: "Chief" },
      data: { name: CHIEF_BOT.name },
    });
    expect(untouched.deps.prisma.bot.updateMany).toHaveBeenCalledWith({
      where: { id: "first", lookShape: null, lookColor: null },
      data: { lookShape: CHIEF_BOT.lookShape, lookColor: CHIEF_BOT.lookColor },
    });

    const customised = fixture({ existing: { id: "first", archivedAt: null }, adopted: 0 });
    await customised.run();
    expect(customised.order).toEqual(["mark"]);
  });

  it("marks without making another when the main bot was archived or deleted", async () => {
    for (const options of [
      { existing: { id: "first", archivedAt: new Date() } },
      { deleted: true },
    ]) {
      const { deps, order, run } = fixture(options);
      await expect(run()).resolves.toEqual({ botId: null });
      expect(deps.createBot).not.toHaveBeenCalled();
      expect(order).toEqual(["mark"]);
    }
  });

  it("waits, unmarked, while the person has no computer to spare", async () => {
    const { deps, run } = fixture({ createFails: new ComputerLimitError(1) });
    await expect(run()).resolves.toEqual({ botId: null });
    expect(deps.prisma.space.updateMany).not.toHaveBeenCalled();
    const failure = fixture({ createFails: new Error("database down") });
    await expect(failure.run()).rejects.toThrow("database down");
    expect(failure.deps.prisma.space.updateMany).not.toHaveBeenCalled();
  });
});
