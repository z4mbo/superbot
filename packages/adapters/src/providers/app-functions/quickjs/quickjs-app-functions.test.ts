import { describe, expect, it, vi } from "vitest";
import type { AppFunctionRequest } from "../../../apps/functions/app-function-runtime.js";
import { AppFunctionCallError } from "../../../apps/functions/app-function-runtime.js";
import { createQuickJsAppFunctions } from "./quickjs-app-functions.js";

const runtime = createQuickJsAppFunctions();

function request(source: string, overrides: Partial<AppFunctionRequest> = {}): AppFunctionRequest {
  return {
    source,
    file: "src/server.js",
    name: "main",
    input: {},
    context: { now: "2026-11-25T10:00:00.000Z", today: "2026-11-25", timeZone: "UTC" },
    capabilities: { db: true, readOnly: false, fetch: false },
    host: { call: vi.fn(async () => null) },
    ...overrides,
  };
}

describe("QuickJS app functions", () => {
  it("calls the named export with ctx and the input and returns its JSON", async () => {
    const outcome = await runtime.run(
      request(
        `export async function main(ctx, input) {
  return { sum: input.a + input.b, same: ctx.input === input, today: ctx.today, zone: ctx.timeZone, now: ctx.now };
}`,
        { input: { a: 2, b: 3 } },
      ),
    );
    expect(outcome).toEqual({
      ok: true,
      result: {
        sum: 5,
        same: true,
        today: "2026-11-25",
        zone: "UTC",
        now: "2026-11-25T10:00:00.000Z",
      },
    });
  });

  it("gives the function no host globals, timers, network or module loading", async () => {
    const outcome = await runtime.run(
      request(`export async function main() {
  const missing = ["process", "require", "setTimeout", "setInterval", "fetch", "XMLHttpRequest", "WebSocket", "__superbotHost", "Deno", "Bun", "std", "os"]
    .filter((name) => typeof globalThis[name] !== "undefined");
  let imported = "no";
  try { await import("node:fs"); imported = "yes"; } catch (error) { imported = "refused"; }
  return { missing, imported };
}`),
    );
    expect(outcome).toEqual({ ok: true, result: { missing: [], imported: "refused" } });
  });

  it("refuses a module that imports anything", async () => {
    const outcome = await runtime.run(
      request(`import fs from "fs";\nexport function main() { return fs; }`),
    );
    expect(outcome.ok).toBe(false);
  });

  it("offers ctx.db and ctx.fetch only when granted", async () => {
    const source = `export function main(ctx) { return { db: typeof ctx.db, fetch: typeof ctx.fetch }; }`;
    expect(await runtime.run(request(source))).toEqual({
      ok: true,
      result: { db: "object", fetch: "undefined" },
    });
    expect(
      await runtime.run(
        request(source, { capabilities: { db: false, readOnly: true, fetch: true } }),
      ),
    ).toEqual({ ok: true, result: { db: "undefined", fetch: "function" } });
  });

  it("sends platform calls as JSON and hands back the answer", async () => {
    const call = vi.fn(async (op: string, args: unknown[]) => ({ op, args }));
    const outcome = await runtime.run(
      request(
        `export async function main(ctx) {
  const entries = ctx.db.collection("entries");
  return [await entries.insert({ food: "apple" }), await entries.list({ where: { date: "2026-11-25" } })];
}`,
        { host: { call } },
      ),
    );
    expect(outcome).toEqual({
      ok: true,
      result: [
        { op: "db.insert", args: ["entries", { food: "apple" }] },
        { op: "db.list", args: ["entries", { where: { date: "2026-11-25" } }] },
      ],
    });
  });

  it("lets the function catch a refusal from the platform", async () => {
    const outcome = await runtime.run(
      request(
        `export async function main(ctx) {
  try { await ctx.db.collection("nope").get("x"); } catch (error) { return error.message; }
}`,
        {
          host: {
            call: async () => {
              throw new AppFunctionCallError("No collection named nope.");
            },
          },
        },
      ),
    );
    expect(outcome).toEqual({ ok: true, result: "No collection named nope." });
  });

  it("names the function and the line where it threw", async () => {
    const outcome = await runtime.run(
      request(
        `const table = {};\n\nexport function main(ctx, input) {\n  throw new Error("Tell me the kcal.");\n}\n`,
      ),
    );
    expect(outcome).toEqual({
      ok: false,
      error: "main failed: Tell me the kcal. (src/server.js line 4)",
    });
  });

  it("stops an endless loop at the CPU limit", async () => {
    const outcome = await runtime.run(
      request(`export function main() { for (;;) {} }`, { limits: { cpuMs: 100 } }),
    );
    expect(outcome).toEqual({ ok: false, error: "main ran past its 100 ms of CPU time." });
  });

  it("stops an endless chain of promises at the CPU limit", async () => {
    const outcome = await runtime.run(
      request(`export async function main() { for (;;) { await null; } }`, {
        limits: { cpuMs: 100 },
      }),
    );
    expect(outcome).toEqual({ ok: false, error: "main ran past its 100 ms of CPU time." });
  });

  it("stops a loop that runs while the module loads", async () => {
    const outcome = await runtime.run(
      request(`for (;;) {}\nexport function main() {}`, { limits: { cpuMs: 100 } }),
    );
    expect(outcome.ok).toBe(false);
  });

  it("stops a memory bomb at the memory limit", async () => {
    const outcome = await runtime.run(
      request(
        `export function main() { const keep = []; for (;;) keep.push("x".repeat(1 << 16)); }`,
        {
          limits: { memoryBytes: 8 * 1024 * 1024 },
        },
      ),
    );
    expect(outcome).toEqual({ ok: false, error: "main used more than 8 MB of memory." });
  });

  it("stops deep recursion", async () => {
    const outcome = await runtime.run(request(`export function main() { return main(); }`));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/^main called itself too deeply/);
  });

  it("fails the whole run past the platform call cap, even when the function catches it", async () => {
    const outcome = await runtime.run(
      request(
        `export async function main(ctx) {
  for (let i = 0; i < 50; i++) { try { await ctx.db.collection("e").get("x"); } catch {} }
  return "done";
}`,
        { limits: { hostCalls: 10 } },
      ),
    );
    expect(outcome).toEqual({ ok: false, error: "main made more than 10 platform calls." });
  });

  it("stops a run that waits on the platform past the wall-clock limit", async () => {
    const outcome = await runtime.run(
      request(`export async function main(ctx) { await ctx.db.collection("e").get("x"); }`, {
        host: { call: () => new Promise(() => undefined) },
        limits: { wallMs: 200 },
      }),
    );
    expect(outcome).toEqual({ ok: false, error: "main took longer than 0.2 seconds." });
  });

  it("caps the input and the answer", async () => {
    expect(
      await runtime.run(
        request(`export function main() { return 1; }`, {
          input: { text: "x".repeat(100) },
          limits: { inputBytes: 50 },
        }),
      ),
    ).toEqual({ ok: false, error: "main: the input is over 50 bytes." });
    expect(
      await runtime.run(
        request(`export function main() { return "x".repeat(1000); }`, {
          limits: { resultBytes: 100 },
        }),
      ),
    ).toEqual({ ok: false, error: "main returned more than 100 bytes." });
  });

  it("refuses an answer that is not JSON", async () => {
    const outcome = await runtime.run(
      request(`export function main() { const a = {}; a.self = a; return a; }`),
    );
    expect(outcome.ok).toBe(false);
  });

  it("returns null for a function that returns nothing", async () => {
    expect(await runtime.run(request(`export function main() {}`))).toEqual({
      ok: true,
      result: null,
    });
  });

  it("fails the run when the platform itself fails", async () => {
    await expect(
      runtime.run(
        request(
          `export async function main(ctx) { try { await ctx.db.collection("e").get("x"); } catch {} return 1; }`,
          {
            host: {
              call: async () => {
                throw new Error("database down");
              },
            },
          },
        ),
      ),
    ).rejects.toThrow("database down");
  });

  it("lists the exported functions", async () => {
    expect(
      await runtime.functions(
        `export function a() {}\nexport const b = async () => 1;\nexport const c = 3;`,
        "src/server.js",
      ),
    ).toEqual({ ok: true, names: ["a", "b"] });
  });

  it("keeps runs apart", async () => {
    const source = `let count = 0;\nexport function main() { count += 1; globalThis.leak = count; return count; }`;
    expect(await runtime.run(request(source))).toEqual({ ok: true, result: 1 });
    expect(await runtime.run(request(source))).toEqual({ ok: true, result: 1 });
  });
});
