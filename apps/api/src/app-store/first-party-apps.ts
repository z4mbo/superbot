import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckedAppBundle } from "@rakazo/adapters";
import { appServerProblems, checkAppBundle } from "@rakazo/adapters";
import type { AppFile } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { readAppFolder } from "@rakazo/plugin-sdk/node";

/**
 * Apps the deployment ships and lists in the Store without a submission, each an app folder in
 * the repository's `examples`. A version is stored the first time the catalog is read after a
 * release that carries it; installs pin a version, so a changed folder must raise its version.
 */
export const FIRST_PARTY_APPS = ["food-diary"] as const;

/** The repository's `examples` folder, found from this file in source and in the built server. */
function examplesFolder(): string | null {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      const examples = path.join(dir, "examples");
      return existsSync(examples) ? examples : null;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** A first-party app folder checked exactly as a submitted app is. */
export async function firstPartyBundle(
  folder: string,
): Promise<{ ok: true; bundle: CheckedAppBundle } | { ok: false; errors: string[] }> {
  const read = await readAppFolder(folder);
  if (!read.ok) return read;
  const { manifest, files: folderFiles } = read;
  const files: AppFile[] = [
    { path: manifest.entry, content: folderFiles.source, encoding: "utf8" },
  ];
  if (manifest.server && folderFiles.server !== undefined)
    files.push({ path: manifest.server, content: folderFiles.server, encoding: "utf8" });
  if (manifest.icon && folderFiles.icon)
    files.push({
      path: manifest.icon,
      content: folderFiles.icon.toString("base64"),
      encoding: "base64",
    });
  const checked = checkAppBundle({ manifest: JSON.parse(folderFiles.manifestText), files });
  if (!checked.ok) return checked;
  const problems = await appServerProblems(checked.bundle.manifest, checked.bundle.server);
  return problems.length ? { ok: false, errors: problems } : checked;
}

async function storeFirstPartyApp(prisma: PrismaClient, bundle: CheckedAppBundle) {
  const { manifest } = bundle;
  const stored = await prisma.appRelease.findUnique({
    where: { appId_version: { appId: manifest.id, version: manifest.version } },
    select: { digest: true, firstParty: true },
  });
  if (stored) {
    if (!stored.firstParty || stored.digest !== bundle.digest)
      getLogger().warn("first-party app version already stored with other contents", {
        appId: manifest.id,
        version: manifest.version,
      });
    return;
  }
  try {
    await prisma.appRelease.create({
      data: {
        appId: manifest.id,
        version: manifest.version,
        firstParty: true,
        name: manifest.name,
        description: manifest.description,
        manifest: manifest as Prisma.InputJsonValue,
        source: bundle.source,
        code: bundle.code,
        server: bundle.server,
        icon: bundle.icon,
        digest: bundle.digest,
      },
    });
  } catch (error) {
    // Another server process stored it first.
    if (!isUniqueViolation(error)) throw error;
  }
}

async function storeFirstPartyApps(prisma: PrismaClient) {
  const examples = examplesFolder();
  if (!examples) {
    getLogger().warn("first-party apps not found; the Store lists only submitted apps");
    return;
  }
  for (const id of FIRST_PARTY_APPS) {
    const checked = await firstPartyBundle(path.join(examples, id));
    if (!checked.ok) {
      getLogger().error("first-party app failed its check", { appId: id, errors: checked.errors });
      continue;
    }
    await storeFirstPartyApp(prisma, checked.bundle);
  }
}

let stored: Promise<void> | undefined;

/** Stores the first-party apps once per process; a failure is tried again on the next read. */
export function ensureFirstPartyApps(prisma: PrismaClient): Promise<void> {
  stored ??= storeFirstPartyApps(prisma).catch((error: unknown) => {
    stored = undefined;
    throw error;
  });
  return stored;
}
