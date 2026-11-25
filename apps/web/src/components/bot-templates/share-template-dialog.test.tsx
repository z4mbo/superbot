// @vitest-environment jsdom
import type { CommunityTemplateDraft } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  communityTemplates: { draft: vi.fn(), submit: vi.fn(), mine: vi.fn() },
  connections: { catalog: vi.fn(async () => [{ slug: "gmail", name: "Gmail", connected: true }]) },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
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
    Dialog: Box,
    DialogContent: Box,
    DialogDescription: Box,
    DialogFooter: Box,
    DialogHeader: Box,
    DialogTitle: Box,
    Field: Box,
    FieldGroup: Box,
    FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    OptionSelect: ({
      id,
      value,
      options,
      onValueChange,
    }: {
      id?: string;
      value: string | null;
      options: { value: string; label: string }[];
      onValueChange: (value: string) => void;
    }) => (
      <select id={id} value={value ?? ""} onChange={(event) => onValueChange(event.target.value)}>
        <option value="" />
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
    SectionHeading: Box,
    Spinner: () => <span role="status" />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    toast,
  };
});

import { ShareTemplateDialog } from "./share-template-dialog";

const draft: CommunityTemplateDraft = {
  name: "Weekly digest",
  category: null,
  summary: "",
  sample: "",
  description: "Weekly digest",
  instructions: "You write a weekly digest. Use @Weekly report.",
  skills: [
    { name: "Weekly report", description: "Write the report.", body: "1. Gather.\n2. Write." },
    { name: "Inbox sweep", description: "Sweep the inbox.", body: "Archive old mail." },
  ],
  routines: [{ name: "Friday digest", prompt: "Send it.", crons: ["0 9 * * 5"] }],
  apps: ["gmail"],
};

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const call of Object.values(api.communityTemplates)) call.mockReset();
  onClose.mockReset();
  toast.success.mockReset();
  api.communityTemplates.draft.mockResolvedValue(draft);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ShareTemplateDialog botId="bot-1" onClose={onClose} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector("form")).toBeTruthy());
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const field = <T extends HTMLElement>(label: string) => {
  const target = [...container.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  );
  return container.querySelector<T>(`#${CSS.escape(target!.htmlFor)}`)!;
};
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name || node.getAttribute("aria-label") === name,
  );
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = Object.getPrototypeOf(element);
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("shows the whole draft read from the bot, ready to edit", async () => {
  expect(api.communityTemplates.draft.mock.calls[0]?.[0]).toEqual({ botId: "bot-1" });
  expect(field<HTMLInputElement>("Name").value).toBe("Weekly digest");
  expect(field<HTMLTextAreaElement>("Instructions").value).toBe(draft.instructions);
  for (const shown of ["Weekly report", "Inbox sweep", "Friday digest"]) {
    expect(container.innerHTML).toContain(shown);
  }
  // Apps show by name once the catalog is read.
  await vi.waitFor(() => expect(container.textContent).toContain("Gmail"));
  expect(container.textContent).toContain("Keys, memory, chats and settings aren't included.");
});

it("submits only once everything a template needs is filled, with the edits and removals made", async () => {
  const submit = button("Submit for review")!;
  expect(submit.disabled).toBe(true);

  await act(async () => {
    const select = field<HTMLSelectElement>("Category");
    select.value = "research";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await type(field("Summary"), "A weekly digest of what changed");
  await type(field("Example message"), "**This week**");
  expect(submit.disabled).toBe(false);

  await type(field("Instructions"), "You write a short weekly digest.");
  await act(async () => button("Remove Inbox sweep")!.click());
  await act(async () => button("Remove Gmail")!.click());
  api.communityTemplates.submit.mockResolvedValue({ id: "submission-1" });
  await act(async () => container.querySelector("form")!.requestSubmit());

  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(api.communityTemplates.submit).toHaveBeenCalledExactlyOnceWith({
    botId: "bot-1",
    recipe: {
      ...draft,
      category: "research",
      summary: "A weekly digest of what changed",
      sample: "**This week**",
      instructions: "You write a short weekly digest.",
      skills: [draft.skills[0]],
      apps: [],
    },
  });
  expect(toast.success).toHaveBeenCalledWith("Sent for review");
});

it("says why a submission was refused and keeps the form", async () => {
  await act(async () => {
    const select = field<HTMLSelectElement>("Category");
    select.value = "research";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await type(field("Summary"), "A digest");
  await type(field("Example message"), "Example");
  api.communityTemplates.submit.mockRejectedValue(
    Object.assign(new Error("Another agent already has this name. Pick another."), {
      code: "CONFLICT",
    }),
  );
  await act(async () => container.querySelector("form")!.requestSubmit());
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Another agent already has this name."),
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(field<HTMLInputElement>("Summary").value).toBe("A digest");
});
