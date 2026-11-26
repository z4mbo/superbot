// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  researchKeys: { list: vi.fn(), save: vi.fn(), remove: vi.fn() },
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc: rpcMock,
  rpcForSpace: () => rpcMock,
  createSpaceRpc: () => rpcMock,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: ({ size: _size, ...props }: Omit<ComponentProps<"input">, "size"> & { size?: string }) => (
    <input {...props} />
  ),
}));

import { QueryUserProvider } from "../../lib/query/query";
import { ResearchKeySettings } from "./ResearchKeySettings";

const providers = (saved: { search: boolean; page: boolean }) => [
  { id: "search-provider", label: "Search Co", capability: "search", saved: saved.search },
  { id: "page-provider", label: "Page Co", capability: "page_read", saved: saved.page },
];

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value="user-1">
          <ResearchKeySettings />
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    button: (label: string) =>
      [...container.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === label || button.textContent === label,
      ),
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function input(container: HTMLElement, label: string) {
  const field = [...container.querySelectorAll("label")].find((node) => node.textContent === label);
  return field ? container.querySelector<HTMLInputElement>(`#${CSS.escape(field.htmlFor)}`) : null;
}

it("lists each provider the server sends and saves a typed key", async () => {
  rpcMock.researchKeys.list
    .mockResolvedValueOnce(providers({ search: false, page: false }))
    .mockResolvedValue(providers({ search: true, page: false }));
  rpcMock.researchKeys.save.mockResolvedValue(providers({ search: true, page: false }));
  const view = await render();
  await vi.waitFor(() => expect(view.button("Add Search Co API key")).toBeTruthy());
  expect(view.button("Add Page Co API key")).toBeTruthy();
  expect(view.container.textContent).toContain("Web research");
  // Read first: no input until the person chooses to add a key.
  expect(view.container.querySelector("input")).toBeNull();

  await act(async () => view.button("Add Search Co API key")?.click());
  const field = input(view.container, "Search Co API key")!;
  expect(field.type).toBe("password");
  await type(field, "  fake-typed-key  ");
  await act(async () => field.closest("form")!.requestSubmit());
  expect(rpcMock.researchKeys.save).toHaveBeenCalledWith({
    provider: "search-provider",
    key: "fake-typed-key",
  });
  await vi.waitFor(() => expect(view.button("Replace Search Co API key")).toBeTruthy());
  expect(view.container.textContent).toContain("Saved");
  expect(view.container.innerHTML).not.toContain("fake-typed-key");
  await view.cleanup();
});

it("replaces or removes a saved key without ever showing it", async () => {
  rpcMock.researchKeys.list.mockResolvedValue(providers({ search: false, page: true }));
  rpcMock.researchKeys.remove.mockResolvedValue(providers({ search: false, page: false }));
  const view = await render();
  await vi.waitFor(() => expect(view.button("Replace Page Co API key")).toBeTruthy());
  expect(view.button("Remove Page Co API key")).toBeUndefined();

  await act(async () => view.button("Replace Page Co API key")?.click());
  expect(input(view.container, "Page Co API key")?.value).toBe("");
  await act(async () => view.button("Cancel")?.click());
  expect(input(view.container, "Page Co API key")).toBeNull();

  await act(async () => view.button("Replace Page Co API key")?.click());
  await act(async () => view.button("Remove Page Co API key")?.click());
  expect(rpcMock.researchKeys.remove).toHaveBeenCalledWith({ provider: "page-provider" });
  expect(rpcMock.researchKeys.save).not.toHaveBeenCalled();
  await view.cleanup();
});

it("shows the server's refusal in the form", async () => {
  rpcMock.researchKeys.list.mockResolvedValue(providers({ search: false, page: false }));
  rpcMock.researchKeys.save.mockRejectedValue(
    new Error("Enter the key without spaces or line breaks."),
  );
  const view = await render();
  await vi.waitFor(() => expect(view.button("Add Search Co API key")).toBeTruthy());
  await act(async () => view.button("Add Search Co API key")?.click());
  const field = input(view.container, "Search Co API key")!;
  await type(field, "fake key");
  await act(async () => field.closest("form")!.requestSubmit());
  await vi.waitFor(() => expect(view.container.querySelector("[role=alert]")).not.toBeNull());
  expect(input(view.container, "Search Co API key")).not.toBeNull();
  await view.cleanup();
});

it("shows nothing when the server offers no provider", async () => {
  rpcMock.researchKeys.list.mockResolvedValue([]);
  const view = await render();
  await vi.waitFor(() => expect(rpcMock.researchKeys.list).toHaveBeenCalled());
  expect(view.container.innerHTML).toBe("");
  await view.cleanup();
});
