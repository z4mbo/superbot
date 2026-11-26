import type { MediaCatalog, MediaProviderEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_MEDIA,
  mediaChoiceOptions,
  mediaChoiceValue,
  mediaIncludedWith,
  mediaKindAvailable,
  parseMediaChoice,
  selectedMediaChoice,
} from "./media-choices";

const none = { image: false, imageEdit: false, video: false };

function provider(id: string, patch: Partial<MediaProviderEntry> = {}): MediaProviderEntry {
  return {
    id,
    name: `Provider ${id.toUpperCase()}`,
    fields: [{ name: "apiKey", label: "API key", secret: true }],
    modelConnections: [],
    connected: false,
    source: null,
    hints: {},
    capabilities: none,
    models: [
      { id: `${id}-image`, name: `${id} image`, kind: "image", default: true },
      { id: `${id}-video`, name: `${id} video`, kind: "video", default: true },
    ],
    customModels: false,
    ...patch,
  };
}

function catalog(providers: MediaProviderEntry[], patch: Partial<MediaCatalog> = {}): MediaCatalog {
  return { providers, preference: { image: null, video: null }, server: null, ...patch };
}

const connectedImageOnly = provider("a", {
  connected: true,
  source: "key",
  capabilities: { image: true, imageEdit: false, video: false },
  models: [{ id: "a-image", name: "A image", kind: "image", default: true }],
});
const notConnected = provider("b");

describe("media choices", () => {
  it("offers Automatic first, then each model of a connected provider that makes the kind", () => {
    const options = mediaChoiceOptions(catalog([connectedImageOnly, notConnected]), "image");
    expect(options[0]).toMatchObject({ value: AUTOMATIC_MEDIA, provider: null });
    expect(options[1]).toMatchObject({
      value: mediaChoiceValue("a", "a-image"),
      providerName: "Provider A",
      modelName: "A image",
    });
    expect(options[1]?.unavailable).toBeUndefined();
  });

  it("lists providers that are not connected, or cannot make the kind, as unavailable", () => {
    const image = mediaChoiceOptions(catalog([connectedImageOnly, notConnected]), "image");
    expect(image.at(-1)).toMatchObject({ provider: "b", unavailable: "not_connected" });
    const video = mediaChoiceOptions(catalog([connectedImageOnly, notConnected]), "video");
    expect(video.map((option) => [option.provider, option.unavailable])).toEqual([
      [null, undefined],
      ["a", "cannot_make"],
      ["b", "not_connected"],
    ]);
  });

  it("leaves out a provider that could not make the kind even once connected", () => {
    const imagesOnly = provider("c", {
      models: [{ id: "c-image", name: "C image", kind: "image" }],
    });
    expect(
      mediaChoiceOptions(catalog([imagesOnly]), "video").map((option) => option.provider),
    ).toEqual([null]);
  });

  it("says a kind is available through a connected provider or the server's own setup", () => {
    expect(mediaKindAvailable(catalog([notConnected]), "image")).toBe(false);
    expect(mediaKindAvailable(catalog([connectedImageOnly]), "image")).toBe(true);
    expect(mediaKindAvailable(catalog([connectedImageOnly]), "video")).toBe(false);
    const server = { image: false, imageEdit: false, video: true };
    expect(mediaKindAvailable(catalog([], { server }), "video")).toBe(true);
  });

  it("shows the saved choice, its default model when none was named, and Automatic without one", () => {
    expect(selectedMediaChoice(catalog([connectedImageOnly]), "image")).toBe(AUTOMATIC_MEDIA);
    const saved = catalog([connectedImageOnly], {
      preference: { image: { provider: "a", model: null }, video: null },
    });
    expect(selectedMediaChoice(saved, "image")).toBe(mediaChoiceValue("a", "a-image"));
  });

  it("shows a saved choice that no longer works as unavailable rather than as working", () => {
    const saved = catalog([notConnected], {
      preference: { image: { provider: "b", model: "b-image" }, video: null },
    });
    const value = selectedMediaChoice(saved, "image");
    const option = mediaChoiceOptions(saved, "image").find((entry) => entry.value === value);
    expect(option?.unavailable).toBe("not_connected");
  });

  it("keeps a saved model beyond the listed ones where the provider takes them", () => {
    const custom = { ...connectedImageOnly, customModels: true };
    const saved = catalog([custom], {
      preference: { image: { provider: "a", model: "a-custom" }, video: null },
    });
    expect(selectedMediaChoice(saved, "image")).toBe(mediaChoiceValue("a", "a-custom"));
  });

  it("round-trips a choice and reads Automatic as no choice", () => {
    expect(parseMediaChoice(mediaChoiceValue("a", "a-image"))).toEqual({
      provider: "a",
      model: "a-image",
    });
    expect(parseMediaChoice(mediaChoiceValue("a", null))).toEqual({ provider: "a", model: null });
    expect(parseMediaChoice(AUTOMATIC_MEDIA)).toBeNull();
  });
});

describe("media a model connection includes", () => {
  const borrowed = provider("lent", {
    fields: [],
    modelConnections: ["model-provider-x"],
    connected: true,
    source: "model_connection",
    capabilities: { image: true, imageEdit: true, video: false },
  });

  it("reads it from a media provider connected through that model connection", () => {
    expect(mediaIncludedWith(catalog([borrowed]), "model-provider-x")).toEqual({
      image: true,
      imageEdit: true,
      video: false,
    });
  });

  it("says nothing for another provider, a saved key, or a connection that lends nothing", () => {
    expect(mediaIncludedWith(catalog([borrowed]), "model-provider-y")).toBeNull();
    expect(
      mediaIncludedWith(catalog([{ ...borrowed, source: "key" }]), "model-provider-x"),
    ).toBeNull();
    expect(
      mediaIncludedWith(catalog([{ ...borrowed, capabilities: none }]), "model-provider-x"),
    ).toBeNull();
    expect(mediaIncludedWith(undefined, "model-provider-x")).toBeNull();
  });
});
