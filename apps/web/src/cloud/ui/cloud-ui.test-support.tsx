import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext } from "react";
import { vi } from "vitest";
import type { CloudAccountState, CloudAccounts } from "../accounts/cloud-accounts";
import type { Workspaces } from "../workspaces/use-workspaces";
import type { CloudWorkspace } from "../workspaces/workspace-directory";
import type { WorkspaceStatus } from "../workspaces/workspace-status";

export const ISSUER = "https://accounts.example.test";

export function workspace(id: string, name: string, url: string): CloudWorkspace {
  return { id, name, url, kind: "self-hosted", addedAt: "2026-11-01T00:00:00.000Z" };
}

/** A workspace list whose actions are spies; `statuses` answers `status(id)`. */
export function fakeWorkspaces(
  overrides: Partial<Workspaces> & { statuses?: Record<string, WorkspaceStatus> } = {},
): Workspaces {
  const { statuses = {}, ...rest } = overrides;
  return {
    ready: true,
    failed: false,
    reload: vi.fn(),
    workspaces: [],
    activeId: null,
    status: (id) => statuses[id] ?? { state: "checking" },
    recheck: vi.fn(),
    add: vi.fn(async (input) => workspace("new", input.name, input.url)),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    setActive: vi.fn(),
    ...rest,
  };
}

function NoProvider({ children }: { children: ReactNode }) {
  return children;
}

function FakeSignIn() {
  return <div data-testid="account-sign-in" />;
}

export function fakeAccounts(state: CloudAccountState): CloudAccounts {
  return {
    issuer: ISSUER,
    Provider: NoProvider,
    SignIn: FakeSignIn,
    useAccount: () => state,
    getToken: async () => null,
    signOut: vi.fn(async () => undefined),
    readDocument: async () => null,
    writeDocument: async () => undefined,
  };
}

export const signedIn: CloudAccountState = {
  status: "signed-in",
  user: { id: "user-1", email: "ada@example.test", name: "Ada", imageUrl: null },
};

function Trans({ children }: { children: ReactNode }) {
  return children;
}

/** Lingui's macros as plain text, as the other web tests mock them. */
export function linguiMock() {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t, i18n: { locale: "en" } }), Trans };
}

const CloseContext = createContext<(() => void) | undefined>(undefined);

function Pass({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}

function Closable({
  children,
  onOpenChange,
}: {
  children?: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <CloseContext.Provider value={() => onOpenChange?.(false)}>
      <div>{children}</div>
    </CloseContext.Provider>
  );
}

function Action({ children, onClick, disabled }: ComponentProps<"button">) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function Close({ children, disabled }: ComponentProps<"button">) {
  const close = useContext(CloseContext);
  return (
    <button type="button" disabled={disabled} onClick={close}>
      {children}
    </button>
  );
}

function Title({ children }: { children?: ReactNode }) {
  return <h2>{children}</h2>;
}

function Description({ children }: { children?: ReactNode }) {
  return <p>{children}</p>;
}

function MenuTrigger({ render }: { render?: { props: { "aria-label"?: string } } }) {
  return <button type="button" aria-label={render?.props["aria-label"]} />;
}

function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

/**
 * Menus, dialogs and the fold-out rendered inline, so a test can press what they hold without
 * driving their pointer and focus handling.
 */
export function uiWebOverlaysMock(): Record<string, unknown> {
  return {
    Dialog: Closable,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogTitle: Title,
    AlertDialog: Closable,
    AlertDialogContent: Pass,
    AlertDialogHeader: Pass,
    AlertDialogFooter: Pass,
    AlertDialogTitle: Title,
    AlertDialogDescription: Description,
    AlertDialogCancel: Close,
    AlertDialogAction: Action,
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: Action,
    DropdownMenuTrigger: MenuTrigger,
    Disclosure,
    toast: { error: vi.fn() },
  };
}
