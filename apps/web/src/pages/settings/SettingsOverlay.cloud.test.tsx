// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogClose: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    initialFocus: _initialFocus,
    ...props
  }: { children?: ReactNode; showCloseButton?: boolean; initialFocus?: unknown } & Omit<
    React.ComponentProps<"div">,
    "children"
  >) => <div {...props}>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));

const { Nothing } = vi.hoisted(() => ({ Nothing: () => null }));
vi.mock("./AccountSettingsOverlay", () => ({
  ComputerSettingsPanel: Nothing,
  GeneralSettingsPanels: Nothing,
  UpdatesSettingsPanel: Nothing,
}));
vi.mock("./UsageSettingsPanel", () => ({ UsageSettingsPanel: Nothing }));
vi.mock("../../lib/query/rpc", () => ({
  rpc: {},
  createSpaceRpc: () => ({}),
  selectedSpaceId: () => null,
  rpcForSpace: () => ({}),
}));
vi.mock("./BillingSettingsPanel", () => ({ BillingSettingsPanel: Nothing }));
vi.mock("./PaymentWalletSettingsPanel", () => ({ PaymentWalletSettingsPanel: Nothing }));
vi.mock("./MemorySettingsOverlay", () => ({ MemorySettingsOverlay: Nothing }));
vi.mock("./SpaceSettingsPanel", () => ({ SpaceSettingsPanel: Nothing }));
vi.mock("../model-settings/ModelSettingsOverlay", () => ({ ModelSettingsOverlay: Nothing }));
vi.mock("./VoiceSettingsOverlay", () => ({ VoiceSettingsOverlay: Nothing }));
vi.mock("../../components/settings/ApprovalRulesSettings", () => ({
  ApprovalRulesSettings: Nothing,
}));
vi.mock("../../components/vault/VaultSettings", () => ({ VaultSettings: Nothing }));
vi.mock("./LabsSettingsPanel", () => ({ LabsSettingsPanel: Nothing }));
vi.mock("./OrganizationSettingsPanel", () => ({
  OrganizationOptionsMenu: Nothing,
  OrganizationSettingsPanel: Nothing,
}));
vi.mock("../../components/computers/CloudComputerSizes", () => ({
  CloudComputerSizes: Nothing,
  useCloudComputers: () => ({ data: { computers: [] }, isError: false }),
}));
vi.mock("../../components/computers/ComputerDeviceSettings", () => ({
  ComputerDeviceSettings: Nothing,
  useThisComputer: () => ({ thisComputer: null, plainHttp: false }),
  userDevicesQuery: () => ({ queryKey: ["user:", "userDevices"], queryFn: async () => [] }),
}));
vi.mock("../../components/computers/ComputersUnavailableHint", () => ({
  computersAreUnavailable: () => false,
}));
const cloud = vi.hoisted(() => ({ on: false }));
vi.mock("../../cloud/cloud-mode", () => ({
  get CLOUD_WEB() {
    return cloud.on;
  },
}));
vi.mock("../../cloud/ui/CloudWorkspacesSettings", () => ({
  CloudWorkspacesSettings: () => <div data-testid="cloud-workspaces-settings" />,
}));

import { SettingsOverlay } from "./SettingsOverlay";

async function render(cloudWeb: boolean) {
  cloud.on = cloudWeb;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SettingsOverlay
          name="Jamie"
          timezone={null}
          onTimezoneChange={async () => undefined}
          labs={[]}
          labsAvailable={[]}
          onLabsChange={async () => undefined}
          memoryConfig={null}
          onMemoryConfigChange={() => undefined}
          onClose={() => undefined}
          section="workspaces"
          onSectionChange={() => undefined}
          shellRpc={{} as never}
        />
      </QueryClientProvider>,
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("offers Workspaces in the hosted build", async () => {
  const { container, cleanup } = await render(true);
  try {
    expect(container.querySelector('[data-testid="settings-nav-workspaces"]')).not.toBeNull();
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="cloud-workspaces-settings"]')).not.toBeNull(),
    );
    expect(
      container
        .querySelector('[data-testid="user-settings"]')
        ?.getAttribute("data-settings-section"),
    ).toBe("workspaces");
  } finally {
    await cleanup();
  }
});

it("has no Workspaces in a server's own build, even from a link to it", async () => {
  const { container, cleanup } = await render(false);
  try {
    expect(container.querySelector('[data-testid="settings-nav-workspaces"]')).toBeNull();
    expect(container.querySelector('[data-testid="cloud-workspaces-settings"]')).toBeNull();
    expect(
      container
        .querySelector('[data-testid="user-settings"]')
        ?.getAttribute("data-settings-section"),
    ).toBe("general");
  } finally {
    await cleanup();
  }
});
