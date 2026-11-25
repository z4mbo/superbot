// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Label: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    "data-testid": testId,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

const client = vi.hoisted(() => ({ preferences: {} }));
vi.mock("../../lib/query/rpc", () => ({
  rpc: client,
  rpcForSpace: () => client,
  createSpaceRpc: () => client,
  selectedSpaceId: () => null,
}));

import { LabsSettingsPanel } from "./LabsSettingsPanel";

let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

async function render(props: React.ComponentProps<typeof LabsSettingsPanel>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<LabsSettingsPanel {...props} />));
  return container;
}

it("lists no row for a lab this app no longer shows", async () => {
  const onLabsChange = vi.fn();
  const container = await render({ labs: ["board"], available: ["board"], onLabsChange });
  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(container.textContent).not.toContain("Board");
});
