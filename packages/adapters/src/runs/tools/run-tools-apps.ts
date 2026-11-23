import { appForAgent, readAppPage, runAppPageAction } from "../../apps/app-pages.js";
import { findInstalledApps } from "../../apps/app-tools.js";
import { FIND_APPS, findAppsArgs } from "../../apps/app-tools.tool-definition.js";
import { READ_APP_STATE, RUN_APP_ACTION } from "../../tools/builtin-apps.tool-definition.js";
import type { ToolHandlers } from "./run-tool-gate.js";
import { reachablePage } from "./run-tools-pages.js";

/**
 * A bot reaches the apps it can reach as pages (its own and its group's), and within them only
 * what each app's manifest allows bots; the bridge check runs on the stored manifest.
 */
export const appTools: ToolHandlers = {
  async [READ_APP_STATE](ctx, call) {
    const pageId = typeof call.args.pageId === "string" ? call.args.pageId : "";
    if (!pageId) return call.finish({ error: "pageId is required." });
    const app = await readAppPage(ctx.deps.prisma, reachablePage(ctx, pageId));
    if (!app) return call.finish({ error: "No app with that pageId belongs to this bot or chat." });
    return call.finish(appForAgent(app));
  },
  async [RUN_APP_ACTION](ctx, call) {
    const { pageId, action, input } = call.args;
    if (typeof pageId !== "string" || !pageId) return call.finish({ error: "pageId is required." });
    if (typeof action !== "string" || !action) return call.finish({ error: "action is required." });
    const run = await runAppPageAction(ctx.deps.prisma, reachablePage(ctx, pageId), {
      by: "agent",
      action,
      input,
    });
    if (!run.ok) {
      return call.finish(
        run.reason === "not_found"
          ? { error: "No app with that pageId belongs to this bot or chat." }
          : { error: run.error, unchanged: true },
      );
    }
    await ctx.deps.events.publishSpaceChange?.(run.spaceId, "apps");
    return call.finish({ pageId: run.pageId, state: run.state, revision: run.revision });
  },
  async [FIND_APPS](ctx, call) {
    const input = findAppsArgs.safeParse(call.args);
    if (!input.success)
      return call.finish({ error: "query must be text of at most 200 characters." });
    // The run's own person and Space: an app someone else installed is never found.
    const scope = { spaceId: ctx.run.spaceId, userId: ctx.run.userId };
    return call.finish(await findInstalledApps(ctx.deps.prisma, scope, input.data.query));
  },
};
