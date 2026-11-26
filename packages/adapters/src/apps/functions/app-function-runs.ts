import type { AppAction, AppManifest, AppPermission } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { AppBridgeRequest } from "@rakazo/plugin-sdk";
import { appBridgeAllows, findAction, parseActionInput } from "@rakazo/plugin-sdk";
import type { ResolveHostname } from "../../network/network-address.js";
import { AppNetwork } from "../hosted/app-network.js";
import { AppRecords } from "../hosted/app-records.js";
import type { AppFunctionLimits, AppFunctionRuntime } from "./app-function-runtime.js";
import {
  APP_FUNCTION_LIMITS,
  AppFunctionCallError,
  appFunctionRuntime,
} from "./app-function-runtime.js";

/**
 * Runs one of an installed app's function-backed actions for the person or a bot. Everything it
 * can touch is bound here: the records of this install alone, the network hosts this install
 * granted, and nothing else. An action that changes records runs inside one transaction that
 * first takes this install's lock, so its writes land together or not at all and two runs of
 * the same install apply one after the other; a read-only action reads without one.
 */

export type InstalledFunctionApp = {
  installId: string;
  manifest: AppManifest;
  granted: readonly AppPermission[];
  /** The release's server file. */
  server: string | null;
};

export type AppFunctionDeps = {
  prisma: PrismaClient;
  runtime?: () => Promise<AppFunctionRuntime>;
  network?: { fetch?: typeof globalThis.fetch; resolveHostname?: ResolveHostname };
  limits?: Partial<AppFunctionLimits>;
  now?: () => Date;
};

export type AppFunctionRunResult =
  | { ok: true; result: unknown; changed: boolean }
  | { ok: false; reason: "forbidden" | "invalid" | "failed"; error: string };

/** Thrown inside the transaction so a failed run's writes roll back. */
class RunFailed extends Error {
  constructor(readonly outcome: { ok: false; error: string }) {
    super(outcome.error);
  }
}

/** Waits for the lock of one install's records, held until the transaction ends. */
const LOCK_WAIT_MS = 10_000;

function today(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The manifest narrowed to what the install granted: a check on it passes only what both allow. */
function granted(app: InstalledFunctionApp) {
  return app.manifest.permissions.filter((permission) => app.granted.includes(permission));
}

/** The function-backed action a request names, checked as the bridge checks it. */
export function functionAction(
  app: InstalledFunctionApp,
  request: { by: AppBridgeRequest["by"]; kind: "action" | "query"; action: string },
):
  | { ok: true; action: AppAction & { run: string } }
  | { ok: false; reason: "forbidden"; error: string } {
  const surface = { permissions: granted(app), actions: app.manifest.actions };
  const allowed = appBridgeAllows(
    surface,
    request.kind === "query"
      ? { by: "person", kind: "query", action: request.action }
      : ({ by: request.by, kind: "action", action: request.action } as AppBridgeRequest),
  );
  if (!allowed.ok) return { ok: false, reason: "forbidden", error: allowed.error };
  const action = findAction(app.manifest, request.action);
  if (!action?.run)
    return { ok: false, reason: "forbidden", error: `${request.action} does not run a function.` };
  return { ok: true, action: action as AppAction & { run: string } };
}

export async function runAppFunction(
  deps: AppFunctionDeps,
  scope: { spaceId: string; userId: string },
  app: InstalledFunctionApp,
  action: AppAction & { run: string },
  input: unknown,
  signal?: AbortSignal,
): Promise<AppFunctionRunResult> {
  const parsed = parseActionInput(action, input);
  if (!parsed.ok) return { ok: false, reason: "invalid", error: parsed.error };
  if (app.server === null)
    return { ok: false, reason: "failed", error: "This app's server file is missing." };
  const allowed = granted(app);
  const data = allowed.includes("data") ? app.manifest.data : undefined;
  const hosts = allowed.includes("network") ? (app.manifest.network?.hosts ?? []) : [];
  const readOnly = action.readOnly === true;
  const now = deps.now?.() ?? new Date();
  const person = await deps.prisma.user.findUnique({
    where: { id: scope.userId },
    select: { timezone: true },
  });
  const timeZone = person?.timezone || "UTC";
  const limits = { ...APP_FUNCTION_LIMITS, ...deps.limits };
  const runtime = await (deps.runtime ?? appFunctionRuntime)();
  const network = hosts.length
    ? new AppNetwork(hosts, { ...deps.network, signal, readOnly })
    : null;

  const run = async (db: Pick<PrismaClient, "appRecord">) => {
    const records = data
      ? new AppRecords(db, { installId: app.installId, spaceId: scope.spaceId }, data, { readOnly })
      : null;
    const outcome = await runtime.run({
      source: app.server!,
      file: app.manifest.server ?? "server.js",
      name: action.run,
      input: parsed.input,
      context: { now: now.toISOString(), today: today(now, timeZone), timeZone },
      capabilities: { db: records !== null, readOnly, fetch: network !== null },
      host: {
        call: (op, args) => {
          if (op === "fetch") {
            if (!network)
              return Promise.reject(new AppFunctionCallError("This app has no network access."));
            return network.fetch(args[0], args[1]);
          }
          if (!records)
            return Promise.reject(new AppFunctionCallError("This app keeps no records."));
          return records.call(op, args);
        },
      },
      limits,
      signal,
    });
    return { outcome, writes: records?.writes.count ?? 0 };
  };

  try {
    if (readOnly) {
      const { outcome } = await run(deps.prisma);
      return outcome.ok
        ? { ok: true, result: outcome.result, changed: false }
        : { ok: false, reason: "failed", error: outcome.error };
    }
    const { outcome, writes } = await deps.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`app-records:${app.installId}`}, 0))::text AS "lock"
        `;
        const ran = await run(tx);
        if (!ran.outcome.ok) throw new RunFailed(ran.outcome);
        return ran;
      },
      { maxWait: LOCK_WAIT_MS, timeout: LOCK_WAIT_MS + limits.wallMs + 5_000 },
    );
    return outcome.ok
      ? { ok: true, result: outcome.result, changed: writes > 0 }
      : { ok: false, reason: "failed", error: outcome.error };
  } catch (error) {
    if (error instanceof RunFailed) return { ok: false, reason: "failed", error: error.message };
    throw error;
  } finally {
    await network?.close();
  }
}
