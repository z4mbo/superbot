import { describe, expect, it, vi } from "vitest";
import type {
  MediaProviderCredential,
  MediaProviderDefinition,
} from "./media-provider-descriptor.js";
import { mediaProviders, offeredMediaProviders } from "./media-providers.js";
import { scriptedMediaOffered } from "./scripted-media-provider.js";

/** Every real media provider, by its registry id, in the registry's order. */
const definitions: [string, MediaProviderDefinition][] = Object.entries(mediaProviders).filter(
  ([id]) => id !== "scripted",
);

describe("media provider registry", () => {
  it("lists the providers in their default precedence", () => {
    expect(definitions.map(([id]) => id)).toEqual([
      "openai-codex",
      "openai",
      "xai",
      "google",
      "fal",
      "replicate",
      "higgsfield",
      "byteplus",
    ]);
  });

  it("offers the scripted provider only on a server set up for offline runs", () => {
    expect(scriptedMediaOffered({})).toBe(false);
    expect(scriptedMediaOffered({ AGENT_RUNTIME: "pi", MEDIA_GENERATION_PROVIDER: "openai" })).toBe(
      false,
    );
    expect(scriptedMediaOffered({ AGENT_RUNTIME: "scripted" })).toBe(true);
    expect(scriptedMediaOffered({ MEDIA_GENERATION_PROVIDER: "fake" })).toBe(true);
    // Tests run with the scripted runtime, so it is offered here, after every real provider.
    expect(
      offeredMediaProviders()
        .map(([id]) => id)
        .at(-1),
    ).toBe("scripted");
  });
});

/** Every credential a definition says it can use, with placeholder values. */
function credentials(definition: MediaProviderDefinition): MediaProviderCredential[] {
  const own: MediaProviderCredential[] = definition.catalog.fields.length
    ? [
        {
          kind: "key",
          fields: Object.fromEntries(
            definition.catalog.fields.map((field) => [field.name, `fake-${field.name}`]),
          ),
        },
      ]
    : [];
  return [
    ...own,
    ...(definition.modelConnections ?? []).map(
      (source) =>
        ({
          kind: "model_connection",
          provider: source.provider,
          auth: source.auth,
          token: "fake-token",
          accountId: "fake-account",
        }) as const,
    ),
  ];
}

describe("media provider definitions", () => {
  it("have unique ids", () => {
    const ids = definitions.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe.each(definitions)("%s", (id, definition) => {
    it("lists models with unique ids and exactly one default for each kind it makes", () => {
      const ids = definition.models.map((model) => model.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const kind of ["image", "video"] as const) {
        const models = definition.models.filter((model) => model.kind === kind);
        const defaults = models.filter((model) => model.default);
        expect(defaults.length).toBe(models.length ? 1 : 0);
      }
    });

    it("keeps each model's flags consistent with its kind", () => {
      for (const model of definition.models) {
        if (model.mask) expect(model.edit).toBe(true);
        if (model.kind === "image") {
          expect(model.startFrame ?? model.endFrame ?? model.audio).toBeUndefined();
          expect(model.durationSeconds).toBeUndefined();
        } else {
          expect(model.edit ?? model.mask).toBeUndefined();
          if (model.durationSeconds)
            expect(model.durationSeconds.min).toBeLessThanOrEqual(model.durationSeconds.max);
        }
      }
    });

    it("can be connected some way, with unique field names", () => {
      const names = definition.catalog.fields.map((field) => field.name);
      expect(new Set(names).size).toBe(names.length);
      expect(credentials(definition).length).toBeGreaterThan(0);
      expect(definition.catalog.name.trim()).not.toBe("");
    });

    it.each([0, 1, 2])("builds a provider from credential %i without a request", (index) => {
      const credential = credentials(definition)[index];
      if (!credential) return;
      const fetch = vi.fn<typeof globalThis.fetch>();
      const provider = definition.create(credential, { fetch });
      expect(fetch).not.toHaveBeenCalled();
      expect(provider.id).toBe(id);
      const models = definition.modelsFor?.(credential) ?? definition.models;
      expect(provider.capabilities).toMatchObject({
        images: models.some((model) => model.kind === "image"),
        video: models.some((model) => model.kind === "video"),
        offline: false,
      });
      expect(Boolean(provider.capabilities.imageEdit)).toBe(models.some((model) => model.edit));
      expect(typeof provider.editImage === "function").toBe(
        Boolean(provider.capabilities.imageEdit),
      );
    });

    it("refuses a credential it cannot use", () => {
      expect(() =>
        definition.create(
          {
            kind: "model_connection",
            provider: "not-a-provider",
            auth: "api_key",
            token: "fake-token",
          },
          {},
        ),
      ).toThrow();
      expect(() => definition.create({ kind: "key", fields: {} }, {})).toThrow();
    });

    it("answers a subset of its models for each credential", () => {
      for (const credential of credentials(definition)) {
        const models = definition.modelsFor?.(credential) ?? definition.models;
        for (const model of models) expect(definition.models).toContain(model);
      }
    });
  });
});
