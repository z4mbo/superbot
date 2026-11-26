import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { settingsDirectory } from "@rakazo/cli-client";
import { deadlineSignal } from "@rakazo/core";
import type { CliContext } from "../session/context.js";
import { installMethod, updateCommand } from "./install-method.js";
import { CLI_VERSION, isNewer, isVersion, PACKAGE_NAME } from "./version.js";

/** What the update check reads from its surroundings; tests pass their own. */
export type UpdateEnvironment = {
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Where this copy of the command lives, which tells how it was installed. */
  scriptPath?: string;
  /** The running version; the package's own unless a test sets another. */
  version?: string;
  /** Starts the background check; a separate process unless a test runs it in place. */
  spawnCheck?: () => void;
};

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How long a check waits for the registry; nothing waits for the background one. */
export const CHECK_TIMEOUT_MS = 5000;

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const CACHE_FILE = "update-check.json";

export type LatestRelease =
  | { kind: "found"; version: string }
  /** The registry has no release of the command. */
  | { kind: "unpublished" }
  /** The registry did not answer in time, or answered with something unreadable. */
  | { kind: "unreachable" };

type Cache = { checkedAt: number; latest?: string };

export function resolved(context: CliContext) {
  const updates = context.updates ?? {};
  return {
    env: context.settings.env ?? process.env,
    fetch: updates.fetch ?? globalThis.fetch,
    now: updates.now ?? Date.now,
    scriptPath: updates.scriptPath ?? fileURLToPath(import.meta.url),
    version: updates.version ?? CLI_VERSION,
    spawnCheck: updates.spawnCheck ?? spawnCheck,
  };
}

/** The registry npm itself uses here: the one npm passes to commands it runs, else npm's own. */
export function registryUrl(env: Record<string, string | undefined>): URL {
  const configured = env.npm_config_registry;
  if (configured) {
    try {
      const url = new URL(configured.endsWith("/") ? configured : `${configured}/`);
      if (url.protocol === "https:" || url.protocol === "http:") return url;
    } catch {
      // Not a URL; npm's own registry it is.
    }
  }
  return new URL(DEFAULT_REGISTRY);
}

/** Asks the registry for the version its `latest` tag points at. Never throws. */
export async function latestRelease(
  context: CliContext,
  timeoutMs: number,
): Promise<LatestRelease> {
  const { env, fetch } = resolved(context);
  try {
    const response = await fetch(new URL(`${PACKAGE_NAME}/latest`, registryUrl(env)), {
      headers: { accept: "application/json" },
      signal: deadlineSignal(timeoutMs),
    });
    if (response.status === 404) return { kind: "unpublished" };
    if (!response.ok) return { kind: "unreachable" };
    const body: unknown = await response.json();
    const version =
      typeof body === "object" && body !== null && "version" in body ? body.version : undefined;
    return typeof version === "string" && isVersion(version)
      ? { kind: "found", version }
      : { kind: "unreachable" };
  } catch {
    // Offline, refused, timed out or not JSON: the check is only a courtesy.
    return { kind: "unreachable" };
  }
}

function cacheFile(context: CliContext): string | undefined {
  const directory = settingsDirectory(context.settings);
  return directory && path.join(directory, CACHE_FILE);
}

/** The last check's result; an absent or unreadable file reads as never checked. */
export async function readCache(context: CliContext): Promise<Cache | undefined> {
  const file = cacheFile(context);
  if (!file) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { checkedAt, latest } = parsed as Record<string, unknown>;
    if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return undefined;
    return typeof latest === "string" && isVersion(latest) ? { checkedAt, latest } : { checkedAt };
  } catch {
    return undefined;
  }
}

/** Saves a check's result; false when the settings folder cannot be written. */
async function writeCache(context: CliContext, cache: Cache): Promise<boolean> {
  const file = cacheFile(context);
  if (!file) return false;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(cache)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Records an answer from the registry. A failed check keeps the release the last one found, so
 * the notice stays until a check says otherwise.
 */
export async function recordCheck(
  context: CliContext,
  result: LatestRelease,
  previous: Cache | undefined,
): Promise<boolean> {
  const latest =
    result.kind === "found"
      ? result.version
      : result.kind === "unreachable"
        ? previous?.latest
        : undefined;
  return writeCache(context, { checkedAt: resolved(context).now(), ...(latest ? { latest } : {}) });
}

/** The hidden argument that makes the command run only the background check, then exit. */
export const UPDATE_CHECK_ARGUMENT = "__update-check";

/** What the background process does: ask the registry and record the answer. */
export async function refreshUpdateCache(context: CliContext): Promise<void> {
  const previous = await readCache(context);
  await recordCheck(context, await latestRelease(context, CHECK_TIMEOUT_MS), previous);
}

/**
 * Starts the check in a process of its own that outlives this one, so no command waits for the
 * registry or loses the answer by finishing first. It prints nothing and nothing waits for it.
 */
function spawnCheck(): void {
  const script = process.argv[1];
  if (!script) return;
  const child = spawn(process.execPath, [script, UPDATE_CHECK_ARGUMENT], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    // Could not start a process: the next day's command tries again.
  });
  child.unref();
}

function fresh(cache: Cache | undefined, now: number): cache is Cache {
  return cache !== undefined && cache.checkedAt <= now && now - cache.checkedAt < CHECK_INTERVAL_MS;
}

const truthy = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

/**
 * Whether a command may check for updates and mention one: only for a person at a terminal,
 * never in CI, for JSON output, a source checkout, or when they turned update notices off the
 * way other command-line tools honor (`NO_UPDATE_NOTIFIER`, or npm's `update-notifier=false`).
 */
export function noticeAllowed(context: CliContext, json: boolean): boolean {
  const { env, scriptPath } = resolved(context);
  if (json || !context.io.stdoutIsTerminal || !context.io.stderrIsTerminal) return false;
  if (truthy(env.CI) || truthy(env.NO_UPDATE_NOTIFIER)) return false;
  if (env.npm_config_update_notifier?.toLowerCase() === "false") return false;
  return installMethod(scriptPath) !== "source";
}

/** The one line that says a newer release exists and how to get it. */
export function noticeLine(latest: string, current: string, command: string): string {
  return `superbot-cli ${latest} is available (you have ${current}). Update with: ${command}`;
}

export type BackgroundCheck = {
  /** Prints the notice to standard error when a newer release is known. Never waits on the network. */
  finish(): Promise<void>;
};

/**
 * Shows the newest release the last check found once the command ends, and when that check is
 * over a day old starts the next one in the background. The attempt is dated before it starts,
 * so commands run meanwhile, or after it fails, do not start more.
 */
export function startBackgroundCheck(
  context: CliContext,
  json: boolean,
): BackgroundCheck | undefined {
  if (!noticeAllowed(context, json)) return undefined;
  const { now, scriptPath, version, spawnCheck: start } = resolved(context);
  const command = updateCommand(installMethod(scriptPath));
  if (!command) return undefined;
  const cached = readCache(context).then(async (cache) => {
    if (!fresh(cache, now()) && (await recordCheck(context, { kind: "unreachable" }, cache))) {
      start();
    }
    return cache;
  });
  return {
    async finish() {
      const latest = (await cached)?.latest;
      if (latest && isNewer(latest, version)) {
        context.io.err(`${noticeLine(latest, version, command)}\n`);
      }
    },
  };
}
