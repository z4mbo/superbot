// @vitest-environment jsdom
import type { OrganizationMembers } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { organizations, toast } = vi.hoisted(() => ({
  organizations: {
    list: vi.fn(),
    members: { list: vi.fn(), setRole: vi.fn(), remove: vi.fn() },
    invitations: { create: vi.fn(), cancel: vi.fn() },
  },
  toast: vi.fn(),
}));
vi.mock("../../lib/query/rpc", async (original) => {
  const client = { organizations };
  return {
    ...((await original()) as object),
    rpc: client,
    createSpaceRpc: () => client,
    rpcForSpace: () => client,
    selectedSpaceId: () => "space-work",
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", async () => {
  const actual = await vi.importActual<typeof import("@rakazo/ui-web")>("@rakazo/ui-web");
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const PlainButton = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  );
  return {
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Button: PlainButton,
    CopyTextFallback: ({ open, text, label }: { open: boolean; text: string; label: string }) =>
      open ? <textarea aria-label={`Copy ${label}`} readOnly value={text} /> : null,
    DropdownMenu: Box,
    DropdownMenuContent: Box,
    DropdownMenuItem: PlainButton,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: () => null,
    Input: ({ size: _size, ...props }: ComponentProps<"input"> & { size?: string }) => (
      <input {...props} />
    ),
    InputGroup: Box,
    InputGroupAddon: Box,
    InputGroupButton: PlainButton,
    InputGroupInput: (props: ComponentProps<"input">) => <input {...props} />,
    cn: actual.cn,
    toast,
    // The real copy, so a refused clipboard opens the fallback as it does in the app.
    useCopyText: actual.useCopyText,
    writeClipboard: actual.writeClipboard,
  };
});
vi.mock("../../lib/auth/auth", () => ({ authClient: { $store: { notify: vi.fn() } } }));

import { QueryClientProvider } from "@tanstack/react-query";
import { QueryUserProvider, queryClient } from "../../lib/query/query";
import { SpaceRpcProvider } from "../../lib/query/space-rpc";
import { OrganizationMembersSettings } from "./OrganizationMembersSettings";

const organization = {
  id: "org-work",
  name: "Work",
  defaultSpaceId: "space-work",
  spaceIds: ["space-work"],
  canManage: true,
  role: "owner" as const,
  memberCount: 1,
};
const owner = {
  userId: "user-owner",
  name: "Ada Lovelace",
  email: "ada@example.test",
  image: null,
  role: "owner" as const,
  manageable: false,
  roleChangeable: false,
};
const url = "https://app.example.test/join/invitation-1";

let container: HTMLDivElement;
let root: Root;
const writeText = vi.fn(async (_text: string) => undefined);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  organizations.list.mockResolvedValue({
    organizations: [organization],
    activeOrganizationId: organization.id,
  });
  organizations.members.list.mockResolvedValue({
    canManage: true,
    members: [owner],
    invitations: [],
  } satisfies OrganizationMembers);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <QueryUserProvider value="user-owner">
          <SpaceRpcProvider spaceId="space-work">
            <OrganizationMembersSettings organization={organization} onBack={() => undefined} />
          </SpaceRpcProvider>
        </QueryUserProvider>
      </QueryClientProvider>,
    ),
  );
  await act(flush);
}

async function invite(address: string) {
  const field = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, address);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => field.form?.requestSubmit());
  await act(flush);
}

const status = () => container.querySelector('[role="status"]')?.textContent;
const linkField = () =>
  container.querySelector<HTMLInputElement>('input[aria-label="Invite link"]');
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (each) => each.textContent === label || each.getAttribute("aria-label") === label,
  );

it("says the invitation was emailed and keeps its link to copy", async () => {
  organizations.invitations.create.mockResolvedValue({ url, emailed: true });
  await render();
  await invite("cy@example.test");

  expect(organizations.invitations.create).toHaveBeenCalledWith({
    organizationId: "org-work",
    email: "cy@example.test",
  });
  expect(status()).toBe("Invitation emailed to cy@example.test.");
  expect(linkField()?.value).toBe(url);
  expect(linkField()?.readOnly).toBe(true);
  expect(writeText).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();

  await act(async () => button("Copy invite link")?.click());
  await act(flush);
  expect(writeText).toHaveBeenCalledWith(url);
});

it.each([
  ["not_configured", "Not emailed to cy@example.test: email isn't set up on this server."],
  ["send_failed", "Not emailed to cy@example.test: sending failed."],
  ["unverified_inviter", "Not emailed to cy@example.test: verify your email address first."],
  ["rate_limited", "Not emailed to cy@example.test: daily invitation limit reached."],
  // A server from before the reason was sent.
  [undefined, "Not emailed to cy@example.test."],
])("says why the invitation was not emailed (%s) and offers its link", async (reason, text) => {
  organizations.invitations.create.mockResolvedValue({
    url,
    emailed: false,
    ...(reason ? { notEmailedReason: reason } : {}),
  });
  await render();
  await invite("cy@example.test");

  expect(status()).toBe(text);
  expect(linkField()?.value).toBe(url);
  expect(toast).not.toHaveBeenCalledWith("Invite link copied");
});

it("offers the link to copy by hand when the browser refuses to copy it", async () => {
  writeText.mockRejectedValueOnce(new Error("denied"));
  organizations.invitations.create.mockResolvedValue({
    url,
    emailed: false,
    notEmailedReason: "not_configured",
  });
  await render();
  await invite("cy@example.test");

  await act(async () => button("Copy invite link")?.click());
  await vi.waitFor(() =>
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Copy Invite link"]')
        ?.value,
    ).toBe(url),
  );
});

it("drops the notice once its invitation is cancelled", async () => {
  organizations.invitations.create.mockResolvedValue({
    url,
    emailed: false,
    notEmailedReason: "send_failed",
  });
  await render();
  organizations.members.list.mockResolvedValue({
    canManage: true,
    members: [owner],
    invitations: [{ id: "invitation-1", email: "cy@example.test", url, expiresAt: "2030-01-01" }],
  } satisfies OrganizationMembers);
  await invite("cy@example.test");
  expect(status()).toBe("Not emailed to cy@example.test: sending failed.");

  organizations.invitations.cancel.mockResolvedValue({ ok: true });
  await act(async () => button("Cancel invitation")?.click());
  await act(flush);
  expect(organizations.invitations.cancel).toHaveBeenCalledWith({
    organizationId: "org-work",
    invitationId: "invitation-1",
  });
  expect(status()).toBeUndefined();
  expect(linkField()).toBeNull();
});
