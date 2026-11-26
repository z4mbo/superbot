import type { AppInstall, AppLaunch, AppManifest, AppPermission } from "@rakazo/contracts";
import { appManifestSchema, appPermissionSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  availableInSpace,
  JsonColumnMismatchError,
  readJsonColumn,
  reportJsonColumnOnce,
} from "@rakazo/db";
import { z } from "zod";
import { appReleaseDigest } from "./app-bundle.js";

/** `capability_installs.kind` of an installed app. */
export const APP_INSTALL_KIND = "app";

/** `capability_installs.source` of an installed app: one install per app id in a Space. */
export const appInstallSource = (appId: string) => `app:${appId}`;

/** What an app install records beside its pinned version: the permissions the person allowed. */
export const AppInstallConfigSchema = z.object({
  releaseId: z.string(),
  appId: z.string(),
  granted: z.array(appPermissionSchema),
});
export type AppInstallConfig = z.infer<typeof AppInstallConfigSchema>;

type Scope = { spaceId: string; userId: string };

/** The stored app no longer matches what was installed and consented to, so it does not run. */
export class AppChangedError extends ClientError {
  constructor() {
    super(
      "CONFLICT",
      "This app changed since it was installed. Remove it and install it again.",
      "APP_CHANGED",
    );
  }
}

export class AppNotInstalledError extends ClientError {
  constructor() {
    super("NOT_FOUND", "This app is not installed here.", "APP_NOT_INSTALLED");
  }
}

function installConfig(row: { id: string; config: unknown }): AppInstallConfig {
  return readJsonColumn(
    AppInstallConfigSchema,
    row.config,
    { table: "capability_installs", column: "config", id: row.id },
    "reject",
  );
}

function releaseManifest(row: { id: string; manifest: unknown }): AppManifest {
  return readJsonColumn(
    appManifestSchema,
    row.manifest,
    { table: "app_releases", column: "manifest", id: row.id },
    "reject",
  );
}

/** What an app reaches beyond its page, as the consent screen and the installed app name it. */
export function appAccess(manifest: Pick<AppManifest, "network" | "data" | "server">) {
  return {
    hosts: [...(manifest.network?.hosts ?? [])],
    collections: Object.keys(manifest.data?.collections ?? {}),
    server: manifest.server !== undefined,
  };
}

/** Whether everything in `granted` is something `requested` asks for. */
export function grantWithin(
  granted: readonly AppPermission[],
  requested: readonly AppPermission[],
): boolean {
  return granted.every((permission) => requested.includes(permission));
}

/**
 * The apps installed for this person in this Space, each read through its schema. A row that no
 * longer reads is left out and reported, never guessed at.
 */
export async function listInstalledApps(prisma: PrismaClient, scope: Scope): Promise<AppInstall[]> {
  const rows = await prisma.capabilityInstall.findMany({
    where: { ...availableInSpace(scope), kind: APP_INSTALL_KIND },
    orderBy: { createdAt: "asc" },
  });
  const installs: Array<{ row: (typeof rows)[number]; config: AppInstallConfig }> = [];
  for (const row of rows) {
    try {
      installs.push({ row, config: installConfig(row) });
    } catch (error) {
      if (!(error instanceof JsonColumnMismatchError)) throw error;
      reportJsonColumnOnce("App install left out of the list", error.row);
    }
  }
  const releases = await prisma.appRelease.findMany({
    where: { id: { in: installs.map(({ config }) => config.releaseId) } },
    select: { id: true, name: true, description: true, icon: true, manifest: true },
  });
  const byId = new Map(releases.map((release) => [release.id, release]));
  return installs.flatMap(({ row, config }) => {
    const release = byId.get(config.releaseId);
    if (!release) return [];
    let manifest: AppManifest;
    try {
      manifest = releaseManifest(release);
    } catch (error) {
      if (!(error instanceof JsonColumnMismatchError)) throw error;
      reportJsonColumnOnce("App install left out of the list", error.row);
      return [];
    }
    return [
      {
        id: row.id,
        releaseId: release.id,
        appId: config.appId,
        name: release.name,
        description: release.description,
        version: row.version ?? "",
        icon: release.icon,
        granted: config.granted,
        createdAt: row.createdAt.toISOString(),
        ...appAccess(manifest),
      },
    ];
  });
}

/**
 * The installed app to run, refused unless it is still exactly the version that was installed:
 * the stored manifest, source, compiled code and icon must hash to the digest the install pinned,
 * and the recorded grant must be within what that manifest asks for. The viewer and bridge get
 * only `granted`; everything else an app might ask for is refused by default. The manifest and
 * source are for the server; the viewer is sent only the launch.
 */
export async function readAppLaunch(
  prisma: PrismaClient,
  scope: Scope,
  installId: string,
): Promise<AppLaunch & { manifest: AppManifest; source: string; server: string | null }> {
  const install = await prisma.capabilityInstall.findFirst({
    where: { ...availableInSpace(scope), id: installId, kind: APP_INSTALL_KIND },
  });
  if (!install?.digest) throw new AppNotInstalledError();
  let config: AppInstallConfig;
  try {
    config = installConfig(install);
  } catch (error) {
    if (!(error instanceof JsonColumnMismatchError)) throw error;
    throw new AppChangedError();
  }
  const release = await prisma.appRelease.findUnique({ where: { id: config.releaseId } });
  if (!release) throw new AppNotInstalledError();
  let manifest: AppManifest;
  try {
    manifest = releaseManifest(release);
  } catch (error) {
    if (!(error instanceof JsonColumnMismatchError)) throw error;
    throw new AppChangedError();
  }
  if (
    release.digest !== install.digest ||
    appReleaseDigest(release) !== install.digest ||
    manifest.id !== config.appId ||
    !grantWithin(config.granted, manifest.permissions)
  )
    throw new AppChangedError();
  return {
    installId: install.id,
    appId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    code: release.code,
    granted: config.granted,
    manifest,
    source: release.source,
    server: release.server,
  };
}
