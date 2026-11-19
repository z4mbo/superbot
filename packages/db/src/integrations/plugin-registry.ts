import { RegistryPluginManifestSchema } from "@rakazo/contracts";
import {
  JsonColumnMismatchError,
  readJsonColumn,
  reportJsonColumnOnce,
} from "../database/json-column.js";
import { runAsTenant } from "../database/row-security.js";
import type { PrismaClient, RegistryPluginVersion } from "../generated/prisma/client.js";

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
      ? [{ grantId, installationId: installation.id, versionId: installation.versionId, part }]
      : [];
  });
}
