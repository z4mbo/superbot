import type { MessageBlock } from "@rakazo/contracts";
import { parseFields } from "@rakazo/plugin-sdk";
import type { InstalledFunctionRun } from "../../apps/app-install-pages.js";
import {
  installedAppLaunch,
  installedAppPage,
  readInstalledApp,
  runInstalledAppAction,
} from "../../apps/app-install-pages.js";
import { AppChangedError, AppNotInstalledError } from "../../apps/app-installs.js";
import type { AppActionRun } from "../../apps/app-pages.js";
import { appForAgent, readAppPage, runAppPageAction } from "../../apps/app-pages.js";
import { findInstalledApps } from "../../apps/app-tools.js";
import { APP_NOT_INSTALLED } from "../../apps/app-tools.prompt.js";
import {
  FIND_APPS,
  findAppsArgs,
  OPEN_APP,
  openAppArgs,
} from "../../apps/app-tools.tool-definition.js";
import { READ_APP_STATE, RUN_APP_ACTION } from "../../tools/builtin-apps.tool-definition.js";
import type { RunContext } from "../assembly/run-context.js";
import { publishMessage } from "../assembly/run-messages.js";
import type { ToolHandlers } from "./run-tool-gate.js";
import { reachablePage } from "./run-tools-pages.js";

const PAGE_NOT_FOUND = "No app with that pageId belongs to this bot or chat.";

/** The app a call names: an app page by pageId, or an installed app by app_id. */
function appRef(
  args: Record<string, unknown>,
): { pageId: string } | { appId: string } | { error: string } {
  const pageId = typeof args.pageId === "string" ? args.pageId : "";
  const appId = typeof args.app_id === "string" ? args.app_id : "";
  if (pageId && appId) return { error: "Pass pageId or app_id, not both." };
  if (appId) return { appId };
  if (pageId) return { pageId };
  return { error: "pageId or app_id is required." };
}

/**
 * An installed app is the run's own person's, in the run's Space, as find_apps lists it; an app
 * someone else installed, or one not installed here, reads as not installed.
 */
const runScope = (ctx: RunContext) => ({ spaceId: ctx.run.spaceId, userId: ctx.run.userId });

/** Runs `work` on an installed app; an app not installed here, or changed, is refused. */
async function onInstalledApp<T>(
  work: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof AppNotInstalledError) return { ok: false, error: APP_NOT_INSTALLED };
    if (error instanceof AppChangedError) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * A bot reaches the apps it can reach as pages (its own and its group's) and the apps its person
 * installed here, and within them only what each app's manifest allows bots, narrowed for an
 * installed app to what its install granted; the bridge check runs on the stored manifest.
 */
export const appTools: ToolHandlers = {
  async [READ_APP_STATE](ctx, call) {
    const ref = appRef(call.args);
    if ("error" in ref) return call.finish(ref);
    if ("appId" in ref) {
      const read = await onInstalledApp(() =>
        readInstalledApp(ctx.deps.prisma, runScope(ctx), ref.appId),
      );
      return call.finish(
        read.ok ? appForAgent(read.value, { app_id: ref.appId }) : { error: read.error },
      );
    }
    const app = await readAppPage(ctx.deps.prisma, reachablePage(ctx, ref.pageId));
    if (!app) return call.finish({ error: PAGE_NOT_FOUND });
    return call.finish(appForAgent(app, { pageId: app.pageId }));
  },
  async [RUN_APP_ACTION](ctx, call) {
    const { action, input } = call.args;
    const ref = appRef(call.args);
    if ("error" in ref) return call.finish(ref);
    if (typeof action !== "string" || !action) return call.finish({ error: "action is required." });
    const request = { by: "agent" as const, action, input };
    let run: AppActionRun | InstalledFunctionRun;
    if ("appId" in ref) {
      const installed = await onInstalledApp(() =>
        runInstalledAppAction(
          { prisma: ctx.deps.prisma },
          runScope(ctx),
          ref.appId,
          request,
          ctx.context.signal,
        ),
      );
      if (!installed.ok) return call.finish({ error: installed.error });
      run = installed.value;
    } else {
      run = await runAppPageAction(ctx.deps.prisma, reachablePage(ctx, ref.pageId), request);
    }
    if (!run.ok) {
      return call.finish(
        run.reason === "not_found"
          ? { error: "appId" in ref ? APP_NOT_INSTALLED : PAGE_NOT_FOUND }
          : { error: run.error, unchanged: true },
      );
    }
    if ("result" in run) {
      // A function's answer; open views read again only when its records changed.
      if (run.changed) await ctx.deps.events.publishSpaceChange?.(run.spaceId, "apps");
      return call.finish({ ...("appId" in ref ? { app_id: ref.appId } : {}), result: run.result });
    }
    await ctx.deps.events.publishSpaceChange?.(run.spaceId, "apps");
    return call.finish({
      ...("appId" in ref ? { app_id: ref.appId } : { pageId: run.pageId }),
      state: run.state,
      revision: run.revision,
    });
  },
  async [FIND_APPS](ctx, call) {
    const input = findAppsArgs.safeParse(call.args);
    if (!input.success)
      return call.finish({ error: "query must be text of at most 200 characters." });
    // The run's own person and Space: an app someone else installed is never found.
    return call.finish(await findInstalledApps(ctx.deps.prisma, runScope(ctx), input.data.query));
  },
  async [OPEN_APP](ctx, call) {
    const input = openAppArgs.safeParse(call.args);
    if (!input.success)
      return call.finish({ error: "app_id is required; card is a card name and input an object." });
    const scope = runScope(ctx);
    const { app_id: appId, card: cardName } = input.data;
    const opened = await onInstalledApp(async () => {
      const launch = await installedAppLaunch(ctx.deps.prisma, scope, appId);
      return { launch, page: await installedAppPage(ctx.deps.prisma, scope, launch) };
    });
    if (!opened.ok) return call.finish({ error: opened.error });
    const { launch, page } = opened.value;
    let card: { name: string; input: Record<string, string | number | boolean> } | undefined;
    if (cardName !== undefined) {
      const declared = launch.manifest.cards?.find((entry) => entry.name === cardName);
      if (!declared) {
        const names = (launch.manifest.cards ?? []).map((entry) => entry.name);
        return call.finish({
          error: names.length
            ? `${launch.name} has no card ${cardName}; it has: ${names.join(", ")}.`
            : `${launch.name} has no cards; open it without card.`,
        });
      }
      const fields = parseFields(declared.input ?? {}, input.data.input, {
        owner: `The ${cardName} card`,
      });
      if (!fields.ok) return call.finish({ error: fields.error });
      card = { name: cardName, input: fields.input };
    } else if (input.data.input !== undefined) {
      return call.finish({ error: "input goes with a card; name the card too." });
    }
    // The same card a saved page posts: it opens where pages open, with the app's stored state.
    const block: MessageBlock = { kind: "page", ...page, ...(card ? { card } : {}) };
    const posted = await publishMessage(ctx.deps, ctx.run, "bot", [block]);
    if (!posted) return call.finish({ error: "Apps open only in a chat with the user." });
    return call.finish({
      app_id: appId,
      title: page.title,
      opened: true,
      ...(card ? { card: card.name } : {}),
    });
  },
};
