import type { AppPermission } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { AppChangedError, listInstalledApps, readAppLaunch } from "./app-installs.js";
import { noAppsFound } from "./app-tools.prompt.js";

type FoundApp = {
  app_id: string;
  name: string;
  description: string;
  version: string;
  permissions: AppPermission[];
  /** Declared actions, listed only when the user let bots run them. */
  actions?: Array<{ name: string; description: string }>;
};

/**
 * The installed apps in the run's Space that match, each checked the way a launch checks it, so
 * an app whose stored version changed since it was installed is never offered. What a bot learns
 * follows the grant: an app's actions are listed only when the user allowed bots to run them.
 */
export async function findInstalledApps(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string },
  query: string | undefined,
): Promise<{ apps: FoundApp[]; note?: string }> {
  const needle = query?.trim().toLowerCase() ?? "";
  const installs = (await listInstalledApps(prisma, scope)).filter(
    (install) =>
      !needle ||
      [install.name, install.description, install.appId].some((text) =>
        text.toLowerCase().includes(needle),
      ),
  );
  const apps: FoundApp[] = [];
  for (const install of installs) {
    let launch: Awaited<ReturnType<typeof readAppLaunch>>;
    try {
      launch = await readAppLaunch(prisma, scope, install.id);
    } catch (error) {
      if (error instanceof AppChangedError) continue;
      throw error;
    }
    apps.push({
      app_id: launch.appId,
      name: launch.name,
      description: launch.manifest.description,
      version: launch.version,
      permissions: launch.granted,
      ...(launch.granted.includes("agent:actions") && launch.manifest.actions.length
        ? {
            actions: launch.manifest.actions.map(({ name, description }) => ({
              name,
              description,
            })),
          }
        : {}),
    });
  }
  return apps.length ? { apps } : { apps, note: noAppsFound(query) };
}
