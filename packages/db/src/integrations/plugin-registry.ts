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
  scope: { spaceId: string; userId: string; botId: string },
) {
  const rows = await runAsTenant(scope, () =>
    prisma.registryPluginGrant.findMany({
      where: {
        botId: scope.botId,
        bot: { spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
        installation: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          release: { status: "approved" },
        },
      },
      orderBy: [{ installationId: "asc" }, { partId: "asc" }],
      include: { installation: { include: { release: true } } },
    }),
  );

  return rows.flatMap(({ installation, partId, id: grantId }) => {
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
            versionId: installation.versionId,
            part,
          },
        ]
      : [];
  });
}
