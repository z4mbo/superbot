import { findInstalledApps } from "../../apps/app-tools.js";
import { FIND_APPS, findAppsArgs } from "../../apps/app-tools.tool-definition.js";
import type { ToolHandlers } from "./run-tool-gate.js";

export const appTools: ToolHandlers = {
  async [FIND_APPS](ctx, call) {
    const input = findAppsArgs.safeParse(call.args);
    if (!input.success)
      return call.finish({ error: "query must be text of at most 200 characters." });
    // The run's own person and Space: an app someone else installed is never found.
    const scope = { spaceId: ctx.run.spaceId, userId: ctx.run.userId };
    return call.finish(await findInstalledApps(ctx.deps.prisma, scope, input.data.query));
  },
};
