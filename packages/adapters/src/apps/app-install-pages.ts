import type { Prisma, PrismaClient } from "@rakazo/db";
import { availableInSpace, isUniqueViolation } from "@rakazo/db";
import { appBridgeAllows } from "@rakazo/plugin-sdk";
import {
  APP_INSTALL_KIND,
  AppChangedError,
  AppNotInstalledError,
  appInstallSource,
  readAppLaunch,
} from "./app-installs.js";
import type { AppActionRun, AppPage } from "./app-pages.js";
import { readAppPage, runAppPageAction, withinGrant } from "./app-pages.js";

/**
 * An installed app keeps its state on a page of its own, one per person and Space, made from the
 * installed version the first time it is opened or one of its actions runs. That page belongs to
 * no bot, so no save reaches its code, and it goes when the app is removed. Its state and actions
 * run through the app page engine, as every app's do; a bot names the app by its manifest id.
 */

type Scope = { spaceId: string; userId: string };
type AppLaunch = Awaited<ReturnType<typeof readAppLaunch>>;

/**
 * The app `appId` the person installed and can use in this Space, checked as a launch is: an
 * unknown, removed or someone else's app is not installed here, and one whose stored version
 * changed since it was installed is refused.
 */
export async function installedAppLaunch(
  prisma: PrismaClient,
  scope: Scope,
  appId: string,
): Promise<AppLaunch> {
  const install = await prisma.capabilityInstall.findFirst({
    where: { ...availableInSpace(scope), kind: APP_INSTALL_KIND, source: appInstallSource(appId) },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!install) throw new AppNotInstalledError();
  const launch = await readAppLaunch(prisma, scope, install.id);
  if (launch.appId !== appId) throw new AppChangedError();
  return launch;
}

function statePage(scope: Scope, installId: string): Prisma.PageWhereInput {
  return { appInstallId: installId, spaceId: scope.spaceId, userId: scope.userId };
}

const pageSelect = { id: true, currentVersion: true, title: true } as const;

/** The page that keeps an installed app's state here, made from the launched version if new. */
export async function installedAppPage(
  prisma: PrismaClient,
  scope: Scope,
  launch: AppLaunch,
): Promise<{ pageId: string; version: number; title: string }> {
  const where = statePage(scope, launch.installId);
  let row = await prisma.page.findFirst({ where, select: pageSelect });
  if (!row) {
    try {
      row = await prisma.page.create({
        data: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          appInstallId: launch.installId,
          title: launch.name,
          versions: {
            create: {
              version: 1,
              title: launch.name,
              source: launch.source,
              code: launch.code,
              app: launch.manifest as Prisma.InputJsonObject,
            },
          },
        },
        select: pageSelect,
      });
    } catch (error) {
      // Made at the same moment by another call: that page is this app's.
      if (!isUniqueViolation(error)) throw error;
      row = await prisma.page.findFirstOrThrow({ where, select: pageSelect });
    }
  }
  return { pageId: row.id, version: row.currentVersion, title: row.title };
}

/**
 * An installed app as a bot reads it: its stored state, or its initial state before first use,
 * under only what both its manifest and the install's grant allow.
 */
export async function readInstalledApp(
  prisma: PrismaClient,
  scope: Scope,
  appId: string,
): Promise<Pick<AppPage, "manifest" | "state" | "revision">> {
  const launch = await installedAppLaunch(prisma, scope, appId);
  const stored = await readAppPage(prisma, statePage(scope, launch.installId));
  const app = stored ?? {
    manifest: launch.manifest,
    state: launch.manifest.initialState,
    revision: 0,
  };
  return { ...app, manifest: withinGrant(app.manifest, launch.granted) };
}

/**
 * Runs one declared action on an installed app for a bot, under only what both its manifest and
 * the install's grant allow. A refused action makes no page; the engine checks again on the
 * stored manifest with the same grant.
 */
export async function runInstalledAppAction(
  prisma: PrismaClient,
  scope: Scope,
  appId: string,
  request: { action: string; input: unknown },
): Promise<AppActionRun> {
  const launch = await installedAppLaunch(prisma, scope, appId);
  const allowed = appBridgeAllows(withinGrant(launch.manifest, launch.granted), {
    by: "agent",
    kind: "action",
    action: request.action,
  });
  if (!allowed.ok) return { ok: false, reason: "forbidden", error: allowed.error };
  await installedAppPage(prisma, scope, launch);
  return runAppPageAction(
    prisma,
    statePage(scope, launch.installId),
    { by: "agent", ...request },
    { granted: launch.granted },
  );
}
