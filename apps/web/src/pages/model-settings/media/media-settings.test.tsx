// @vitest-environment jsdom

import type { MediaCatalog, MediaProviderEntry } from "@rakazo/contracts";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryRoot } from "../../../lib/query/query-root.test-support";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const client = vi.hoisted(() => ({
  media: {
    catalog: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(async () => ({ ok: true as const })),
    setPreference: vi.fn(),
  },
}));
vi.mock("../../../lib/query/rpc", () => ({
  rpc: client,
  rpcForSpace: () => client,
  createSpaceRpc: () => client,
  selectedSpaceId: () => null,
}));

import { MediaSettings } from "./media-settings";

const none = { image: false, imageEdit: false, video: false };

function provider(patch: Partial<MediaProviderEntry>): MediaProviderEntry {
  return {
    id: "keyed",
    name: "Keyed",
    fields: [
      { name: "keyId", label: "Key ID", secret: false },
      { name: "apiKey", label: "API key", secret: true },
    ],
    modelConnections: [],
    connected: false,
    source: null,
    hints: {},
    capabilities: none,
    models: [{ id: "keyed-image", name: "Keyed image", kind: "image", default: true }],
    customModels: false,
    ...patch,
  };
}

const savedKey = provider({
  connected: true,
  source: "key",
  hints: { keyId: "key-123" },
  capabilities: { image: true, imageEdit: false, video: false },
});

function catalog(providers: MediaProviderEntry[], server: MediaCatalog["server"] = null) {
  return { providers, preference: { image: null, video: null }, server } satisfies MediaCatalog;
}

let host: HTMLDivElement;
let root: ReturnType<typeof createQueryRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView ??= () => {};
  host = document.body.appendChild(document.createElement("div"));
  root = createQueryRoot(host, new QueryClient({ defaultOptions: { queries: { retry: false } } }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render(initial: MediaCatalog) {
  client.media.catalog.mockResolvedValue(initial);
  await act(async () => root.render(<MediaSettings modelProviderName={(id) => `Model ${id}`} />));
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="media-settings"]')).not.toBeNull(),
  );
}

function button(name: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === name || element.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function rowButton(provider: string) {
  const found = host.querySelector(`[data-testid="media-provider-${provider}"] button`);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no row ${provider}`);
  return found;
}

function input(label: string) {
  const forLabel = [...document.querySelectorAll("label")].find(
    (element) => element.textContent === label,
  );
  const field = forLabel && document.getElementById(forLabel.htmlFor);
  if (!(field instanceof HTMLInputElement)) throw new Error(`no field ${label}`);
  return field;
}

async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

it("says plainly when nothing can make images or video, and offers no chooser", async () => {
  await render(catalog([provider({})]));
  expect(host.querySelector('[data-testid="media-unavailable"]')?.textContent).toBe(
    "Unavailable until you add a provider.",
  );
  expect(host.querySelector('[data-testid="media-choice-image"]')).toBeNull();
});

it("offers both choosers once something can make media, the server's setup included", async () => {
  await render(catalog([provider({})], { image: true, imageEdit: false, video: false }));
  expect(host.querySelector('[data-testid="media-unavailable"]')).toBeNull();
  const images = host.querySelector('[data-testid="media-choice-image"]');
  const video = host.querySelector('[data-testid="media-choice-video"]');
  expect(images?.textContent).toBe("Automatic");
  // Nothing makes video, so its chooser says so and cannot be opened.
  expect(video?.textContent).toBe("Unavailable");
  expect(video?.hasAttribute("disabled") || video?.getAttribute("data-disabled") !== null).toBe(
    true,
  );
});

it("connects a provider with every field its form asks for, the secret masked", async () => {
  await render(catalog([provider({})]));
  client.media.connect.mockResolvedValue(savedKey);
  client.media.catalog.mockResolvedValue(catalog([savedKey]));
  await click(button("Add provider"));
  const option = await vi.waitFor(() => {
    const found = [...document.querySelectorAll('[role="option"]')].find(
      (element) => element.textContent === "Keyed",
    );
    if (!(found instanceof HTMLElement)) throw new Error("no option");
    return found;
  });
  await click(option);
  expect(input("API key").type).toBe("password");
  await type(input("Key ID"), "key-123");
  await type(input("API key"), "fake-secret");
  await click(button("Save"));
  expect(client.media.connect).toHaveBeenCalledWith({
    provider: "keyed",
    fields: { keyId: "key-123", apiKey: "fake-secret" },
  });
  await vi.waitFor(() => expect(host.querySelector('[data-testid="media-key-form"]')).toBeNull());
  expect(host.querySelector('[data-testid="media-provider-keyed"]')?.textContent).toContain(
    "key-123",
  );
});

it("replaces a saved key keeping a blank secret, and never shows the saved one", async () => {
  await render(catalog([savedKey]));
  client.media.connect.mockResolvedValue(savedKey);
  await click(rowButton("keyed"));
  const secret = input("API key");
  expect(secret.value).toBe("");
  expect(secret.placeholder).toBe("Saved");
  expect(input("Key ID").value).toBe("key-123");
  await type(input("Key ID"), "key-456");
  await click(button("Save"));
  expect(client.media.connect).toHaveBeenCalledWith({
    provider: "keyed",
    fields: { keyId: "key-456", apiKey: "" },
  });
});

it("removes a saved key", async () => {
  await render(catalog([savedKey]));
  client.media.catalog.mockResolvedValue(catalog([provider({})]));
  await click(rowButton("keyed"));
  await click(button("Remove"));
  expect(client.media.disconnect).toHaveBeenCalledWith({ provider: "keyed" });
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="media-provider-keyed"]')).toBeNull(),
  );
});

it("shows a provider that borrows a model connection as connected with nothing to paste", async () => {
  const borrowed = provider({
    id: "borrowed",
    name: "Borrowed",
    fields: [],
    modelConnections: ["provider-x"],
    connected: true,
    source: "model_connection",
    capabilities: { image: true, imageEdit: true, video: false },
  });
  await render(catalog([borrowed]));
  const row = host.querySelector('[data-testid="media-provider-borrowed"]');
  expect(row?.textContent).toContain("Via Model provider-x");
  expect(row?.querySelector("button")).toBeNull();
  // Nothing else to connect, so there is no Add provider row either.
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Add provider")).toBe(
    false,
  );
});
