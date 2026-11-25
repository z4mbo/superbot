// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: ({ state }: { state?: string }) => <span data-avatar-state={state ?? "status"} />,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("../../../components/computers/ComputersUnavailableHint", () => ({
  ComputersUnavailableHint: () => null,
}));

import { ComputerPanel } from "./computer-panel";

let container: HTMLDivElement;
let root: Root;

const bot = { id: "bot-1", name: "Ada" } as Bot;

function computer(state: ComputerStatus["state"]): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "boat",
    state,
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: state === "running",
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
  };
}

async function render(
  status: ComputerStatus | null,
  onOpen = vi.fn(),
  disk?: { cleaningUpDisk?: boolean; onCleanUpDisk: () => void; onDismissDiskWarning: () => void },
  embeddedScreenUrl: string | null = null,
  overrides: Partial<ComponentProps<typeof ComputerPanel>> = {},
) {
  await act(async () => {
    root.render(
      <ComputerPanel
        bot={bot}
        computer={status}
        computerOpen={false}
        embeddedScreenUrl={embeddedScreenUrl}
        screenFrameRef={() => undefined}
        computerScreenError={null}
        computerBooting={null}
        booting={false}
        showingRecoveryHint={false}
        showComputerRecoveryHint={false}
        onRecovered={() => undefined}
        onRecoveryDismissed={() => undefined}
        onOpen={onOpen}
        {...disk}
        {...overrides}
      />,
    );
  });
  return onOpen;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** The compact row's two lines: the computer's name, then its state. */
function rowLines() {
  const row = container.querySelector('[data-testid="computer-preview"] > div');
  return [...(row?.firstElementChild?.children ?? [])].map((line) => line.textContent);
}

it("shows the computer as one row: its name, its state and a thumbnail", async () => {
  await render(computer("suspended"));
  expect(rowLines()).toEqual(["Team Computer", "Asleep"]);
  const thumbnail = container.querySelector('[data-testid="computer-preview-thumbnail"]');
  expect(thumbnail?.querySelector("[data-avatar-state]")?.getAttribute("data-avatar-state")).toBe(
    "asleep",
  );
  await render({ ...computer("stopped"), mode: "dedicated" });
  expect(rowLines()).toEqual(["Ada’s computer", "Asleep"]);
});

it.each([
  ["booting", "Booting live desktop…"],
  ["running", "Connecting to the screen…"],
  ["error", "Computer failed to boot"],
] as const)("says a %s computer's state on its second line", async (state, line) => {
  await render(computer(state));
  expect(rowLines()).toEqual(["Team Computer", line]);
  expect(container.querySelector("[data-avatar-state]")?.getAttribute("data-avatar-state")).toBe(
    "status",
  );
});

it("says a running computer with its screen is running and shows that screen small", async () => {
  await render(computer("running"), vi.fn(), undefined, "https://screen.example.test/");
  expect(rowLines()).toEqual(["Team Computer", "Running"]);
  expect(
    container.querySelector('[data-testid="computer-preview-thumbnail"] iframe'),
  ).not.toBeNull();
});

it("says the computer is open while it shows in the full window", async () => {
  const onOpen = await render(computer("running"), vi.fn(), undefined, null, {
    computerOpen: true,
  });
  expect(rowLines()).toEqual(["Team Computer", "Open in full window"]);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="computer-preview-open"]')?.click(),
  );
  expect(onOpen).toHaveBeenCalledOnce();
});

it("shows a screen error under the row and does not open from it", async () => {
  await render(computer("running"), vi.fn(), undefined, "https://screen.example.test/", {
    computerScreenError: <p role="alert">Screen not connected</p>,
  });
  expect(container.querySelector('[data-testid="computer-preview-open"]')).toBeNull();
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Screen not connected");
});

it.each([null, computer("stopped"), computer("suspended")])(
  "shows an idle computer asleep until its Wake button is pressed",
  async (status) => {
    const onOpen = await render(status);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-state="idle"]')?.textContent).toContain("Asleep");
    expect(container.querySelector('[data-testid="computer-preview-open"]')?.textContent).toBe(
      "Wake",
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="computer-preview-open"]')?.click(),
    );
    expect(onOpen).toHaveBeenCalledOnce();
  },
);

it("shows a running computer's live screen with an Open button", async () => {
  const onOpen = await render(
    computer("running"),
    vi.fn(),
    undefined,
    "https://screen.example.test/",
  );
  expect(container.querySelector('[data-state="running"] iframe')?.getAttribute("src")).toBe(
    "https://screen.example.test/",
  );
  expect(container.querySelector("iframe")?.tabIndex).toBe(-1);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="computer-preview-open"]')?.click(),
  );
  expect(onOpen).toHaveBeenCalledOnce();
});

it("shows the person's own machine from what the server says", async () => {
  await render({ ...computer("running"), kind: "desktop", runsOnUserMachine: false });
  expect(container.querySelector('[data-state="running"]')).not.toBeNull();
  await render({ ...computer("running"), kind: "any-kind", runsOnUserMachine: true });
  expect(container.querySelector('[data-state="running"]')).toBeNull();
  expect(container.textContent).toContain("This bot runs on this computer");
  await render({ ...computer("stopped"), kind: "any-kind", runsOnUserMachine: true });
  expect(container.querySelector('[data-state="idle"]')).toBeNull();
});

it("still shows the person's own machine when an older server names it only by kind", async () => {
  await render({ ...computer("running"), kind: "desktop" });
  expect(container.querySelector('[data-state="running"]')).toBeNull();
  expect(container.textContent).toContain("This bot runs on this computer");
});

it("shows a computer of a kind this build does not know like any other", async () => {
  await render({ ...computer("stopped"), kind: "a-provider-since-removed" });
  expect(container.querySelector('[data-state="idle"]')?.textContent).toContain("Asleep");
  await render({ ...computer("running"), kind: "a-provider-since-removed" });
  expect(container.querySelector('[data-state="running"]')?.textContent).toContain(
    "Connecting to the screen…",
  );
});

it.each([computer("running"), computer("suspended")])(
  "warns that the disk is nearly full and offers a clean up",
  async (status) => {
    const disk = { onCleanUpDisk: vi.fn(), onDismissDiskWarning: vi.fn() };
    await render({ ...status, diskFullPercent: 93 }, vi.fn(), disk);
    const warning = container.querySelector('[data-testid="computer-disk-warning"]');
    expect(warning?.textContent).toContain("Clean up");
    const [cleanUp, dismiss] = warning?.querySelectorAll("button") ?? [];
    await act(async () => cleanUp?.click());
    await act(async () => dismiss?.click());
    expect(disk.onCleanUpDisk).toHaveBeenCalledOnce();
    expect(disk.onDismissDiskWarning).toHaveBeenCalledOnce();
  },
);

it("holds Clean up while a clean up is being sent", async () => {
  const disk = { cleaningUpDisk: true, onCleanUpDisk: vi.fn(), onDismissDiskWarning: vi.fn() };
  await render({ ...computer("running"), diskFullPercent: 93 }, vi.fn(), disk);
  const [cleanUp] =
    container.querySelector('[data-testid="computer-disk-warning"]')?.querySelectorAll("button") ??
    [];
  expect(cleanUp?.hasAttribute("disabled")).toBe(true);
});

it("shows no disk warning while the disk has room", async () => {
  await render(computer("running"), vi.fn(), {
    onCleanUpDisk: vi.fn(),
    onDismissDiskWarning: vi.fn(),
  });
  expect(container.querySelector('[data-testid="computer-disk-warning"]')).toBeNull();
});
