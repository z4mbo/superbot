import type { AppManifest } from "@rakazo/contracts";
import { appManifestSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { InstalledFunctionApp } from "./app-function-runs.js";
import { functionAction, runAppFunction } from "./app-function-runs.js";
import type { AppFunctionRequest, AppFunctionRuntime } from "./app-function-runtime.js";

const manifest: AppManifest = appManifestSchema.parse({
  id: "diary",
  name: "Diary",
  version: "1.0.0",
  description: "A diary.",
  entry: "app.jsx",
  server: "server.js",
  permissions: ["data", "network", "agent:read"],
  data: { collections: { entries: { fields: { food: { type: "string", required: true } } } } },
  network: { hosts: ["api.example.com"] },
  actions: [
    {
      name: "day",
      description: "Read a day.",
      input: { date: { type: "string", maxLength: 10 } },
      run: "day",
      readOnly: true,
    },
    {
      name: "add",
      description: "Add food.",
      input: { food: { type: "string", required: true } },
      run: "add",
    },
  ],
});

function app(granted = manifest.permissions): InstalledFunctionApp {
  return { installId: "install-1", manifest, granted, server: "export function day() {}" };
}

/** A runtime that answers with what `respond` does with the request it was given. */
function runtime(respond: (request: AppFunctionRequest) => Promise<unknown> | unknown) {
  const requests: AppFunctionRequest[] = [];
  const engine: AppFunctionRuntime = {
    async run(request) {
      requests.push(request);
      try {
        return { ok: true, result: await respond(request) };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
    functions: async () => ({ ok: true, names: [] }),
  };
  return { requests, load: async () => engine };
}

function prisma() {
  const tx = { $queryRaw: vi.fn(async () => []), appRecord: {} };
  return {
    tx,
    client: {
      user: { findUnique: vi.fn(async () => ({ timezone: "Europe/Rome" })) },
      $transaction: vi.fn(async (work: (db: typeof tx) => Promise<unknown>) => work(tx)),
      appRecord: {},
    } as unknown as PrismaClient & { $transaction: ReturnType<typeof vi.fn> },
  };
}

const scope = { spaceId: "space-1", userId: "user-1" };
const now = () => new Date("2026-11-26T23:30:00Z");

describe("runAppFunction", () => {
  it("refuses an input the action does not declare before anything runs", async () => {
    const engine = runtime(() => null);
    const db = prisma();
    const action = manifest.actions[1] as AppManifest["actions"][number] & { run: string };
    for (const input of [{}, { food: 4 }, { food: "Rice", extra: true }, "Rice"]) {
      const run = await runAppFunction(
        { prisma: db.client, runtime: engine.load, now },
        scope,
        app(),
        action,
        input,
      );
      expect(run).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(engine.requests).toEqual([]);
  });

  it("gives the function the person's day, and reads without a transaction when read-only", async () => {
    const engine = runtime(() => ({ ok: 1 }));
    const db = prisma();
    const action = manifest.actions[0] as AppManifest["actions"][number] & { run: string };
    const run = await runAppFunction(
      { prisma: db.client, runtime: engine.load, now },
      scope,
      app(),
      action,
      {},
    );
    expect(run).toEqual({ ok: true, result: { ok: 1 }, changed: false });
    expect(db.client.$transaction).not.toHaveBeenCalled();
    expect(engine.requests[0]).toMatchObject({
      name: "day",
      context: { today: "2026-11-27", timeZone: "Europe/Rome" },
      capabilities: { db: true, readOnly: true, fetch: true },
    });
  });

  it("writes in one transaction under the install's lock, and rolls a failed run back", async () => {
    const engine = runtime(() => {
      throw new Error("no");
    });
    const db = prisma();
    const action = manifest.actions[1] as AppManifest["actions"][number] & { run: string };
    const run = await runAppFunction(
      { prisma: db.client, runtime: engine.load, now },
      scope,
      app(),
      action,
      { food: "Rice" },
    );
    expect(run).toEqual({ ok: false, reason: "failed", error: "no" });
    expect(db.client.$transaction).toHaveBeenCalledTimes(1);
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("offers records and the network only as the install granted them", async () => {
    const engine = runtime(async (request) => {
      const fetched = await request.host.call("fetch", ["https://api.example.com/", {}]).then(
        () => "sent",
        (error: Error) => error.message,
      );
      const listed = await request.host.call("db.list", ["entries", {}]).then(
        () => "listed",
        (error: Error) => error.message,
      );
      return { fetched, listed, capabilities: request.capabilities };
    });
    const action = manifest.actions[0] as AppManifest["actions"][number] & { run: string };
    const run = await runAppFunction(
      { prisma: prisma().client, runtime: engine.load, now },
      scope,
      app(["agent:read"]),
      action,
      {},
    );
    expect(run).toEqual({
      ok: true,
      changed: false,
      result: {
        fetched: "This app has no network access.",
        listed: "This app keeps no records.",
        capabilities: { db: false, readOnly: true, fetch: false },
      },
    });
  });
});

describe("functionAction", () => {
  it("lets a bot read with agent:read but not change anything without agent:actions", () => {
    expect(functionAction(app(), { by: "agent", kind: "action", action: "day" }).ok).toBe(true);
    expect(functionAction(app(), { by: "agent", kind: "action", action: "add" })).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    expect(functionAction(app(), { by: "person", kind: "query", action: "add" }).ok).toBe(false);
    expect(functionAction(app(), { by: "person", kind: "action", action: "add" }).ok).toBe(true);
    expect(functionAction(app([]), { by: "agent", kind: "action", action: "day" }).ok).toBe(false);
  });
});
