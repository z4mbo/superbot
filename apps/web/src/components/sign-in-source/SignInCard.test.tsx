// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { RakazoDesktop, SignInBlock } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { QueryClient } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";
import { SignInCard } from "./SignInCard";

const signInSource = vi.hoisted(() => ({ review: vi.fn(), connect: vi.fn() }));
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
  cn: (...names: unknown[]) => names.filter(Boolean).join(" "),
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));

const LINK = "https://sign-in.emulator.invalid/approve?ref=a%2Fb&x=%7E";
const pending: SignInBlock = {
  kind: "sign_in",
  site: "https://login.example.test",
  label: "Emulator Passwords",
  status: "pending",
  requestId: "request-1",
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
  root = createRoot(host, new QueryClient());
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.rakazoDesktop;
  vi.unstubAllGlobals();
});

async function render(block: SignInBlock, canAct = true) {
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <SignInCard block={block} canAct={canAct} />
      </I18nProvider>,
    ),
  );
}

const button = (name: string) =>
  [...host.querySelectorAll("button")].find((entry) => entry.textContent === name);

it("asks the person to review the request in the provider named by the server", async () => {
  signInSource.review.mockResolvedValue({ approvalLink: LINK });
  await render(pending);
  expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
    "Sign in to login.example.test",
  );
  expect(host.textContent).toContain("Sign in with Emulator Passwords");
  await act(async () => button("Review in Emulator Passwords")?.click());
  await act(flush);
  expect(signInSource.review).toHaveBeenCalledWith({ requestId: "request-1" });
  // The link opens exactly as the server returned it.
  expect(opened).toHaveBeenCalledWith(LINK, "_blank", "noopener,noreferrer");
});

it("says why the review could not open", async () => {
  signInSource.review.mockRejectedValue(new Error("This sign-in request is closed."));
  await render(pending);
  await act(async () => button("Review in Emulator Passwords")?.click());
  await act(flush);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("This sign-in request is closed.");
  expect(opened).not.toHaveBeenCalled();
});

it("offers to connect when nothing is connected", async () => {
  signInSource.connect.mockResolvedValue({ authorizeUrl: "https://app.example.test/connect" });
  await render({ ...pending, status: "needs_connection", requestId: undefined });
  expect(host.textContent).toContain("No password manager connected");
  await act(async () => button("Connect Emulator Passwords")?.click());
  await act(flush);
  expect(signInSource.connect).toHaveBeenCalled();
  expect(opened).toHaveBeenCalledWith(
    "https://app.example.test/connect",
    "_blank",
    "noopener,noreferrer",
  );
});

it("shows what became of the request, with nothing left to press", async () => {
  for (const [status, text] of [
    ["approved", "Approved"],
    ["denied", "Declined"],
    ["expired", "Expired"],
    ["failed", "Couldn't finish"],
  ] as const) {
    await render({ ...pending, status });
    expect(host.textContent).toContain(text);
    expect(host.querySelector("button")).toBeNull();
  }
});

it("offers nothing to someone who can't act, and sends the desktop app's person elsewhere", async () => {
  await render(pending, false);
  expect(host.querySelector("button")).toBeNull();
  window.rakazoDesktop = { platform: "darwin" } as RakazoDesktop;
  await render(pending);
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toContain("Review on your phone or in a browser");
});
