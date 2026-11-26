import { randomUUID } from "node:crypto";
import type { AppManifest, AppPermission } from "@rakazo/contracts";
import { appManifestSchema } from "@rakazo/contracts";
import { retry } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { readJsonColumn } from "@rakazo/db";
import type { AppBridgeRequest, AppState } from "@rakazo/plugin-sdk";
import { appBridgeAllows, applyAppAction } from "@rakazo/plugin-sdk";
import * as z from "zod";

/**
 * An app is a page whose current version carries a manifest. Its state lives on the page, so it
 * outlasts edits to the app's code, and only declared actions change it: a person's through the
 * viewer host and the pages API, a bot's through its tools, both through `runAppPageAction`.
 */
export type AppPage = {
  pageId: string;
  spaceId: string;
  /** The install whose state page this is; null for an app a bot saved. */
  appInstallId: string | null;
  title: string;
  manifest: AppManifest;
  state: AppState;
  revision: number;
};

const AppStateSchema = z.record(z.string(), z.json());

const appPageSelect = {
  id: true,
  spaceId: true,
  appInstallId: true,
  title: true,
  appState: true,
  appRevision: true,
  versions: {
    orderBy: { version: "desc" },
    take: 1,
    select: { id: true, app: true },
  },
} satisfies Prisma.PageSelect;

/**
 * The app on the page `where` finds, or null when there is no such page or it is a plain page.
 * `where` carries the caller's reach (owner, bot or chat), so another person's app reads as none.
 */
export async function readAppPage(
  prisma: PrismaClient,
  where: Prisma.PageWhereInput,
): Promise<AppPage | null> {
  const row = await prisma.page.findFirst({ where, select: appPageSelect });
  const version = row?.versions[0];
  if (!row || !version || version.app === null) return null;
  const manifest = readJsonColumn(
    appManifestSchema,
    version.app,
    { table: "page_versions", column: "app", id: version.id },
    "reject",
  );
  const state =
    row.appState === null
      ? manifest.initialState
      : readJsonColumn(
          AppStateSchema,
          row.appState,
          { table: "pages", column: "appState", id: row.id },
          "reject",
        );
  return {
    pageId: row.id,
    spaceId: row.spaceId,
    appInstallId: row.appInstallId,
    title: row.title,
    manifest,
    state,
    revision: row.appRevision,
  };
}

export type AppActionFailure = {
  ok: false;
  /** not_found: no app there; forbidden: the manifest does not allow it; invalid: bad input. */
  reason: "not_found" | "forbidden" | "invalid" | "conflict";
  error: string;
};

export type AppActionRun =
  | { ok: true; pageId: string; spaceId: string; state: AppState; revision: number }
  | AppActionFailure;

/**
 * The manifest with only the permissions an install granted as well: a bridge check on it passes
 * only what both the app and the person allow.
 */
export function withinGrant(manifest: AppManifest, granted: readonly AppPermission[]): AppManifest {
  return {
    ...manifest,
    permissions: manifest.permissions.filter((permission) => granted.includes(permission)),
  };
}

/** Another write landed between the read and the write; the action runs again on a fresh read. */
class RevisionMovedError extends Error {}

/** Tries in total before the caller is told to try again. */
const WRITE_ATTEMPTS = 3;

/**
 * Runs one declared action for a person or a bot. The bridge check comes first, from the stored
 * manifest narrowed to `granted` when an install's grant applies; the write is conditional on the
 * revision it read, so two runs never interleave and each one applies to the state it was
 * computed from.
 */
export async function runAppPageAction(
  prisma: PrismaClient,
  where: Prisma.PageWhereInput,
  request: { by: AppBridgeRequest["by"]; action: string; input: unknown },
  options: { newId?: () => string; granted?: readonly AppPermission[] } = {},
): Promise<AppActionRun> {
  const once = async (): Promise<AppActionRun> => {
    const app = await readAppPage(prisma, where);
    if (!app) return { ok: false, reason: "not_found", error: "No app with that pageId here." };
    const surface = options.granted ? withinGrant(app.manifest, options.granted) : app.manifest;
    const allowed = appBridgeAllows(surface, {
      by: request.by,
      kind: "action",
      action: request.action,
    });
    if (!allowed.ok) return { ok: false, reason: "forbidden", error: allowed.error };
    const outcome = applyAppAction(app.manifest, app.state, request.action, request.input, {
      newId: options.newId ?? (() => randomUUID().slice(0, 8)),
    });
    if (!outcome.ok) return { ok: false, reason: "invalid", error: outcome.error };
    const moved = await prisma.page.updateMany({
      where: { id: app.pageId, appRevision: app.revision },
      data: { appState: outcome.state, appRevision: app.revision + 1 },
    });
    if (moved.count !== 1) throw new RevisionMovedError();
    return {
      ok: true,
      pageId: app.pageId,
      spaceId: app.spaceId,
      state: outcome.state,
      revision: app.revision + 1,
    };
  };
  try {
    return await retry(once, {
      attempts: WRITE_ATTEMPTS,
      delayMs: 0,
      retryable: (error) => error instanceof RevisionMovedError,
    });
  } catch (error) {
    if (!(error instanceof RevisionMovedError)) throw error;
    return { ok: false, reason: "conflict", error: "The app changed at the same time; try again." };
  }
}

/**
 * What a bot reads of an app: its name, state and, when allowed, the actions it can run, after the
 * reference the bot used for it (`pageId` or `app_id`).
 */
export function appForAgent(
  app: Pick<AppPage, "manifest" | "state" | "revision">,
  ref: { pageId: string } | { app_id: string },
) {
  const read = appBridgeAllows(app.manifest, { by: "agent", kind: "read" });
  if (!read.ok) return { error: read.error };
  // Each action a bot may run here: read-only ones with agent:read, the rest with agent:actions.
  const actions = app.manifest.actions
    .filter(
      (action) =>
        appBridgeAllows(app.manifest, { by: "agent", kind: "action", action: action.name }).ok,
    )
    .map(({ name, description, input, readOnly }) => ({
      name,
      description,
      input,
      ...(readOnly ? { readOnly: true } : {}),
    }));
  const cards = app.manifest.cards ?? [];
  return {
    ...ref,
    app: app.manifest.name,
    version: app.manifest.version,
    ...(app.manifest.permissions.includes("state") || !app.manifest.server
      ? { state: app.state, revision: app.revision }
      : {}),
    ...(actions.length ? { actions } : {}),
    ...(cards.length
      ? {
          cards: cards.map(({ name, title, description, input }) => ({
            name,
            title,
            description,
            ...(input ? { input } : {}),
          })),
        }
      : {}),
  };
}
