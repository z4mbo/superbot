import type { PrismaClient } from "@rakazo/db";
import { repairBotCapabilities } from "@rakazo/db";

/** Once every bot has what creation gives, a pass finds nothing, so it runs rarely. */
const INTERVAL_MS = 15 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_PASS = 10;

/**
 * Gives bots made on older versions what a new bot gets at creation (see ensureBotCapabilities).
 * The elected reconciler runs it when the worker starts, so a deploy repairs existing bots within
 * moments, and again every quarter hour for any it could not finish. A run repairs its own bot
 * first, so nobody waits on this pass. No run, message or charge starts here.
 */
export function createBotCapabilitiesReconciler(deps: {
  prisma: PrismaClient;
  /** Spaces whose bots changed, so open clients re-read their roster. */
  onChanged?: (spaceIds: string[]) => void;
  now?: () => number;
  repair?: typeof repairBotCapabilities;
}): () => Promise<void> {
  const repair = deps.repair ?? repairBotCapabilities;
  let lastRun: number | undefined;
  let after: string | undefined;
  return async () => {
    const now = deps.now?.() ?? Date.now();
    if (lastRun !== undefined && now - lastRun < INTERVAL_MS) return;
    lastRun = now;
    for (let page = 0; page < MAX_PAGES_PER_PASS; page += 1) {
      const { next, changedSpaceIds } = await repair(deps.prisma, {
        after,
        take: PAGE_SIZE,
      });
      if (changedSpaceIds.length) deps.onChanged?.(changedSpaceIds);
      after = next ?? undefined;
      if (!next) return;
    }
  };
}
