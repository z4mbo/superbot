import { allowsE2ePluginEndpoint } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ClientError, escapeSearchWildcards } from "@rakazo/core";
import type { Prisma, RegistryPluginVersion } from "@rakazo/db";
import {
  addRegistryAppRecord,
  isUniqueViolation,
  JsonColumnMismatchError,
  listRegistryAppRecords,
  lockRegistryPluginInstallation,
  readRegistryPluginManifest,
  removeRegistryAppRecord,
  reportJsonColumnOnce,
  runAsSystem,
} from "@rakazo/db";
import { requireAdmin } from "../auth/admins.js";
import { assertMcpRemoteEndpoint } from "../integrations/mcp-servers.js";
import type { RouterContext } from "../routes/context.js";
import { lockOwner } from "../spaces/name-claims.js";

const versionDto = (row: RegistryPluginVersion) => ({
  id: row.id,
  slug: row.slug,
  version: row.version,
  manifest: readRegistryPluginManifest(row),
  status: row.status,
  reason: row.reason,
  createdAt: row.createdAt.toISOString(),
  reviewedAt: row.reviewedAt?.toISOString() ?? null,
});

const installInclude = {
  release: true,
  grants: {
    select: { botId: true, partId: true },
    orderBy: [{ botId: "asc" }, { partId: "asc" }],
  },
} satisfies Prisma.RegistryPluginInstallInclude;

const installDto = (
  row: Prisma.RegistryPluginInstallGetPayload<{ include: typeof installInclude }>,
) => ({
  id: row.id,
  plugin: versionDto(row.release),
  grants: row.grants,
  createdAt: row.createdAt.toISOString(),
});

const pageQuery = ({ after, limit }: { after?: string; limit: number }) => ({
  where: { id: after ? { gt: after } : undefined },
  orderBy: { id: "asc" as const },
  take: limit + 1,
});

function page<Row extends { id: string }, Item>(
  rows: Row[],
  limit: number,
  dto: (row: Row) => Item,
) {
  const items = rows.slice(0, limit).flatMap((row) => {
    try {
      return [dto(row)];
    } catch (error) {
      if (!(error instanceof JsonColumnMismatchError)) throw error;
      reportJsonColumnOnce(error.message, error.row);
      return [];
    }
  });
  return { items, nextAfter: rows.length > limit ? rows[limit - 1]!.id : null };
}

function lockInstalls(tx: Prisma.TransactionClient, actor: Actor) {
  return lockOwner(tx, JSON.stringify([actor.spaceId, actor.userId]), "registry-plugin-install");
}

export function pluginRegistryRoutes({ deps, authed }: RouterContext) {
  const { prisma } = deps;
  const rpc = authed.pluginRegistry;

  return {
    pluginRegistry: {
      submit: rpc.submit.handler(async ({ context: { actor }, input }) => {
        try {
          const release = await prisma.$transaction(async (tx) => {
            await lockOwner(tx, input.slug, "registry-plugin-publisher");
            const owned = await tx.registryPlugin.findFirst({
              where: { slug: input.slug, publisherId: actor.userId },
              select: { slug: true },
            });
            if (!owned) {
              await tx.registryPlugin.create({
                data: { slug: input.slug, publisherId: actor.userId },
              });
            }
            return tx.registryPluginVersion.create({ data: input });
          });
          return versionDto(release);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          throw new ClientError("CONFLICT", "Plugin slug or version is already reserved");
        }
      }),
      mine: rpc.mine.handler(async ({ context: { actor }, input }) => {
        const query = pageQuery(input);
        const rows = await prisma.registryPluginVersion.findMany({
          ...query,
          where: { ...query.where, plugin: { publisherId: actor.userId } },
        });
        return page(rows, input.limit, versionDto);
      }),
      submissions: rpc.submissions.handler(async ({ context: { actor }, input }) => {
        await requireAdmin(deps, actor.userId);
        const query = pageQuery(input);
        const rows = await runAsSystem("list registry submissions for a deployment admin", () =>
          prisma.registryPluginVersion.findMany({
            ...query,
            where: { ...query.where, status: input.status },
          }),
        );
        return page(rows, input.limit, versionDto);
      }),
      review: rpc.review.handler(async ({ context: { actor }, input }) => {
        await requireAdmin(deps, actor.userId);
        const release = await runAsSystem("read a registry submission for a deployment admin", () =>
          prisma.registryPluginVersion.findUnique({ where: { id: input.versionId } }),
        );
        if (!release) throw new ClientError("NOT_FOUND", "Plugin version not found");
        if (release.status !== "pending")
          throw new ClientError("CONFLICT", "Plugin version is already reviewed");
        if (input.decision === "approved") {
          const manifest = readRegistryPluginManifest(release);
          await Promise.all(
            manifest.parts.map((part) => {
              switch (part.kind) {
                case "mcp":
                  return assertMcpRemoteEndpoint(part.endpoint, {
                    remoteConnectors: deps.remoteConnectors,
                    env: {
                      ...deps.env,
                      mcpAllowPrivateEndpoint: allowsE2ePluginEndpoint(
                        part.endpoint,
                        deps.env.e2ePluginHosts,
                      ),
                    },
                  });
                case "skill":
                case "app":
                  return undefined;
              }
              return part satisfies never;
            }),
          );
        }

        return runAsSystem("save a deployment admin's registry review", async () => {
          const [decided] = await prisma.registryPluginVersion.updateManyAndReturn({
            where: { id: release.id, status: "pending" },
            data: {
              status: input.decision,
              reason: input.decision === "rejected" ? input.reason : null,
              reviewerId: actor.userId,
              reviewedAt: new Date(),
            },
          });
          if (!decided) throw new ClientError("CONFLICT", "Plugin version is already reviewed");
          return versionDto(decided);
        });
      }),
      discover: rpc.discover.handler(async ({ input }) => {
        const query = pageQuery(input);
        const text = input.query === undefined ? undefined : escapeSearchWildcards(input.query);
        const rows = await prisma.registryPluginVersion.findMany({
          ...query,
          where: {
            ...query.where,
            slug: input.slug,
            status: "approved",
            OR:
              text === undefined
                ? undefined
                : [
                    { slug: { contains: text, mode: "insensitive" } },
                    { manifest: { path: ["name"], string_contains: text, mode: "insensitive" } },
                    {
                      manifest: {
                        path: ["description"],
                        string_contains: text,
                        mode: "insensitive",
                      },
                    },
                  ],
          },
        });
        return page(rows, input.limit, versionDto);
      }),
      install: rpc.install.handler(({ context: { actor }, input }) =>
        prisma.$transaction(async (tx) => {
          const { spaceId, userId } = actor;
          await lockInstalls(tx, actor);
          const release = await tx.registryPluginVersion.findFirst({
            where: { id: input.versionId, status: "approved" },
          });
          if (!release) throw new ClientError("NOT_FOUND", "Approved plugin version not found");
          const scope = { spaceId, userId, slug: release.slug };
          const existing = await tx.registryPluginInstall.findUnique({
            where: { spaceId_userId_slug: scope },
            include: installInclude,
          });
          if (existing && existing.versionId !== release.id)
            throw new ClientError("CONFLICT", "A different version is already installed");
          const installed =
            existing ??
            (await tx.registryPluginInstall.create({
              data: { ...scope, versionId: release.id },
              include: installInclude,
            }));
          return installDto(installed);
        }),
      ),
      switchVersion: rpc.switchVersion.handler(({ context: { actor }, input }) =>
        prisma.$transaction(async (tx) => {
          const { spaceId, userId } = actor;
          await lockInstalls(tx, actor);
          await lockRegistryPluginInstallation(tx, actor, input.installationId);
          const scope = { id: input.installationId, spaceId, userId };
          const current = await tx.registryPluginInstall.findUnique({
            where: scope,
            include: installInclude,
          });
          if (!current) throw new ClientError("NOT_FOUND", "Plugin installation not found");
          if (current.versionId === input.versionId) return installDto(current);
          if (current.versionId !== input.expectedVersionId)
            throw new ClientError("CONFLICT", "The installed plugin version changed");
          const release = await tx.registryPluginVersion.findFirst({
            where: { id: input.versionId, slug: current.slug, status: "approved" },
            select: { id: true },
          });
          if (!release) throw new ClientError("NOT_FOUND", "Approved plugin version not found");
          await tx.registryPluginGrant.deleteMany({ where: { installationId: current.id } });
          return installDto(
            await tx.registryPluginInstall.update({
              where: { ...scope, versionId: input.expectedVersionId },
              data: { versionId: release.id },
              include: installInclude,
            }),
          );
        }),
      ),
      installations: rpc.installations.handler(async ({ context: { actor }, input }) => {
        const query = pageQuery(input);
        const rows = await prisma.registryPluginInstall.findMany({
          ...query,
          where: { ...query.where, spaceId: actor.spaceId, userId: actor.userId },
          include: installInclude,
        });
        return page(rows, input.limit, installDto);
      }),
      setGrants: rpc.setGrants.handler(({ context: { actor }, input }) =>
        prisma.$transaction(async (tx) => {
          const { spaceId, userId } = actor;
          await lockInstalls(tx, actor);
          await lockRegistryPluginInstallation(tx, actor, input.installationId);
          const installation = await tx.registryPluginInstall.findFirst({
            where: { id: input.installationId, spaceId, userId },
            include: { release: true },
          });
          if (!installation) throw new ClientError("NOT_FOUND", "Plugin installation not found");
          const bot = await tx.bot.findFirst({
            where: { id: input.botId, spaceId, userId, archivedAt: null },
            select: { id: true },
          });
          if (!bot) throw new ClientError("NOT_FOUND", "Bot not found in this Space");
          const parts = readRegistryPluginManifest(installation.release).parts;
          const partIds = [...new Set(input.partIds)];
          if (partIds.some((id) => !parts.some((part) => part.id === id)))
            throw new ClientError(
              "BAD_REQUEST",
              "The installed version does not contain every requested part",
            );

          const assignment = { installationId: installation.id, botId: bot.id };
          await tx.registryPluginGrant.deleteMany({
            where: { ...assignment, partId: { notIn: partIds } },
          });
          if (partIds.length) {
            await tx.registryPluginGrant.createMany({
              skipDuplicates: true,
              data: partIds.map((partId) => ({ ...assignment, partId })),
            });
          }
          return installDto(
            await tx.registryPluginInstall.findUniqueOrThrow({
              where: { id: installation.id },
              include: installInclude,
            }),
          );
        }),
      ),
      uninstall: rpc.uninstall.handler(async ({ context: { actor }, input }) => {
        await prisma.$transaction(async (tx) => {
          await lockInstalls(tx, actor);
          await tx.registryPluginInstall.deleteMany({
            where: { id: input.installationId, spaceId: actor.spaceId, userId: actor.userId },
          });
        });
        return { ok: true as const };
      }),
      appRecords: rpc.appRecords.handler(({ context: { actor }, input }) =>
        listRegistryAppRecords(prisma, actor, input),
      ),
      addAppRecord: rpc.addAppRecord.handler(({ context: { actor }, input }) =>
        addRegistryAppRecord(prisma, actor, input),
      ),
      removeAppRecord: rpc.removeAppRecord.handler(({ context: { actor }, input }) =>
        removeRegistryAppRecord(prisma, actor, input),
      ),
    },
  };
}
