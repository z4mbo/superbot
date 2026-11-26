import type { SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaSettingsDeps } from "./media-settings.js";
import {
  connectMediaProvider,
  disconnectMediaProvider,
  mediaCatalog,
  setMediaPreference,
} from "./media-settings.js";

const alice: Actor = {
  userId: "alice",
  spaceId: "space",
  email: "alice@example.test",
  isDeploymentOwner: false,
};
const bob: Actor = { ...alice, userId: "bob", email: "bob@example.test" };
const SECRET = "fake-secret-value-123";
const OTHER_SECRET = "fake-secret-value-456";

type Row = Record<string, unknown>;

/**
 * An in-memory stand-in for the tables media settings write, scoped the way the queries are.
 * The secret store seals by encoding, so a plaintext secret found anywhere is a leak.
 */
function fakeDeps() {
  const tables: Record<
    | "userMediaCredential"
    | "userMediaPreference"
    | "secret"
    | "userModelCredential"
    | "userVoiceCredential",
    Row[]
  > = {
    userMediaCredential: [],
    userMediaPreference: [],
    secret: [],
    userModelCredential: [],
    userVoiceCredential: [],
  };
  let ids = 0;
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "userId_provider" || key === "userId_kind") return matches(row, value as Row);
      if (value && typeof value === "object" && "in" in value)
        return (value.in as unknown[]).includes(row[key]);
      if (value && typeof value === "object" && "not" in value) return row[key] !== value.not;
      return row[key] === value;
    });
  // Prisma answers with copies, never the stored rows themselves.
  const copy = (row: Row | undefined) => (row ? { ...row } : null);
  const table = (name: keyof typeof tables) => ({
    findMany: vi.fn(async ({ where }: { where?: Row } = {}) =>
      tables[name]!.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    ),
    findFirst: vi.fn(async ({ where }: { where?: Row }) =>
      copy(tables[name]!.find((row) => matches(row, where))),
    ),
    findUnique: vi.fn(async ({ where }: { where?: Row }) =>
      copy(tables[name]!.find((row) => matches(row, where))),
    ),
    count: vi.fn(
      async ({ where }: { where?: Row }) =>
        tables[name]!.filter((row) => matches(row, where)).length,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `${name}-${++ids}`, ...data };
      tables[name]!.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = tables[name]!.find((candidate) => matches(candidate, where))!;
      return { ...Object.assign(row, data) };
    }),
    upsert: vi.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const row = tables[name]!.find((candidate) => matches(candidate, where));
      if (row) return Object.assign(row, update);
      tables[name]!.push({ ...create });
      return create;
    }),
    deleteMany: vi.fn(async ({ where }: { where?: Row }) => {
      const before = tables[name]!.length;
      tables[name] = tables[name]!.filter((row) => !matches(row, where));
      return { count: before - tables[name]!.length };
    }),
  });
  const prisma = {
    ...Object.fromEntries(
      Object.keys(tables).map((name) => [name, table(name as keyof typeof tables)]),
    ),
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(prisma)),
  };
  const seal = (plaintext: string) => `sealed:${Buffer.from(plaintext).toString("base64")}`;
  const secrets = {
    put: vi.fn(async (plaintext: string) => ({
      id: `secret-${++ids}`,
      ciphertext: seal(plaintext),
    })),
    load: vi.fn(async (ciphertext: string) =>
      Buffer.from(ciphertext.slice("sealed:".length), "base64").toString(),
    ),
    delete: vi.fn(),
    isRemote: () => false,
  } as unknown as SecretStore;
  const deps: MediaSettingsDeps = { prisma: prisma as unknown as PrismaClient, secrets };
  return { deps, tables, secrets };
}

const higgsfield = (keyId: string, keySecret: string) => ({
  provider: "higgsfield",
  fields: { keyId, keySecret },
});

describe("media settings", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  it("lists every provider unconnected until the person connects one", async () => {
    const { deps } = fakeDeps();
    const catalog = await mediaCatalog(deps, alice);
    expect(catalog.providers.length).toBeGreaterThan(1);
    for (const entry of catalog.providers) {
      expect(entry).toMatchObject({
        connected: false,
        source: null,
        hints: {},
        capabilities: { image: false, imageEdit: false, video: false },
      });
    }
    expect(catalog.preference).toEqual({ image: null, video: null });
    expect(catalog.server).toBeNull();
  });

  it("connects a key, shows back only what is not secret, and seals the rest", async () => {
    const { deps, tables } = fakeDeps();
    const entry = await connectMediaProvider(deps, alice, higgsfield("fake-key-id", SECRET));
    expect(entry).toMatchObject({
      id: "higgsfield",
      name: "Higgsfield",
      connected: true,
      source: "key",
      hints: { keyId: "fake-key-id" },
      capabilities: { image: true, imageEdit: false, video: true },
    });
    expect(tables.userMediaCredential).toEqual([
      expect.objectContaining({ userId: "alice", provider: "higgsfield" }),
    ]);
    expect(tables.secret).toEqual([
      expect.objectContaining({ userId: "alice", spaceId: null, kind: "media" }),
    ]);
    expect(JSON.stringify(tables)).not.toContain(SECRET);
    const catalog = await mediaCatalog(deps, alice);
    expect(catalog.providers.find((provider) => provider.id === "higgsfield")?.connected).toBe(
      true,
    );
  });

  it("refuses what cannot be connected", async () => {
    const { deps, tables } = fakeDeps();
    const refused = (input: { provider: string; fields: Record<string, string> }) =>
      connectMediaProvider(deps, alice, input).catch((error: unknown) => error);
    for (const [input, message] of [
      [{ provider: "nobody", fields: { apiKey: SECRET } }, "Unknown media provider."],
      // The ChatGPT sign-in is borrowed from Models; it has nothing to paste.
      [{ provider: "openai-codex", fields: { apiKey: SECRET } }, "Unknown media provider."],
      [{ provider: "openai", fields: { apiKey: SECRET, extra: "x" } }, "Unknown field"],
      [{ provider: "openai", fields: { apiKey: "  " } }, "Enter the API key."],
      [higgsfield("fake-key-id", ""), "Enter the API key secret."],
    ] as const) {
      const error = await refused(input);
      expect(error).toBeInstanceOf(ClientError);
      expect(error).toMatchObject({ kind: "BAD_REQUEST" });
      expect((error as Error).message).toContain(message);
    }
    expect(tables.userMediaCredential).toEqual([]);
    expect(tables.secret).toEqual([]);
  });

  it("keeps the saved secret when a field is left blank, and replaces its sealed value", async () => {
    const { deps, tables, secrets } = fakeDeps();
    await connectMediaProvider(deps, alice, higgsfield("first-id", SECRET));
    const first = tables.secret[0]!.id;
    const entry = await connectMediaProvider(deps, alice, higgsfield("second-id", ""));
    expect(entry.hints).toEqual({ keyId: "second-id" });
    expect(tables.userMediaCredential).toHaveLength(1);
    // The old sealed value is gone once nothing holds it.
    expect(tables.secret.map((row) => row.id)).not.toContain(first);
    const saved = JSON.parse(
      await secrets.load(tables.secret[0]!.ciphertext as string, tables.secret[0]!.id as string),
    );
    expect(saved).toEqual({
      kind: "media_key",
      fields: { keyId: "second-id", keySecret: SECRET },
    });
    // A new secret replaces it.
    await connectMediaProvider(deps, alice, higgsfield("second-id", OTHER_SECRET));
    const replaced = JSON.parse(
      await secrets.load(tables.secret[0]!.ciphertext as string, tables.secret[0]!.id as string),
    );
    expect(replaced.fields.keySecret).toBe(OTHER_SECRET);
  });

  it("disconnects a key, its sealed value and the default that named it", async () => {
    const { deps, tables } = fakeDeps();
    await connectMediaProvider(deps, alice, { provider: "xai", fields: { apiKey: SECRET } });
    await setMediaPreference(deps, alice, { kind: "image", provider: "xai" });
    expect(await disconnectMediaProvider(deps, alice, { provider: "xai" })).toEqual({ ok: true });
    expect(tables.userMediaCredential).toEqual([]);
    expect(tables.secret).toEqual([]);
    expect(tables.userMediaPreference).toEqual([]);
    const catalog = await mediaCatalog(deps, alice);
    expect(catalog.providers.find((provider) => provider.id === "xai")?.connected).toBe(false);
    expect(catalog.preference.image).toBeNull();
  });

  it("saves a default only for a connected provider and a model that makes that kind", async () => {
    const { deps } = fakeDeps();
    const refused = (input: Parameters<typeof setMediaPreference>[2]) =>
      setMediaPreference(deps, alice, input).catch((error: unknown) => error);
    expect(await refused({ kind: "image", provider: "xai" })).toMatchObject({
      kind: "BAD_REQUEST",
      message: "Connect xAI first.",
    });
    await connectMediaProvider(deps, alice, { provider: "openai", fields: { apiKey: SECRET } });
    await connectMediaProvider(deps, alice, { provider: "xai", fields: { apiKey: SECRET } });
    expect(await refused({ kind: "video", provider: "openai" })).toMatchObject({
      kind: "BAD_REQUEST",
      message: "OpenAI can't make that.",
    });
    expect(
      await refused({ kind: "image", provider: "xai", model: "grok-imagine-video-1.5" }),
    ).toMatchObject({ kind: "BAD_REQUEST", message: 'xAI has no model "grok-imagine-video-1.5".' });
    expect(await refused({ kind: "image", provider: "nobody" })).toMatchObject({
      kind: "NOT_FOUND",
    });
    expect(
      await setMediaPreference(deps, alice, {
        kind: "video",
        provider: "xai",
        model: "grok-imagine-video-1.5",
      }),
    ).toEqual({ image: null, video: { provider: "xai", model: "grok-imagine-video-1.5" } });
    expect(await setMediaPreference(deps, alice, { kind: "image", provider: "openai" })).toEqual({
      image: { provider: "openai", model: null },
      video: { provider: "xai", model: "grok-imagine-video-1.5" },
    });
    expect(await setMediaPreference(deps, alice, { kind: "video", provider: null })).toEqual({
      image: { provider: "openai", model: null },
      video: null,
    });
  });

  it("keeps each person's keys their own", async () => {
    const { deps, tables } = fakeDeps();
    await connectMediaProvider(deps, alice, { provider: "xai", fields: { apiKey: SECRET } });
    const bobs = await mediaCatalog(deps, bob);
    expect(bobs.providers.find((provider) => provider.id === "xai")?.connected).toBe(false);
    // Bob cannot make Alice's key his default, keep it with a blank field, or remove it.
    expect(
      await setMediaPreference(deps, bob, { kind: "image", provider: "xai" }).catch((e) => e),
    ).toMatchObject({ message: "Connect xAI first." });
    expect(
      await connectMediaProvider(deps, bob, { provider: "xai", fields: { apiKey: "" } }).catch(
        (e) => e,
      ),
    ).toMatchObject({ message: "Enter the API key." });
    await disconnectMediaProvider(deps, bob, { provider: "xai" });
    expect(tables.userMediaCredential).toEqual([
      expect.objectContaining({ userId: "alice", provider: "xai" }),
    ]);
  });

  it("never returns or logs a secret", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const { deps } = fakeDeps();
    const answers = [
      await connectMediaProvider(deps, alice, higgsfield("fake-key-id", SECRET)),
      await connectMediaProvider(deps, alice, higgsfield("fake-key-id", "")),
      await connectMediaProvider(deps, alice, {
        provider: "fal",
        fields: { apiKey: OTHER_SECRET },
      }),
      await mediaCatalog(deps, alice),
      await setMediaPreference(deps, alice, { kind: "image", provider: "fal" }),
      await connectMediaProvider(deps, alice, { provider: "openai", fields: { apiKey: "" } }).catch(
        (error: Error) => error.message,
      ),
      await disconnectMediaProvider(deps, alice, { provider: "fal" }),
      await mediaCatalog(deps, alice),
    ];
    const seen = JSON.stringify([answers, sink.events]);
    expect(seen).not.toContain(SECRET);
    expect(seen).not.toContain(OTHER_SECRET);
  });
});
