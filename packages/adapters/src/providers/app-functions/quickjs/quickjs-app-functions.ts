import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from "quickjs-emscripten";
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from "quickjs-emscripten";
import type {
  AppFunctionLimits,
  AppFunctionOutcome,
  AppFunctionRequest,
  AppFunctionRuntime,
} from "../../../apps/functions/app-function-runtime.js";
import {
  APP_FUNCTION_LIMITS,
  AppFunctionCallError,
  jsonBytes,
} from "../../../apps/functions/app-function-runtime.js";

/**
 * App server functions in QuickJS compiled to WebAssembly. Each run gets an engine instance of
 * its own, in WebAssembly memory capped at its memory limit (QuickJS's own allocation count
 * misses buffers that grow, so the cap is the memory itself), with a stack limit and an
 * interrupt handler for its CPU and wall-clock deadlines. The function's world is what the
 * bootstrap below defines: a frozen `ctx` whose platform calls go out as JSON through one host
 * function, and a console that prints nothing. QuickJS has no file, network, process, timer or
 * module access unless the embedder adds it, and nothing else is added here.
 */

const PAGE = 64 * 1024;
/** What the engine itself takes before the app allocates anything: its code, data and stack. */
const ENGINE_BYTES = 16 * 1024 * 1024;

/** A fresh engine in memory that cannot grow past the run's limit. */
function engineModule(limits: AppFunctionLimits): Promise<QuickJSWASMModule> {
  const wasmMemory = new WebAssembly.Memory({
    initial: ENGINE_BYTES / PAGE,
    maximum: Math.ceil((ENGINE_BYTES + limits.memoryBytes) / PAGE),
  });
  return newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory }));
}

const HOST = "__superbotHost";
const MAKE_CTX = "__superbotContext";
const TO_JSON = "__superbotJson";
const FUNCTIONS = "__superbotFunctions";

// Runs once per runtime, before the app's module. It keeps the host function in a closure and
// removes it from the global scope, so the app reaches the platform only through `ctx`.
const BOOTSTRAP = `(() => {
  const host = globalThis.${HOST};
  delete globalThis.${HOST};
  const call = (op, args) =>
    host(op, JSON.stringify(args)).then((text) => (text === "" ? undefined : JSON.parse(text)));
  const collection = (name) => {
    if (typeof name !== "string") throw new TypeError("collection() takes a collection name.");
    return Object.freeze({
      insert: (data) => call("db.insert", [name, data]),
      get: (id) => call("db.get", [name, id]),
      list: (query) => call("db.list", [name, query === undefined ? {} : query]),
      update: (id, changes) => call("db.update", [name, id, changes]),
      remove: (id) => call("db.remove", [name, id]),
    });
  };
  const respond = (answer) => {
    const body = answer.body;
    return Object.freeze({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: Object.freeze(answer.headers),
      text: async () => body,
      json: async () => JSON.parse(body),
    });
  };
  const noop = () => undefined;
  globalThis.console = Object.freeze({ log: noop, info: noop, warn: noop, error: noop, debug: noop });
  globalThis.${MAKE_CTX} = (json) => {
    const given = JSON.parse(json);
    const ctx = { input: given.input, now: given.now, today: given.today, timeZone: given.timeZone };
    if (given.db) ctx.db = Object.freeze({ collection });
    if (given.fetch)
      ctx.fetch = (url, init) =>
        call("fetch", [String(url), init === undefined ? {} : init]).then(respond);
    return [Object.freeze(ctx), given.input];
  };
  globalThis.${TO_JSON} = (value) => {
    const text = JSON.stringify(value === undefined ? null : value);
    return text === undefined ? "null" : text;
  };
  globalThis.${FUNCTIONS} = (exports) =>
    JSON.stringify(Object.keys(exports).filter((name) => typeof exports[name] === "function"));
})();`;

const STOPPED = Symbol("stopped");
type Settled = { ok: true; handle: QuickJSHandle } | { ok: false; error: string };

function describeError(dumped: unknown, file: string) {
  if (!dumped || typeof dumped !== "object")
    return { name: "Error", message: String(dumped), line: null };
  const { name, message, stack } = dumped as Record<string, unknown>;
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = typeof stack === "string" ? new RegExp(`${escaped}:(\\d+)`).exec(stack)?.[1] : null;
  return {
    name: typeof name === "string" ? name : "Error",
    message: typeof message === "string" ? message : String(dumped),
    line: line ?? null,
  };
}

/** One run: a runtime, a context, and the bookkeeping that holds it to its limits. */
class Session {
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;
  private readonly deadline: number;
  private readonly deferreds = new Set<QuickJSDeferredPromise>();
  private cpuMs = 0;
  private enteredAt: number | null = null;
  private hostCalls = 0;
  /** Why the run must stop whatever the function does next; set once. */
  private stopped: string | null = null;
  private readonly stoppedSignal: Promise<typeof STOPPED>;
  private onStopped!: (value: typeof STOPPED) => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  /** A platform failure that stopped the run; thrown to the caller, never shown to the app. */
  private hostError: { error: unknown } | null = null;

  constructor(
    module: QuickJSWASMModule,
    private readonly request: AppFunctionRequest,
    private readonly limits: AppFunctionLimits,
  ) {
    this.deadline = Date.now() + limits.wallMs;
    this.stoppedSignal = new Promise((resolve) => {
      this.onStopped = resolve;
    });
    this.timer = setTimeout(() => this.stop(this.overTime()), limits.wallMs);
    this.runtime = module.newRuntime();
    this.runtime.setMemoryLimit(limits.memoryBytes);
    this.runtime.setMaxStackSize(limits.stackBytes);
    this.runtime.setInterruptHandler(() => this.shouldInterrupt());
    // Nothing resolves: a server file is one module, and an import of anything fails to load.
    this.runtime.setModuleLoader((name) => ({ error: new Error(`Cannot import "${name}".`) }));
    this.context = this.runtime.newContext();
  }

  private overTime() {
    return `took longer than ${this.limits.wallMs / 1000} seconds`;
  }

  private stop(reason: string) {
    if (this.stopped) return;
    this.stopped = reason;
    this.onStopped(STOPPED);
  }

  private shouldInterrupt(): boolean {
    if (this.stopped) return true;
    const now = Date.now();
    const spent = this.cpuMs + (this.enteredAt === null ? 0 : now - this.enteredAt);
    if (spent > this.limits.cpuMs) this.stop(`ran past its ${this.limits.cpuMs} ms of CPU time`);
    else if (now > this.deadline) this.stop(this.overTime());
    return this.stopped !== null;
  }

  /** Runs VM code, counting the time it takes against the CPU limit. */
  private inVm<R>(fn: () => R): R {
    this.enteredAt = Date.now();
    try {
      return fn();
    } finally {
      this.cpuMs += Date.now() - this.enteredAt;
      this.enteredAt = null;
    }
  }

  /** Runs the VM's queued promise jobs; a stopped run runs nothing more. */
  private pump() {
    if (this.stopped || !this.context.alive) return;
    const result = this.inVm(() => this.runtime.executePendingJobs());
    // A failing job is the function's own rejection, which reaches its awaited result.
    if (result.error) result.error.dispose();
  }

  private message(dumped: unknown): string {
    const fn = this.request.name || this.request.file;
    if (this.stopped) return `${fn} ${this.stopped}.`;
    const { name, message, line } = describeError(dumped, this.request.file);
    const where = line ? ` (${this.request.file} line ${line})` : "";
    if (/out of memory/i.test(message))
      return `${fn} used more than ${this.limits.memoryBytes / (1024 * 1024)} MB of memory.`;
    if (/stack overflow|call stack/i.test(message))
      return `${fn} called itself too deeply${where}.`;
    return `${fn} failed: ${name === "Error" ? "" : `${name}: `}${message}${where}`;
  }

  private failure(error: QuickJSHandle): string {
    const dumped = this.context.dump(error);
    error.dispose();
    return this.message(dumped);
  }

  private defineHost() {
    const host = this.context.newFunction(HOST, (opHandle, jsonHandle) => {
      const op = this.context.getString(opHandle);
      const json = this.context.getString(jsonHandle);
      const deferred = this.context.newPromise();
      this.deferreds.add(deferred);
      const settle = (outcome: { text: string } | { error: string }) => {
        if (!this.context.alive || !deferred.alive) return;
        const value =
          "text" in outcome
            ? this.context.newString(outcome.text)
            : this.context.newError(outcome.error);
        if ("text" in outcome) deferred.resolve(value);
        else deferred.reject(value);
        value.dispose();
        this.deferreds.delete(deferred);
        deferred.dispose();
        this.pump();
      };
      this.hostCalls += 1;
      if (this.hostCalls > this.limits.hostCalls) {
        this.stop(`made more than ${this.limits.hostCalls} platform calls`);
        queueMicrotask(() => settle({ error: "Too many platform calls." }));
        return deferred.handle;
      }
      let args: unknown;
      try {
        args = JSON.parse(json);
      } catch {
        args = null;
      }
      if (!Array.isArray(args)) {
        queueMicrotask(() => settle({ error: "The call's arguments must be JSON." }));
        return deferred.handle;
      }
      this.request.host.call(op, args).then(
        (value) => settle({ text: value === undefined ? "" : JSON.stringify(value) }),
        (error: unknown) => {
          if (error instanceof AppFunctionCallError) settle({ error: error.message });
          else {
            // Not the function's to handle: the platform failed, so the run stops.
            this.hostError ??= { error };
            this.stop("could not reach the platform");
            settle({ error: "The platform could not answer." });
          }
        },
      );
      return deferred.handle;
    });
    this.context.setProp(this.context.global, HOST, host);
    host.dispose();
  }

  /** Waits for a value that may be a promise in the VM, pumping its jobs as the platform answers. */
  private async settle(handle: QuickJSHandle): Promise<Settled> {
    const native = this.context.resolvePromise(handle);
    handle.dispose();
    this.pump();
    const outcome = await Promise.race([native, this.stoppedSignal]);
    if (outcome === STOPPED) return { ok: false, error: this.message(null) };
    if (outcome.error) return { ok: false, error: this.failure(outcome.error) };
    return { ok: true, handle: outcome.value };
  }

  private callGlobal(name: string, ...args: QuickJSHandle[]) {
    const fn = this.context.getProp(this.context.global, name);
    try {
      return this.inVm(() => this.context.callFunction(fn, this.context.undefined, ...args));
    } finally {
      fn.dispose();
    }
  }

  /** Loads the bootstrap and the app's module, and hands its exports to `work`. */
  async start<T>(work: (exports: QuickJSHandle) => Promise<T>): Promise<T | AppFunctionOutcome> {
    const abort = () => this.stop("was stopped");
    if (this.request.signal?.aborted) abort();
    this.request.signal?.addEventListener("abort", abort, { once: true });
    let outcome: T | AppFunctionOutcome;
    try {
      outcome = await this.load(work);
    } finally {
      this.request.signal?.removeEventListener("abort", abort);
    }
    // The platform failing is not the app's error: the caller sees it, and the run rolls back.
    if (this.hostError) throw this.hostError.error;
    return outcome;
  }

  private async load<T>(
    work: (exports: QuickJSHandle) => Promise<T>,
  ): Promise<T | AppFunctionOutcome> {
    this.defineHost();
    const boot = this.inVm(() => this.context.evalCode(BOOTSTRAP, "superbot-bootstrap.js"));
    if (boot.error) return { ok: false, error: this.failure(boot.error) };
    boot.value.dispose();
    const loaded = this.inVm(() =>
      this.context.evalCode(this.request.source, this.request.file, { type: "module" }),
    );
    if (loaded.error) return { ok: false, error: this.failure(loaded.error) };
    const exports = await this.settle(loaded.value);
    if (!exports.ok) return exports;
    try {
      return await work(exports.handle);
    } finally {
      exports.handle.dispose();
    }
  }

  /** The exported names that are functions. */
  functions(exports: QuickJSHandle): { ok: true; names: string[] } | { ok: false; error: string } {
    const listed = this.callGlobal(FUNCTIONS, exports);
    if (listed.error) return { ok: false, error: this.failure(listed.error) };
    const names = JSON.parse(this.context.getString(listed.value)) as string[];
    listed.value.dispose();
    return { ok: true, names };
  }

  /** Calls the exported function with `ctx` and the input, and returns its JSON answer. */
  async call(exports: QuickJSHandle, name: string): Promise<AppFunctionOutcome> {
    const fn = this.context.getProp(exports, name);
    try {
      if (this.context.typeof(fn) !== "function")
        return { ok: false, error: `${this.request.file} exports no function "${name}".` };
      const given = this.context.newString(
        JSON.stringify({
          ...this.request.context,
          input: this.request.input,
          db: this.request.capabilities.db,
          fetch: this.request.capabilities.fetch,
        }),
      );
      const made = this.callGlobal(MAKE_CTX, given);
      given.dispose();
      if (made.error) return { ok: false, error: this.failure(made.error) };
      const ctx = this.context.getProp(made.value, 0);
      const input = this.context.getProp(made.value, 1);
      made.value.dispose();
      const called = this.inVm(() =>
        this.context.callFunction(fn, this.context.undefined, ctx, input),
      );
      ctx.dispose();
      input.dispose();
      if (called.error) return { ok: false, error: this.failure(called.error) };
      const settled = await this.settle(called.value);
      if (!settled.ok) return settled;
      // A limit hit while the function caught the refusal still fails the whole run.
      if (this.stopped) {
        settled.handle.dispose();
        return { ok: false, error: this.message(null) };
      }
      return this.answer(settled.handle);
    } finally {
      fn.dispose();
    }
  }

  private answer(handle: QuickJSHandle): AppFunctionOutcome {
    const text = this.callGlobal(TO_JSON, handle);
    handle.dispose();
    if (text.error)
      return {
        ok: false,
        error: `${this.request.name} must return JSON: ${this.failure(text.error)}`,
      };
    const json = this.context.getString(text.value);
    text.value.dispose();
    if (new TextEncoder().encode(json).byteLength > this.limits.resultBytes)
      return {
        ok: false,
        error: `${this.request.name} returned more than ${this.limits.resultBytes} bytes.`,
      };
    return { ok: true, result: JSON.parse(json) as unknown };
  }

  /** Frees what the run holds. An engine an abort left unusable is dropped with the run. */
  dispose() {
    clearTimeout(this.timer);
    this.stop("ended");
    try {
      for (const deferred of this.deferreds) if (deferred.alive) deferred.dispose();
      this.deferreds.clear();
      if (this.context.alive) this.context.dispose();
      if (this.runtime.alive) this.runtime.dispose();
    } catch (error) {
      // Only an engine that aborted fails to free; nothing else shares it.
      if (!(error instanceof WebAssembly.RuntimeError)) throw error;
    }
  }
}

class QuickJsAppFunctions implements AppFunctionRuntime {
  private async session<T>(
    request: AppFunctionRequest,
    work: (session: Session, exports: QuickJSHandle) => Promise<T>,
  ): Promise<T | AppFunctionOutcome> {
    const limits = { ...APP_FUNCTION_LIMITS, ...request.limits };
    const session = new Session(await engineModule(limits), request, limits);
    try {
      return await session.start((exports) => work(session, exports));
    } finally {
      // The engine is this run's alone, so one left unusable by an abort is simply dropped.
      session.dispose();
    }
  }

  async run(request: AppFunctionRequest): Promise<AppFunctionOutcome> {
    const limits = { ...APP_FUNCTION_LIMITS, ...request.limits };
    if (jsonBytes(request.input) > limits.inputBytes)
      return { ok: false, error: `${request.name}: the input is over ${limits.inputBytes} bytes.` };
    return this.session(request, (session, exports) => session.call(exports, request.name));
  }

  async functions(source: string, file: string) {
    const loaded = await this.session(
      {
        source,
        file,
        name: "",
        input: {},
        context: { now: new Date(0).toISOString(), today: "1970-01-01", timeZone: "UTC" },
        capabilities: { db: false, readOnly: true, fetch: false },
        host: { call: () => Promise.reject(new AppFunctionCallError("Nothing runs on load.")) },
      },
      async (session, exports) => session.functions(exports),
    );
    if ("names" in loaded) return loaded;
    return { ok: false as const, error: loaded.ok ? "The module did not load." : loaded.error };
  }
}

export function createQuickJsAppFunctions(): AppFunctionRuntime {
  return new QuickJsAppFunctions();
}
