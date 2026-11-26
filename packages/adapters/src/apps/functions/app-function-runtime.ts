/**
 * Runs an installed app's server functions in a sandbox. The engine is behind this interface so
 * it can be swapped; whichever runs them, a function sees only the `ctx` built here: its input,
 * the clock, and the platform calls (`ctx.db`, `ctx.fetch`) its install was granted, each of
 * which goes through `host.call`. It has no host globals, no timers, no module loading and no
 * network of its own, and it is stopped at the limits below.
 */

/** The bounds every run is held to. Defaults in APP_FUNCTION_LIMITS. */
export type AppFunctionLimits = {
  /** Memory the function's heap may take. */
  memoryBytes: number;
  /** Native stack the function's calls may take. */
  stackBytes: number;
  /** CPU time spent running the function's own code, summed across its awaits. */
  cpuMs: number;
  /** Time from start to answer, waits on the platform included. */
  wallMs: number;
  /** Platform calls (`ctx.db.*`, `ctx.fetch`) one run may make. */
  hostCalls: number;
  /** The input as JSON. */
  inputBytes: number;
  /** The answer as JSON. */
  resultBytes: number;
};

export const APP_FUNCTION_LIMITS: AppFunctionLimits = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  cpuMs: 1_000,
  wallMs: 10_000,
  hostCalls: 200,
  inputBytes: 16 * 1024,
  resultBytes: 64 * 1024,
};

/** What `ctx` offers besides its plain values: the platform calls this run may make. */
export type AppFunctionCapabilities = { db: boolean; readOnly: boolean; fetch: boolean };

/**
 * The platform side of a run. `call` answers one `ctx.db.*` or `ctx.fetch` call with JSON; a
 * thrown AppFunctionCallError becomes an error the function can catch, anything else fails the
 * run. Ops: db.insert, db.get, db.list, db.update, db.remove, fetch.
 */
export type AppFunctionHost = {
  call: (op: string, args: unknown[]) => Promise<unknown>;
};

/** A refusal the function's own code sees as an Error and may handle. */
export class AppFunctionCallError extends Error {}

export type AppFunctionRequest = {
  /** The app's server file, one JavaScript module. */
  source: string;
  /** Its path in the app folder, as messages name it. */
  file: string;
  /** The exported function to call. */
  name: string;
  /** The checked input, passed as the second argument and as `ctx.input`. */
  input: Record<string, unknown>;
  /** Plain values `ctx` carries: the time the run started, today in the person's zone, the zone. */
  context: { now: string; today: string; timeZone: string };
  capabilities: AppFunctionCapabilities;
  host: AppFunctionHost;
  limits?: Partial<AppFunctionLimits>;
  signal?: AbortSignal;
};

export type AppFunctionOutcome = { ok: true; result: unknown } | { ok: false; error: string };

export interface AppFunctionRuntime {
  /** Calls one exported function and returns its JSON answer, or why it failed. */
  run(request: AppFunctionRequest): Promise<AppFunctionOutcome>;
  /**
   * Loads the module the way a run does, without calling anything, and lists the exported names
   * that are functions. A module that fails to load (or loops while loading) is an error.
   */
  functions(
    source: string,
    file: string,
  ): Promise<{ ok: true; names: string[] } | { ok: false; error: string }>;
}

let engine: Promise<AppFunctionRuntime> | undefined;

/**
 * The sandbox engine, loaded the first time an app function runs: a deployment whose people run
 * no app functions never loads it.
 */
export function appFunctionRuntime(): Promise<AppFunctionRuntime> {
  engine ??= import("../../providers/app-functions/quickjs/quickjs-app-functions.js").then(
    ({ createQuickJsAppFunctions }) => createQuickJsAppFunctions(),
  );
  return engine;
}

/** UTF-8 bytes of a value as JSON; undefined counts as null. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
}
