import type { TransactionalEmail } from "@rakazo/adapter-kit";
import {
  APP_INSTALL_KIND,
  AppChangedError,
  appInstallSource,
  appReleaseDigest,
  checkAppBundle,
  grantWithin,
} from "@rakazo/adapters";
import { pluginSubmissionAdminEmail } from "@rakazo/auth";
import type {
  Actor,
  AppInstall,
  AppListing,
  AppManifest,
  AppSubmissionInput,
} from "@rakazo/contracts";
import { appManifestSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  availableInSpace,
  isUniqueViolation,
  JsonColumnMismatchError,
  readJsonColumn,
  reportJsonColumnOnce,
} from "@rakazo/db";
import { checkPageSource } from "@rakazo/page-kit/validate";
import { lockOwner } from "../spaces/name-claims.js";

/** Versions one author may have waiting for review at once. */
const PENDING_PER_AUTHOR = 10;
const CATALOG_LIMIT = 500;
const APPROVED = { submissions: { some: { status: "approved" } } } as const;

export class AppBundleError extends ClientError {
  constructor(readonly problems: string[]) {
    super("BAD_REQUEST", problems.join("\n"), "APP_INVALID");
  }
}

function manifestOf(release: { id: string; manifest: unknown }): AppManifest {
  return readJsonColumn(
    appManifestSchema,
    release.manifest,
    { table: "app_releases", column: "manifest", id: release.id },
    "reject",
  );
}

/**
 * Takes an app version for review. Everything is checked here, whatever the client checked: the
 * manifest, the folder's paths, the entry through the page kit and the icon's bytes. The first
 * author to publish an id keeps it; a version is published once.
 */
export async function submitApp(
  deps: {
    prisma: PrismaClient;
    adminEmails?: readonly string[];
    webOrigin?: string;
    sendEmail?: (message: Promise<TransactionalEmail>) => void;
  },
  actor: Actor,
  input: AppSubmissionInput,
) {
  const checked = checkAppBundle(input);
  if (!checked.ok) throw new AppBundleError(checked.errors);
  const { manifest, source, code, icon, digest } = checked.bundle;
  const author = await deps.prisma.user.findUniqueOrThrow({
    where: { id: actor.userId },
    select: { email: true },
  });
  try {
    const submission = await deps.prisma.$transaction(async (tx) => {
      await lockOwner(tx, manifest.id, "app-id");
      const owned = await tx.appRelease.findFirst({
        where: { appId: manifest.id, authorUserId: { not: actor.userId } },
        select: { id: true },
      });
      if (owned)
        throw new ClientError(
          "CONFLICT",
          "Another author publishes an app with this id. Choose another id.",
          "APP_ID_TAKEN",
        );
      const waiting = await tx.pluginSubmission.count({
        where: { status: "pending", appRelease: { authorUserId: actor.userId } },
      });
      if (waiting >= PENDING_PER_AUTHOR)
        throw new ClientError(
          "TOO_MANY_REQUESTS",
          "Wait for your apps in review before sending more.",
          "APP_REVIEW_QUEUE_FULL",
        );
      const release = await tx.appRelease.create({
        data: {
          appId: manifest.id,
          version: manifest.version,
          authorUserId: actor.userId,
          name: manifest.name,
          description: manifest.description,
          manifest: manifest as Prisma.InputJsonValue,
          source,
          code,
          icon,
          digest,
        },
      });
      return tx.pluginSubmission.create({
        data: {
          email: author.email.toLowerCase(),
          name: manifest.name,
          description: manifest.description,
          appReleaseId: release.id,
        },
      });
    });
    if (deps.sendEmail && deps.webOrigin) {
      const reviewUrl = new URL("/admin/plugins", deps.webOrigin).href;
      for (const admin of deps.adminEmails ?? [])
        deps.sendEmail(pluginSubmissionAdminEmail(admin, submission, reviewUrl));
    }
    return {
      submissionId: submission.id,
      releaseId: submission.appReleaseId!,
      status: "pending" as const,
    };
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ClientError(
        "CONFLICT",
        `Version ${manifest.version} is already published. Raise the version.`,
        "APP_VERSION_EXISTS",
      );
    throw error;
  }
}

/**
 * Checks an app version again when an admin approves it, from what is stored: a row edited since
 * it was published, or a page-kit change that no longer accepts the source, is not listed.
 */
export async function assertAppReleaseListable(prisma: PrismaClient, releaseId: string) {
  const release = await prisma.appRelease.findUniqueOrThrow({ where: { id: releaseId } });
  try {
    manifestOf(release);
  } catch (error) {
    if (!(error instanceof JsonColumnMismatchError)) throw error;
    throw new AppChangedError();
  }
  if (appReleaseDigest(release) !== release.digest) throw new AppChangedError();
  const check = checkPageSource(release.source);
  if (!check.ok) throw new AppBundleError(check.errors);
}

function matches(listing: AppListing, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return (
    !needle ||
    [listing.name, listing.description, listing.appId].some((text) =>
      text.toLowerCase().includes(needle),
    )
  );
}

/** Approved apps, the newest approved version of each, matching the query. */
export async function appCatalog(prisma: PrismaClient, query: string): Promise<AppListing[]> {
  const rows = await prisma.appRelease.findMany({
    where: APPROVED,
    orderBy: { createdAt: "desc" },
    take: CATALOG_LIMIT,
    select: {
      id: true,
      appId: true,
      version: true,
      name: true,
      description: true,
      icon: true,
      manifest: true,
      digest: true,
    },
  });
  const listed = new Set<string>();
  const listings: AppListing[] = [];
  for (const row of rows) {
    if (listed.has(row.appId)) continue;
    let manifest: AppManifest;
    try {
      manifest = manifestOf(row);
    } catch (error) {
      if (!(error instanceof JsonColumnMismatchError)) throw error;
      reportJsonColumnOnce("App version left out of the catalog", error.row);
      continue;
    }
    listed.add(row.appId);
    const listing = {
      releaseId: row.id,
      appId: row.appId,
      name: row.name,
      description: row.description,
      version: row.version,
      icon: row.icon,
      permissions: manifest.permissions,
      digest: row.digest,
    };
    if (matches(listing, query)) listings.push(listing);
  }
  return listings.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Installs an approved app version in the actor's Space. The person consents to the version they
 * were shown (its digest) and to every permission it asks for; a grant beyond what the manifest
 * asks for, or short of it, is refused, and what was granted is recorded with the install.
 */
export async function installApp(
  prisma: PrismaClient,
  actor: Actor,
  input: { releaseId: string; digest: string; grant: readonly string[] },
): Promise<AppInstall> {
  const release = await prisma.appRelease.findFirst({
    where: { id: input.releaseId, ...APPROVED },
  });
  if (!release) throw new ClientError("NOT_FOUND", "App not found", "APP_NOT_FOUND");
  if (release.digest !== input.digest) throw new AppChangedError();
  let manifest: AppManifest;
  try {
    manifest = manifestOf(release);
  } catch (error) {
    if (!(error instanceof JsonColumnMismatchError)) throw error;
    throw new AppChangedError();
  }
  if (appReleaseDigest(release) !== release.digest) throw new AppChangedError();
  const grant = input.grant as AppManifest["permissions"];
  if (!grantWithin(grant, manifest.permissions))
    throw new ClientError(
      "BAD_REQUEST",
      "Allow only the permissions this app asks for.",
      "APP_GRANT_EXCEEDS_REQUEST",
    );
  if (!grantWithin(manifest.permissions, grant))
    throw new ClientError(
      "BAD_REQUEST",
      "Allow every permission this app asks for to install it.",
      "APP_GRANT_INCOMPLETE",
    );
  const row = await prisma.$transaction(async (tx) => {
    await lockOwner(tx, actor.userId, "app-install");
    const installed = await tx.capabilityInstall.findFirst({
      where: {
        ...availableInSpace(actor),
        kind: APP_INSTALL_KIND,
        source: appInstallSource(manifest.id),
      },
      select: { id: true },
    });
    if (installed)
      throw new ClientError("CONFLICT", "This app is already installed", "APP_INSTALLED");
    return tx.capabilityInstall.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        kind: APP_INSTALL_KIND,
        name: manifest.name,
        source: appInstallSource(manifest.id),
        version: manifest.version,
        digest: release.digest,
        // In the manifest's order, each once, as the person was shown them.
        config: { releaseId: release.id, appId: manifest.id, granted: [...manifest.permissions] },
      },
    });
  });
  return {
    id: row.id,
    releaseId: release.id,
    appId: manifest.id,
    name: release.name,
    description: release.description,
    version: manifest.version,
    icon: release.icon,
    granted: [...manifest.permissions],
    createdAt: row.createdAt.toISOString(),
  };
}

/** Removes an app from the actor's Space; removing one that is already gone succeeds. */
export async function uninstallApp(prisma: PrismaClient, actor: Actor, id: string) {
  await prisma.capabilityInstall.deleteMany({
    where: { ...availableInSpace(actor), id, kind: APP_INSTALL_KIND },
  });
  return { ok: true as const };
}
