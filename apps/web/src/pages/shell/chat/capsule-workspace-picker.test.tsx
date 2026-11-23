// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CapsuleWorkspacePicker } from "./capsule-workspace-picker";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

const spaces = [
  { id: "home", name: "Personal", bots: [{ id: "bot-a" }] },
  { id: "team", name: "Team", bots: [{ id: "bot-b" }] },
  { id: "new", name: "Empty", bots: [] },
] as never;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.rakazoDesktop;
});

function open(props: Partial<Parameters<typeof CapsuleWorkspacePicker>[0]> = {}) {
  const onSwitch = vi.fn();
  const onInvite = vi.fn();
  act(() =>
    root.render(
      <CapsuleWorkspacePicker
        spaces={spaces}
        currentSpaceId="home"
        onSwitch={onSwitch}
        onInvite={onInvite}
        {...props}
      />,
    ),
  );
  act(() =>
    container.querySelector<HTMLButtonElement>('[data-testid="capsule-workspace"]')!.click(),
  );
  const row = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button')].find(
      (button) => button.textContent === name,
    )!;
  return { onSwitch, onInvite, row };
}

it("names the current workspace and switches to another at its first chat", () => {
  const { onSwitch, row } = open();
  expect(container.textContent).toContain("Personal");
  expect(row("Personal").getAttribute("aria-current")).toBe("true");
  act(() => row("Team").click());
  expect(onSwitch).toHaveBeenCalledWith("team", "/app/bot-b");
});

it("sends an empty workspace to its first-bot setup", () => {
  const { onSwitch, row } = open();
  act(() => row("Empty").click());
  expect(onSwitch).toHaveBeenCalledWith("new", "/onboarding");
});

it("invites people to the current workspace", () => {
  const { onInvite, row } = open();
  act(() => row("Invite people").click());
  expect(onInvite).toHaveBeenCalledWith("home");
});

it("offers another server only where the desktop app can switch to one", () => {
  expect(open().row("Connect to a server").disabled).toBe(true);
  act(() => root.unmount());
  root = createRoot(container);
  const change = vi.fn(async () => undefined);
  window.rakazoDesktop = { server: { change } } as never;
  const { row } = open();
  act(() => row("Connect to a server").click());
  expect(change).toHaveBeenCalledOnce();
});
