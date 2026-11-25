import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "../client/client.js";
import type { Exchange } from "../client/wire-fixture.test-support.js";
import { gatewayError, json, wireFixture } from "../client/wire-fixture.test-support.js";
import { SERVER_UNREACHABLE, SuperbotError } from "../errors.js";
import { useTemporarySettings } from "../settings/settings.test-support.js";
import {
  CredentialStore,
  RESTORE_TIMING,
  restoreRetryDelay,
  SESSION_SERVICE,
} from "./credential-store.js";
import type { SystemCredentialStore } from "./system-store.js";
import { NoSystemStoreError } from "./system-store.js";

const temporarySettings = useTemporarySettings();

/** A system store held in memory, keyed like the real one by service and account. */
function memoryStore() {
  const entries = new Map<string, string>();
  const key = (service: string, account: string) => `${service}\n${account}`;
  const store: SystemCredentialStore = {
    get: async (service, account) => entries.get(key(service, account)) ?? null,
    set: async (service, account, secret) => {
      entries.set(key(service, account), secret);
    },
    delete: async (service, account) => {
      entries.delete(key(service, account));
    },
  };
  return { store, entries };
}

function failingStore(error: () => Error): SystemCredentialStore {
  return {
    get: async () => Promise.reject(error()),
    set: async () => Promise.reject(error()),
    delete: async () => Promise.reject(error()),
  };
}

const noSystemStore = failingStore(
  () => new NoSystemStoreError(new Error("Platform failure: no secret service")),
);

const server = new Client("https://one.example.test");
const signedIn = server.withToken("fixture.signature");

describe("CredentialStore", () => {
  it("saves to the system store under the native apps' service and account", async () => {
    const { settings } = await temporarySettings();
    const { store, entries } = memoryStore();
    const sessions = new CredentialStore({ systemStore: store, settings });
    expect(await sessions.load(server)).toBeUndefined();
    expect(await sessions.save(signedIn)).toEqual({ kind: "systemStore" });
    expect([...entries]).toEqual([
      [`${SESSION_SERVICE}\nhttps://one.example.test/`, "fixture.signature"],
    ]);
    expect(SESSION_SERVICE).toBe("com.superbot.rakazo.session");
    const loaded = await sessions.load(server);
    expect(loaded?.server).toBe(server.server);
    await sessions.delete(server);
    expect(await sessions.load(server)).toBeUndefined();
  });

  it("falls back to a private file when the computer has no credential store", async () => {
    const { directory, settings } = await temporarySettings();
    const sessions = new CredentialStore({ systemStore: noSystemStore, settings });
    const file = path.join(directory, "sessions.json");
    expect(await sessions.save(signedIn)).toEqual({ kind: "file", path: file });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "https://one.example.test/": "fixture.signature",
    });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await sessions.load(server))?.server).toBe(server.server);
    await sessions.delete(server);
    expect(await sessions.load(server)).toBeUndefined();
    await expect(stat(file)).rejects.toThrow();
  });

  it("reads a file session when the system store has none, and tidies it after saving there", async () => {
    const { directory, settings } = await temporarySettings();
    await new CredentialStore({ systemStore: noSystemStore, settings }).save(signedIn);
    const { store, entries } = memoryStore();
    const sessions = new CredentialStore({ systemStore: store, settings });
    expect(await sessions.load(server)).toBeDefined();
    await sessions.save(signedIn);
    expect(entries.size).toBe(1);
    await expect(stat(path.join(directory, "sessions.json"))).rejects.toThrow();
  });

  it("reports a store that refused the request instead of hiding it behind the file", async () => {
    const { directory, settings } = await temporarySettings();
    const sessions = new CredentialStore({
      systemStore: failingStore(() => new Error("Entry is matched by 2 credentials")),
      settings,
    });
    for (const call of [
      () => sessions.load(server),
      () => sessions.save(signedIn),
      () => sessions.delete(server),
    ]) {
      const error = await call().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(SuperbotError);
      expect((error as SuperbotError).kind).toBe("credentialStore");
    }
    await expect(stat(path.join(directory, "sessions.json"))).rejects.toThrow();
  });

  it("cannot save a client without a session", async () => {
    const { settings } = await temporarySettings();
    const sessions = new CredentialStore({ systemStore: memoryStore().store, settings });
    await expect(sessions.save(server)).rejects.toMatchObject({ kind: "missingSession" });
  });
});

describe("CredentialStore.restore", () => {
  const fixtures: Awaited<ReturnType<typeof wireFixture>>[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  });

  /** A saved session for a local fixture server, with the restore schedule shortened tenfold. */
  async function savedSession(exchanges: Exchange[]) {
    const fixture = await wireFixture(exchanges);
    fixtures.push(fixture);
    const { settings } = await temporarySettings();
    const sessions = new CredentialStore({
      systemStore: memoryStore().store,
      settings,
      restoreTiming: { budgetMs: 1_000, firstRetryMs: 50, maxBackoffMs: 400 },
    });
    const client = new Client(fixture.origin);
    await sessions.save(client.withToken("fixture.signature"));
    return { fixture, sessions, client };
  }

  const validate = async (client: Client, signal: AbortSignal) => {
    const me = await client.rpc("me", null, {}, { signal });
    const navigation = await client.rpc("spaces/list", null, {}, { signal });
    return { me, navigation };
  };

  it("recovers from empty gateway errors on both session reads", async () => {
    const me = () => json("/rpc/me", '{"json":{"name":"Fixture"}}');
    const { fixture, sessions, client } = await savedSession([
      gatewayError("/rpc/me"),
      me(),
      gatewayError("/rpc/spaces/list"),
      me(),
      json("/rpc/spaces/list", '{"json":{"spaces":[{"id":"space-1"}]}}'),
    ]);
    expect(await sessions.restore(client, validate)).toEqual({
      me: { name: "Fixture" },
      navigation: { spaces: [{ id: "space-1" }] },
    });
    expect(await sessions.load(client)).toBeDefined();
    for (const request of fixture.requests) {
      expect(request.headers.authorization).toBe("Bearer fixture.signature");
    }
    expect(fixture.pending()).toBe(0);
  });

  it("stops retrying when the next wait would pass the budget", async () => {
    const { fixture, sessions, client } = await savedSession(
      Array.from({ length: 20 }, () => gatewayError("/rpc/me")),
    );
    const error = await sessions.restore(client, validate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: "unavailable", message: SERVER_UNREACHABLE });
    expect(fixture.requests.length).toBeGreaterThan(2);
    expect(fixture.pending()).toBeGreaterThan(0);
    expect(await sessions.load(client)).toBeDefined();
  });

  it("will not retry before Retry-After, even to fit the budget", async () => {
    const { fixture, sessions, client } = await savedSession([
      gatewayError("/rpc/me", { "retry-after": "30" }),
    ]);
    const error = await sessions.restore(client, validate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: "unavailable", retryAfterMs: 30_000 });
    expect(fixture.requests).toHaveLength(1);
    expect(await sessions.load(client)).toBeDefined();
  });

  it("discards a session the server rejects, without retrying", async () => {
    const { fixture, sessions, client } = await savedSession([{ path: "/rpc/me", status: 401 }]);
    expect(await sessions.restore(client, validate)).toBeUndefined();
    expect(await sessions.load(client)).toBeUndefined();
    expect(fixture.requests).toHaveLength(1);
  });

  it("keeps the session when the server refuses for another reason", async () => {
    const { sessions, client } = await savedSession([{ path: "/rpc/me", status: 403 }]);
    const error = await sessions.restore(client, validate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: "server", status: 403 });
    expect(await sessions.load(client)).toBeDefined();
  });

  it("resolves undefined without a network call when nothing is saved", async () => {
    const { settings } = await temporarySettings();
    const sessions = new CredentialStore({ systemStore: memoryStore().store, settings });
    const calls: Client[] = [];
    const restored = await sessions.restore(server, async (client) => {
      calls.push(client);
    });
    expect(restored).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("restoreRetryDelay", () => {
  const { budgetMs, firstRetryMs, maxBackoffMs } = RESTORE_TIMING;
  const unavailable = (seconds: number) => SuperbotError.unavailable(seconds * 1_000);

  it("respects the backoff, the server's minimum and the deadline", () => {
    expect(restoreRetryDelay(unavailable(0), firstRetryMs, budgetMs)).toBe(firstRetryMs);
    expect(restoreRetryDelay(unavailable(6), maxBackoffMs, budgetMs)).toBe(6_000);
    expect(restoreRetryDelay(unavailable(10), firstRetryMs, budgetMs)).toBeUndefined();
    expect(restoreRetryDelay(unavailable(0), maxBackoffMs, firstRetryMs)).toBeUndefined();
    expect(restoreRetryDelay(SuperbotError.unavailable(), firstRetryMs, budgetMs)).toBe(
      firstRetryMs,
    );
    expect(
      restoreRetryDelay(SuperbotError.transport(new TypeError("fetch failed")), 500, budgetMs),
    ).toBe(500);
  });

  it("never retries an answer", () => {
    expect(
      restoreRetryDelay(SuperbotError.missingSession(), firstRetryMs, budgetMs),
    ).toBeUndefined();
    expect(
      restoreRetryDelay(SuperbotError.server(401, {}), firstRetryMs, budgetMs),
    ).toBeUndefined();
    expect(restoreRetryDelay(new Error("other"), firstRetryMs, budgetMs)).toBeUndefined();
  });
});
