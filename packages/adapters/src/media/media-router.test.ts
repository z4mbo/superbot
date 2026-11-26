import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { selectBuiltinToolsForRun } from "../runs/tools/run-tool-selection.js";
import { borrowMediaModelConnection } from "./media-model-connection.js";
import { mediaProviders } from "./media-providers.js";
import type { MediaJob, MediaRouterDeps } from "./media-router.js";
import {
  availableMediaCapabilities,
  listMediaProviders,
  MediaConnectionError,
  resolveMediaRoute,
  SERVER_MEDIA_ROUTE,
  serializeMediaKey,
} from "./media-router.js";
import { runMediaToolOptions } from "./media-run-tools.js";
import { ScriptedMediaProvider } from "./scripted-media-provider.js";

// A borrowed sign-in is refreshed under the model connection's lock; here it is a fixed token.
vi.mock("./media-model-connection.js", () => ({
  borrowMediaModelConnection: vi.fn(async (_deps, _scope, source) => ({
    kind: "model_connection",
    provider: source.provider,
    auth: source.auth,
    token: "fake-borrowed-token",
    accountId: "fake-account",
  })),
}));

const ALICE = { userId: "alice", spaceId: "space" };
const BOB = { userId: "bob", spaceId: "space" };

/** Placeholder values for every field a provider's form has. */
function keyFields(provider: string): Record<string, string> {
  const definition = mediaProviders[provider as keyof typeof mediaProviders];
  return Object.fromEntries(
    definition.catalog.fields.map((field) => [field.name, `fake-${provider}-${field.name}`]),
  );
}

/**
 * An in-memory stand-in for the tables the router reads, scoped by user the way the queries
 * are. Sealed values are stored as their plaintext: the secret store here is the identity.
 */
function fakeDb() {
  const keys: Array<{
    id: string;
    userId: string;
    provider: string;
    secretId: string;
    hints: unknown;
  }> = [];
  const secrets: Array<{ id: string; userId: string; spaceId: null; ciphertext: string }> = [];
  const modelConnections: Array<{ userId: string; provider: string }> = [];
  const preferences: Array<{
    userId: string;
    kind: string;
    provider: string;
    model: string | null;
  }> = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const prisma = {
    userMediaCredential: {
      findMany: vi.fn(async ({ where }) => keys.filter((row) => matches(row, where))),
      findFirst: vi.fn(async ({ where }) => keys.find((row) => matches(row, where)) ?? null),
    },
    userModelCredential: {
      findMany: vi.fn(async ({ where }) => modelConnections.filter((row) => matches(row, where))),
    },
    userMediaPreference: {
      findMany: vi.fn(async ({ where }) => preferences.filter((row) => matches(row, where))),
    },
    secret: {
      findFirst: vi.fn(async ({ where }) => secrets.find((row) => matches(row, where)) ?? null),
    },
  };
  const secretStore = {
    load: vi.fn(async (ciphertext: string) => ciphertext),
    put: vi.fn(),
    delete: vi.fn(),
    isRemote: () => false,
  } as unknown as Pick<SecretStore, "load" | "put" | "delete" | "isRemote">;
  return {
    prisma,
    secretStore,
    connectKey(userId: string, provider: string, hints: Record<string, string> = {}) {
      const secretId = `secret-${userId}-${provider}`;
      secrets.push({
        id: secretId,
        userId,
        spaceId: null,
        ciphertext: serializeMediaKey(keyFields(provider)),
      });
      keys.push({ id: `key-${userId}-${provider}`, userId, provider, secretId, hints });
    },
    connectModel(userId: string, provider: string) {
      modelConnections.push({ userId, provider });
    },
    prefer(userId: string, kind: string, provider: string, model: string | null = null) {
      preferences.push({ userId, kind, provider, model });
    },
    deps(extra: Partial<MediaRouterDeps> = {}): MediaRouterDeps {
      return { prisma: prisma as unknown as PrismaClient, secretStore, ...extra };
    },
  };
}

const route = (db: ReturnType<typeof fakeDb>, job: MediaJob, extra = {}, scope = ALICE) =>
  resolveMediaRoute(db.deps(), scope, { job, ...extra }).then((resolved) => resolved.route);

/** The registered providers whose listed models can do a job, in registry order. */
function providersFor(job: MediaJob) {
  return Object.entries(mediaProviders)
    .filter(([id]) => id !== "scripted")
    .filter(([, definition]) =>
      definition.models.some(
        (model) =>
          model.kind === (job === "video" ? "video" : "image") &&
          (job !== "image_edit" || model.edit),
      ),
    )
    .map(([id]) => id);
}

function connectAll(db: ReturnType<typeof fakeDb>, ids: readonly string[], userId = "alice") {
  for (const id of ids) {
    if (id === "openai-codex") db.connectModel(userId, "openai-codex");
    else db.connectKey(userId, id);
  }
}

describe("media routing", () => {
  it("follows the default precedence among what the person connected", async () => {
    expect(providersFor("image")).toEqual([
      "openai-codex",
      "openai",
      "xai",
      "google",
      "fal",
      "replicate",
      "higgsfield",
    ]);
    expect(providersFor("video")).toEqual([
      "xai",
      "google",
      "fal",
      "replicate",
      "higgsfield",
      "byteplus",
    ]);
    for (const job of ["image", "image_edit", "video"] as const) {
      const order = providersFor(job);
      for (const [index, expected] of order.entries()) {
        const db = fakeDb();
        // Everything from this provider on is connected; the first of them is chosen.
        connectAll(db, order.slice(index));
        expect((await route(db, job)).provider, `${job} from ${expected}`).toBe(expected);
      }
    }
  });

  it("borrows the ChatGPT sign-in before any key, and names the credential, never its secret", async () => {
    const db = fakeDb();
    connectAll(db, ["openai-codex", "openai"]);
    const resolved = await resolveMediaRoute(db.deps(), ALICE, { job: "image" });
    expect(resolved.route).toEqual({
      provider: "openai-codex",
      providerName: "ChatGPT",
      source: "model_connection",
      modelConnection: "openai-codex",
      model: "gpt-image-2.5-sunburst",
    });
    expect(vi.mocked(borrowMediaModelConnection)).toHaveBeenCalled();
    expect(JSON.stringify(resolved.route)).not.toContain("fake-");
  });

  it("takes the call's own provider and model over the precedence", async () => {
    const db = fakeDb();
    connectAll(db, ["openai", "xai", "google"]);
    expect(await route(db, "image", { provider: "xai" })).toMatchObject({
      provider: "xai",
      providerName: "xAI",
      source: "key",
      credentialId: "key-alice-xai",
      model: "grok-imagine-image-2.0",
    });
    expect(await route(db, "image", { model: "gemini-3-pro-image" })).toMatchObject({
      provider: "google",
      model: "gemini-3-pro-image",
    });
    expect(await route(db, "image", { provider: "openai", model: "gpt-image-2" })).toMatchObject({
      provider: "openai",
      model: "gpt-image-2",
    });
    await expect(
      route(db, "image", { provider: "openai", model: "no-such-model" }),
    ).rejects.toThrow(/OpenAI has no model "no-such-model"/);
    // A model that cannot do the job is refused even when its provider is connected.
    await expect(route(db, "video", { model: "grok-imagine-image-2.0" })).rejects.toThrow(
      MediaConnectionError,
    );
  });

  it("uses the saved preference when the call names nothing", async () => {
    const db = fakeDb();
    connectAll(db, ["openai", "xai", "google"]);
    db.prefer("alice", "image", "google", "gemini-3-pro-image");
    db.prefer("alice", "video", "xai");
    expect(await route(db, "image")).toMatchObject({
      provider: "google",
      model: "gemini-3-pro-image",
    });
    expect(await route(db, "video")).toMatchObject({
      provider: "xai",
      model: "grok-imagine-video-1.5",
    });
    // The call's own choice still wins.
    expect(await route(db, "image", { provider: "openai" })).toMatchObject({ provider: "openai" });
  });

  it("never routes to a provider the person did not connect", async () => {
    const db = fakeDb();
    connectAll(db, ["xai"]);
    // A saved choice for a provider that is no longer connected is passed over.
    db.prefer("alice", "image", "google");
    expect(await route(db, "image")).toMatchObject({ provider: "xai" });
    await expect(route(db, "image", { provider: "google" })).rejects.toThrow(
      /Google Gemini is not connected\. Available: xai \(xAI\)/,
    );
    await expect(route(db, "image", { model: "gemini-3-pro-image" })).rejects.toThrow(
      /not available/,
    );
    await expect(route(db, "image", { provider: "nobody" })).rejects.toThrow(
      /no media provider "nobody"/,
    );
  });

  it("prefers the person's own connection to the server's provider, and falls back to it", async () => {
    const server = new ScriptedMediaProvider();
    const db = fakeDb();
    connectAll(db, ["openai"]);
    const mine = await resolveMediaRoute(db.deps({ serverDefault: server }), ALICE, {
      job: "image",
    });
    expect(mine.route.provider).toBe("openai");
    expect(mine.provider).not.toBe(server);
    // Nothing connected makes video, so the server's provider makes it.
    const video = await resolveMediaRoute(db.deps({ serverDefault: server }), ALICE, {
      job: "video",
    });
    expect(video).toEqual({ provider: server, route: SERVER_MEDIA_ROUTE });
    // Someone who connected nothing gets the server's provider for everything it makes.
    const other = await resolveMediaRoute(db.deps({ serverDefault: server }), BOB, {
      job: "image",
    });
    expect(other.provider).toBe(server);
  });

  it("says media generation is unavailable when nothing is connected and there is no fallback", async () => {
    const db = fakeDb();
    await expect(route(db, "image")).rejects.toThrow("Media generation is unavailable.");
    const options = await runMediaToolOptions(
      {
        ...db.deps(),
        artifacts: {} as never,
        mediaProviders: undefined,
      },
      { ...ALICE, trigger: "user" },
      undefined,
    );
    expect(options).toMatchObject({
      mediaImagesEnabled: false,
      mediaImageEditEnabled: false,
      mediaVideoEnabled: false,
    });
  });

  it("never lets one person's key serve another", async () => {
    const db = fakeDb();
    connectAll(db, ["openai", "xai"], "alice");
    await expect(route(db, "image", {}, BOB)).rejects.toThrow("Media generation is unavailable.");
    await expect(route(db, "image", { provider: "openai" }, BOB)).rejects.toThrow(/not connected/);
    // Every read the router made was limited to the asking user.
    for (const call of [
      ...db.prisma.userMediaCredential.findMany.mock.calls,
      ...db.prisma.secret.findFirst.mock.calls,
    ]) {
      if (JSON.stringify(call).includes("bob")) expect(call[0].where.userId).toBe("bob");
    }
  });
});

describe("media tools a run offers", () => {
  const base = {
    graphicalToolsAllowed: false,
    groupId: null,
    trigger: "message",
    semanticMemoryEnabled: false,
    messagingChannelRun: false,
  };
  async function offered(db: ReturnType<typeof fakeDb>) {
    const options = await runMediaToolOptions(
      { ...db.deps(), artifacts: {} as never, mediaProviders: undefined },
      { ...ALICE, trigger: "user" },
      undefined,
    );
    const tools = selectBuiltinToolsForRun({ ...base, ...options });
    return Object.fromEntries(
      tools
        .filter((tool) => ["generate_image", "edit_image", "generate_video"].includes(tool.name))
        .map((tool) => [tool.name, tool.description]),
    );
  }

  it("offers only what a connected provider can do, and names the choices", async () => {
    const images = fakeDb();
    connectAll(images, ["openai"]);
    const imageTools = await offered(images);
    expect(Object.keys(imageTools).sort()).toEqual(["edit_image", "generate_image"]);
    expect(imageTools.generate_image).toContain(
      "Available: openai (OpenAI): gpt-image-2.6-sunburst (default)",
    );

    const video = fakeDb();
    connectAll(video, ["byteplus"]);
    expect(Object.keys(await offered(video))).toEqual(["generate_video"]);

    // Higgsfield makes images and video but edits nothing.
    const noEdits = fakeDb();
    connectAll(noEdits, ["higgsfield"]);
    expect(Object.keys(await offered(noEdits)).sort()).toEqual([
      "generate_image",
      "generate_video",
    ]);

    expect(await offered(fakeDb())).toEqual({});
  });
});

describe("media catalog", () => {
  it("says honestly what each provider does for this person", async () => {
    const db = fakeDb();
    db.connectKey("alice", "higgsfield", { keyId: "fake-key-id" });
    db.connectModel("alice", "openai-codex");
    db.connectKey("bob", "xai");
    db.prefer("alice", "video", "higgsfield");
    const catalog = await listMediaProviders(db.deps(), ALICE);
    const byId = Object.fromEntries(catalog.providers.map((entry) => [entry.id, entry]));
    expect(catalog.providers.map((entry) => entry.id)).toEqual([
      "openai-codex",
      "openai",
      "xai",
      "google",
      "fal",
      "replicate",
      "higgsfield",
      "byteplus",
      "scripted",
    ]);
    expect(byId["openai-codex"]).toMatchObject({
      name: "ChatGPT",
      connected: true,
      source: "model_connection",
      fields: [],
      modelConnections: ["openai-codex"],
      capabilities: { image: true, imageEdit: true, video: false },
    });
    expect(byId.higgsfield).toMatchObject({
      connected: true,
      source: "key",
      // Only the field that is not secret comes back.
      hints: { keyId: "fake-key-id" },
      capabilities: { image: true, imageEdit: false, video: true },
    });
    // Bob's key is his alone; for Alice xAI is not connected and does nothing.
    expect(byId.xai).toMatchObject({
      connected: false,
      source: null,
      hints: {},
      capabilities: { image: false, imageEdit: false, video: false },
    });
    expect(byId.xai?.models.map((model) => [model.id, model.kind, Boolean(model.edit)])).toEqual([
      ["grok-imagine-image-2.0", "image", true],
      ["grok-imagine-video-1.5", "video", false],
    ]);
    expect(catalog.preference).toEqual({
      image: null,
      video: { provider: "higgsfield", model: null },
    });
    expect(catalog.server).toBeNull();
    expect(availableMediaCapabilities(catalog)).toEqual({
      image: true,
      imageEdit: true,
      video: true,
    });
    expect(JSON.stringify(catalog)).not.toContain("fake-higgsfield-keySecret");
  });

  it("reports the server's provider only for what it makes", async () => {
    const db = fakeDb();
    const catalog = await listMediaProviders(
      db.deps({ serverDefault: new ScriptedMediaProvider() }),
      ALICE,
    );
    expect(catalog.server).toEqual({ image: true, imageEdit: true, video: true });
    expect(catalog.providers.every((entry) => !entry.connected)).toBe(true);
  });
});
