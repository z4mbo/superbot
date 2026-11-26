// @vitest-environment jsdom
import type { CommunityTemplateSubmission } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  communityTemplates: { queue: vi.fn(), review: vi.fn(), unlist: vi.fn(), list: vi.fn() },
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
    i18n: { locale: "en" },
  }),
}));
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Box,
    DialogFooter: Box,
    DialogHeader: Box,
    DialogTitle: Box,
    SectionHeading: Box,
    Spinner: () => <span role="status" />,
    Tabs: Box,
    TabsList: Box,
    TabsTrigger: Box,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    toast: { error: vi.fn(), success: vi.fn() },
  };
});

import { CommunityTemplatesReviewPanel } from "./CommunityTemplatesReviewPanel";

const pending: CommunityTemplateSubmission = {
  id: "submission-1",
  slug: "topic-digest",
  version: 2,
  status: "pending",
  reason: null,
  author: "Ana Author",
  createdAt: "2026-11-01T00:00:00.000Z",
  reviewedAt: null,
  recipe: {
    name: "Topic digest",
    category: "research",
    summary: "What changed on topics you follow",
    sample: "<img src=x onerror=alert(1)>",
    description: "Weekly digest",
    instructions: "Report only what is new.",
    skills: [{ name: "Topic watch", description: "Check topics.", body: "1. Search the web." }],
    routines: [{ name: "Weekly digest", prompt: "Send the digest.", crons: ["0 9 * * 1"] }],
    apps: ["gmail"],
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const call of Object.values(api.communityTemplates)) call.mockReset();
  api.communityTemplates.queue.mockResolvedValue([pending]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CommunityTemplatesReviewPanel />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="community-template-submission"]')).toBeTruthy(),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);

it("shows every field that would be listed or installed, as plain text", () => {
  const item = container.querySelector('[data-testid="community-template-submission"]')!;
  for (const text of [
    "Topic digest",
    "Ana Author",
    "Version 2",
    "Research",
    "What changed on topics you follow",
    "Weekly digest",
    "Report only what is new.",
    "Skill: Topic watch",
    "1. Search the web.",
    "Send the digest.",
    "gmail",
  ]) {
    expect(item.textContent).toContain(text);
  }
  // Markup in a recipe is shown, never rendered.
  expect(item.querySelector("img")).toBeNull();
  expect(item.textContent).toContain("<img src=x onerror=alert(1)>");
});

it("approves, and rejects only with a reason", async () => {
  api.communityTemplates.review.mockResolvedValue({ ...pending, status: "approved" });
  await act(async () => button("Approve")!.click());
  await vi.waitFor(() =>
    expect(api.communityTemplates.review).toHaveBeenCalledWith({
      id: "submission-1",
      decision: "approve",
    }),
  );

  await vi.waitFor(() => expect(button("Reject")?.disabled).toBe(false));
  await act(async () => button("Reject")!.click());
  const dialog = container.querySelector('[role="dialog"]')!;
  const submit = [...dialog.querySelectorAll("button")].find(
    (node) => node.textContent === "Reject",
  )!;
  expect(submit.disabled).toBe(true);
  const reason = dialog.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      reason,
      "Add a real example.",
    );
    reason.dispatchEvent(new Event("input", { bubbles: true }));
  });
  api.communityTemplates.review.mockResolvedValue({ ...pending, status: "rejected" });
  await act(async () => dialog.querySelector("form")!.requestSubmit());
  await vi.waitFor(() =>
    expect(api.communityTemplates.review).toHaveBeenLastCalledWith({
      id: "submission-1",
      decision: "reject",
      reason: "Add a real example.",
    }),
  );
});
