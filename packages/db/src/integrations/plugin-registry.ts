import { RegistryPluginManifestSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import {
  JsonColumnMismatchError,
  readJsonColumn,
  reportJsonColumnOnce,
} from "../database/json-column.js";
import { runAsTenant } from "../database/row-security.js";
import type { Prisma, PrismaClient, RegistryPluginVersion } from "../generated/prisma/client.js";

type InstallationScope = { spaceId: string; userId: string };
type BotScope = InstallationScope & { botId: string };
type GrantQuery = { id?: string; installationId?: string; partId?: string };

const includeInstallationRelease = { installation: { include: { release: true } } } as const;

function botGrantWhere(scope: BotScope): Prisma.RegistryPluginGrantWhereInput {
  return {
    botId: scope.botId,
    bot: { spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
    installation: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      release: { status: "approved" },
    },
  };
}

/** Locks the owned installation through any grant, pin or app record changes. */
export async function lockRegistryPluginInstallation(
  tx: Prisma.TransactionClient,
  scope: InstallationScope,
  installationId: string,
) {
  const [row] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "registry_plugin_installs"
    WHERE "id" = ${installationId} AND "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId}
    FOR UPDATE`;
  if (!row) throw new ClientError("NOT_FOUND", "Plugin installation not found");
}

export function readRegistryPluginManifest(row: Pick<RegistryPluginVersion, "id" | "manifest">) {
  return readJsonColumn(
    RegistryPluginManifestSchema,
    row.manifest,
    { table: "registry_plugin_versions", column: "manifest", id: row.id },
    "reject",
  );
}

/** Resolves approved capabilities for the running bot's authoritative Space and owner. */
export async function resolvePluginGrants(
  prisma: PrismaClient,
  scope: BotScope,
  target?: GrantQuery,
) {
  const rows = await runAsTenant(scope, () =>
    prisma.registryPluginGrant.findMany({
      where: {
        ...botGrantWhere(scope),
        id: target?.id,
        installationId: target?.installationId,
        partId: target?.partId,
      },
      orderBy: [{ installationId: "asc" }, { partId: "asc" }],
      include: includeInstallationRelease,
    }),
  );
  return rows.flatMap(resolveGrant);
}

/** Pages raw grants so callers can filter by capability without loading every manifest. */
export async function resolvePluginGrantPage(
  prisma: PrismaClient,
  scope: BotScope,
  limit: number,
  after?: string,
) {
  const rows = await runAsTenant(scope, () =>
    prisma.registryPluginGrant.findMany({
      where: { ...botGrantWhere(scope), id: after === undefined ? undefined : { gt: after } },
      orderBy: { id: "asc" },
      take: limit + 1,
      include: includeInstallationRelease,
    }),
  );
  const nextAfter = rows.length > limit ? rows[limit - 1]!.id : null;
  return { grants: rows.slice(0, limit).flatMap(resolveGrant), nextAfter };
}

function resolveGrant({
  installation,
  partId,
  id: grantId,
}: Prisma.RegistryPluginGrantGetPayload<{ include: typeof includeInstallationRelease }>) {
  let manifest: ReturnType<typeof readRegistryPluginManifest>;
  try {
    manifest = readRegistryPluginManifest(installation.release);
  } catch (error) {
    if (!(error instanceof JsonColumnMismatchError)) throw error;
    reportJsonColumnOnce(error.message, error.row);
    return [];
  }
  const part = manifest.parts.find((entry) => entry.id === partId);
  return part
    ? [
        {
          grantId,
          installationId: installation.id,
          pluginSlug: installation.slug,
          pluginName: manifest.name,
          versionId: installation.versionId,
          part,
        },
      ]
    : [];
}
