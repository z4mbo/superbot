import type { AppActionFailure } from "@rakazo/adapters";
import { readAppPage, runAppPageAction } from "@rakazo/adapters";
import type { Actor, AppView } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

/** A person's own pages in this Space; another person's app reads as no app. */
const ownPage = (actor: Actor, pageId: string) => ({
  id: pageId,
  spaceId: actor.spaceId,
  userId: actor.userId,
});

export class AppActionRefusedError extends ClientError {
  constructor(failure: Exclude<AppActionFailure["reason"], "not_found">, message: string) {
    super(
      failure === "forbidden" ? "FORBIDDEN" : failure === "conflict" ? "CONFLICT" : "BAD_REQUEST",
      message,
      failure === "forbidden"
        ? "APP_ACTION_FORBIDDEN"
        : failure === "conflict"
          ? "APP_ACTION_CONFLICT"
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
  return {
    app: {
      name: app.manifest.name,
      permissions: app.manifest.permissions,
      actions: app.manifest.actions.map((action) => action.name),
      state: app.state,
      revision: app.revision,
    },
  };
}

export async function runPageAppAction(
  deps: {
    prisma: PrismaClient;
    publishSpaceChange?: (spaceId: string, kind: "apps") => Promise<void>;
  },
  actor: Actor,
  input: { pageId: string; action: string; input?: Record<string, unknown> },
) {
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
