import type { AppPermission } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { appBridgeAllows } from "@rakazo/plugin-sdk";
import { AppChangedError, listInstalledApps, readAppLaunch } from "./app-installs.js";
import { withinGrant } from "./app-pages.js";
import { noAppsFound } from "./app-tools.prompt.js";

type FoundApp = {
  app_id: string;
  name: string;
  description: string;
  version: string;
  permissions: AppPermission[];
  /** Actions a bot may run here: read-only ones with agent:read, the rest with agent:actions. */
  actions?: Array<{ name: string; description: string; readOnly?: true }>;
  /** Cards open_app can show. */
  cards?: Array<{ name: string; title: string; description: string }>;
};

/** What a bot may do with an installed app, by its grant. */
function agentSurface(launch: Awaited<ReturnType<typeof readAppLaunch>>) {
  const surface = withinGrant(launch.manifest, launch.granted);
  const actions = surface.actions
    .filter(
      (action) => appBridgeAllows(surface, { by: "agent", kind: "action", action: action.name }).ok,
    )
    .map(({ name, description, readOnly }) => ({
      name,
      description,
      ...(readOnly ? { readOnly: true as const } : {}),
    }));
  const cards = (surface.cards ?? []).map(({ name, title, description }) => ({
    name,
    title,
    description,
  }));
  return { ...(actions.length ? { actions } : {}), ...(cards.length ? { cards } : {}) };
}

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
      ...agentSurface(launch),
    });
  }
  return apps.length ? { apps } : { apps, note: noAppsFound(query) };
}
