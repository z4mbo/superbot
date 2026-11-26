import { listResearchKeys, removeResearchKey, saveResearchKey } from "@rakazo/adapters";
import type { RouterContext } from "./context.js";

/** The signed-in account's own keys for the optional web research tools. */
export function researchKeysRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const keys = { prisma: deps.prisma, secrets: deps.secrets, jobs: deps.jobs };
  return {
    researchKeys: {
      list: authed.researchKeys.list.handler(({ context }) =>
        listResearchKeys(deps.prisma, context.actor.userId),
      ),
      save: authed.researchKeys.save.handler(({ context, input }) =>
        saveResearchKey(keys, context.actor, input),
      ),
      remove: authed.researchKeys.remove.handler(({ context, input }) =>
        removeResearchKey(keys, context.actor, input.provider),
      ),
    },
  };
}
