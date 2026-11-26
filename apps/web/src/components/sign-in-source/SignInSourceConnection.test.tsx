// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { SignInSourceState } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { QueryClient } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";
import { SignInSourceConnection } from "./SignInSourceConnection";

const signInSource = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("../../lib/query/rpc", () => {
  const rpc = { signInSource };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("../ConfirmDialog", () => ({
  ConfirmDialog: ({ title, onConfirm }: { title: string; onConfirm: () => void }) => (
    <div role="dialog" aria-label={title}>
      <button type="button" onClick={onConfirm}>
        Confirm
      </button>
    </div>
  ),
}));

const source: SignInSourceState = {
  id: "emulator",
  label: "Emulator Passwords",
  connectable: true,
  status: "disconnected",
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let opened: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  vi.clearAllMocks();
  opened = vi.fn();
  vi.stubGlobal("open", opened);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host, new QueryClient({ defaultOptions: { queries: { retry: false } } }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <SignInSourceConnection />
      </I18nProvider>,
    ),
  );
  await act(flush);
}

const button = (name: string) =>
  [...host.querySelectorAll("button")].find((entry) => entry.textContent === name);

it("shows nothing when the server offers no sign-in source", async () => {
  signInSource.status.mockResolvedValue(null);
  await render();
  expect(host.innerHTML).toBe("");
});

it("names the provider the server sends and connects it", async () => {
  signInSource.status.mockResolvedValue(source);
  signInSource.connect.mockResolvedValue({ authorizeUrl: "https://app.example.test/connect" });
  await render();
  expect(host.textContent).toContain("Emulator Passwords");
  expect(host.textContent).toContain("Let bots sign in with logins you approve");
  await act(async () => button("Connect")?.click());
  await act(flush);
  expect(signInSource.connect).toHaveBeenCalled();
  expect(opened).toHaveBeenCalledWith(
    "https://app.example.test/connect",
    "_blank",
    "noopener,noreferrer",
  );
});

it("says it is not available yet while the server cannot connect it", async () => {
  signInSource.status.mockResolvedValue({ ...source, connectable: false });
  await render();
  expect(host.textContent).toContain("Not available yet");
  expect(host.querySelector("button")).toBeNull();
});

it("disconnects after confirming", async () => {
  signInSource.status.mockResolvedValue({
    ...source,
    status: "connected",
    connectedAt: "2026-11-01T10:00:00.000Z",
  });
  signInSource.disconnect.mockResolvedValue(source);
  await render();
  expect(host.textContent).toContain("Bots sign in with logins you approve");
  await act(async () => button("Disconnect")?.click());
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
    "Disconnect Emulator Passwords?",
  );
  await act(async () => button("Confirm")?.click());
  await act(flush);
  expect(signInSource.disconnect).toHaveBeenCalled();
  expect(host.querySelector('[data-testid="sign-in-source"]')?.getAttribute("data-status")).toBe(
    "disconnected",
  );
});

it("asks to connect again when the provider dropped the connection", async () => {
  signInSource.status.mockResolvedValue({ ...source, status: "needs_reconnect" });
  await render();
  expect(host.textContent).toContain("Connect again to keep signing in");
  expect(button("Connect")).toBeDefined();
});
