import type { AppActionFailure, AppFunctionDeps } from "@rakazo/adapters";
import {
  functionAction,
  readAppLaunch,
  readAppPage,
  runAppFunction,
  runAppPageAction,
} from "@rakazo/adapters";
import type { Actor, AppFunctionResult, AppView } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { findAction } from "@rakazo/plugin-sdk";

/** A person's own pages in this Space; another person's app reads as no app. */
const ownPage = (actor: Actor, pageId: string) => ({
  id: pageId,
  spaceId: actor.spaceId,
  userId: actor.userId,
});

type Refusal = Exclude<AppActionFailure["reason"], "not_found"> | "failed";

export class AppActionRefusedError extends ClientError {
  constructor(failure: Refusal, message: string) {
    super(
      failure === "forbidden" ? "FORBIDDEN" : failure === "conflict" ? "CONFLICT" : "BAD_REQUEST",
      message,
      failure === "forbidden"
        ? "APP_ACTION_FORBIDDEN"
        : failure === "conflict"
          ? "APP_ACTION_CONFLICT"
          : failure === "failed"
            ? "APP_FUNCTION_FAILED"
            : "APP_ACTION_INVALID",
    );
  }
}

/** What the viewer host needs to open an app: permissions, action names and stored state. */
export async function pageAppView(
  prisma: PrismaClient,
  actor: Actor,
  pageId: string,
): Promise<{ app: AppView | null }> {
  const app = await readAppPage(prisma, ownPage(actor, pageId));
  if (!app) return { app: null };
  const functions = app.manifest.actions.filter((action) => action.run !== undefined);
  return {
    app: {
      name: app.manifest.name,
      permissions: app.manifest.permissions,
      actions: app.manifest.actions.map((action) => action.name),
      state: app.state,
      revision: app.revision,
      ...(functions.length
        ? {
            functions: functions.map((action) => action.name),
            queries: functions.filter((action) => action.readOnly).map((action) => action.name),
          }
        : {}),
    },
  };
}

type PageAppDeps = AppFunctionDeps & {
  publishSpaceChange?: (spaceId: string, kind: "apps") => Promise<void>;
};

/**
 * Runs a function-backed action of the installed app whose state page this is. The install is
 * read the way a launch reads it, so a changed or removed app does not run.
 */
async function runPageFunction(
  deps: PageAppDeps,
  actor: Actor,
  input: { pageId: string; action: string; input?: Record<string, unknown> },
  kind: "action" | "query",
  signal?: AbortSignal,
) {
  const page = await readAppPage(deps.prisma, ownPage(actor, input.pageId));
  if (!page) throw new IsolationError();
  if (!page.appInstallId)
    throw new AppActionRefusedError(
      "forbidden",
      "Only an installed app runs functions. Publish it and install it from Apps.",
    );
  const launch = await readAppLaunch(deps.prisma, actor, page.appInstallId);
  const checked = functionAction(launch, { by: "person", kind, action: input.action });
  if (!checked.ok) throw new AppActionRefusedError(checked.reason, checked.error);
  const run = await runAppFunction(deps, actor, launch, checked.action, input.input ?? {}, signal);
  if (!run.ok) throw new AppActionRefusedError(run.reason, run.error);
  if (run.changed) await deps.publishSpaceChange?.(actor.spaceId, "apps");
  return { page, result: (run.result ?? null) as AppFunctionResult };
}

export async function runPageAppAction(
  deps: PageAppDeps,
  actor: Actor,
  input: { pageId: string; action: string; input?: Record<string, unknown> },
  signal?: AbortSignal,
) {
  const app = await readAppPage(deps.prisma, ownPage(actor, input.pageId));
  if (app && findAction(app.manifest, input.action)?.run !== undefined) {
    const { page, result } = await runPageFunction(deps, actor, input, "action", signal);
    return { state: page.state, revision: page.revision, result };
  }
  const run = await runAppPageAction(deps.prisma, ownPage(actor, input.pageId), {
    by: "person",
    action: input.action,
    input: input.input ?? {},
  });
  if (!run.ok) {
    if (run.reason === "not_found") throw new IsolationError();
    throw new AppActionRefusedError(run.reason, run.error);
  }
  await deps.publishSpaceChange?.(run.spaceId, "apps");
  return { state: run.state, revision: run.revision };
}

/** The answer of a read-only action, for the app's view; it needs no click and changes nothing. */
export async function pageAppQuery(
  deps: PageAppDeps,
  actor: Actor,
  input: { pageId: string; action: string; input?: Record<string, unknown> },
  signal?: AbortSignal,
) {
  const { result } = await runPageFunction(deps, actor, input, "query", signal);
  return { result };
}
