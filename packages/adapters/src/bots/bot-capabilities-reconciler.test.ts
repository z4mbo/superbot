import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBotCapabilitiesReconciler } from "./bot-capabilities-reconciler.js";

const prisma = {} as PrismaClient;

describe("bot capabilities reconciler", () => {
  it("pages through bots from where it stopped and reports the Spaces it changed", async () => {
    const pages: Array<{ next: string | null; changedSpaceIds: string[] }> = [
      { next: "bot_50", changedSpaceIds: ["space_a"] },
      { next: null, changedSpaceIds: [] },
    ];
    const repair = vi.fn(
      async (_prisma: PrismaClient, _options: { after?: string }) => pages.shift()!,
    );
    const onChanged = vi.fn();
    await createBotCapabilitiesReconciler({ prisma, repair, onChanged })();
    expect(repair.mock.calls.map(([, options]) => options.after)).toEqual([undefined, "bot_50"]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(["space_a"]);
  });

  it("runs at start, then waits a quarter hour, and resumes a long pass where it left off", async () => {
    let now = 0;
    const repair = vi.fn(async (_prisma: PrismaClient, options: { after?: string }) => ({
      next: `after_${options.after ?? "start"}`,
      changedSpaceIds: [],
    }));
    const reconcile = createBotCapabilitiesReconciler({ prisma, repair, now: () => now });
    await reconcile();
    expect(repair).toHaveBeenCalledTimes(10);
    await reconcile();
    expect(repair).toHaveBeenCalledTimes(10);
    now = 15 * 60 * 1000;
    await reconcile();
    expect(repair).toHaveBeenCalledTimes(20);
    // The second pass starts after the last bot the first one looked at.
    expect(repair.mock.calls[10]![1].after).toBe(`after_${repair.mock.calls[9]![1].after}`);
  });
});
