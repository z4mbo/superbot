// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CallState } from "../../lib/calls/call-session";
import { endCall, pressToTalk, releaseToTalk, setTurnMode } from "../../lib/calls/call-session";
import { CallCard } from "./CallCard";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
let pickToggle: (value: string) => void = () => {};
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  defaultBotAvatarValue: () => "",
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  ToggleGroup: ({
    children,
    onValueChange,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onValueChange: (value: string[]) => void;
    "data-testid": string;
  }) => {
    pickToggle = (value) => onValueChange([value]);
    return <fieldset data-testid={testId}>{children}</fieldset>;
  },
  ToggleGroupItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <button type="button" data-value={value} onClick={() => pickToggle(value)}>
      {children}
    </button>
  ),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useParams: () => ({}) }));
let session: CallState | null = null;
vi.mock("../../lib/calls/call-session", () => ({
  endCall: vi.fn(),
  pressToTalk: vi.fn(),
  releaseToTalk: vi.fn(),
  setTurnMode: vi.fn(),
  setCallMinimized: vi.fn(),
  toggleMute: vi.fn(),
  toggleTranscript: vi.fn(),
  useCallSession: () => session,
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let composer: HTMLTextAreaElement;
/** Below md the call view covers the app. */
function viewport(width: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("matchMedia", () => ({
    matches: width < 768,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}
/** Base UI moves focus a microtask and an animation frame after a change. */
async function flushFocus() {
  await act(() => vi.advanceTimersByTimeAsync(50));
}
function render(call: Partial<CallState> | null) {
  session = call
    ? ({
        botId: "bot-1",
        botName: "Test bot",
        phase: "listening",
        exchanges: [],
        turnMode: "open-mic",
        turnModes: ["open-mic"],
        talking: false,
        ...call,
      } as CallState)
    : null;
  act(() => root.render(<CallCard onSettings={vi.fn()} />));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  composer = document.createElement("textarea");
  document.body.append(container, composer);
  composer.focus();
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  composer.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("takes focus on a phone screen, shuts out the app behind it, and gives focus back", async () => {
  viewport(375);
  render({});
  await flushFocus();
  const view = document.querySelector('[data-testid="call-view"]');
  expect(view?.getAttribute("role")).toBe("dialog");
  expect(view?.contains(document.activeElement)).toBe(true);
  expect(composer.closest('[aria-hidden="true"]')).not.toBeNull();
  render({ minimized: true });
  await flushFocus();
  expect(document.activeElement).toBe(composer);
  expect(composer.closest('[aria-hidden="true"]')).toBeNull();
});

it("still hangs up on Escape on a phone screen", async () => {
  viewport(375);
  render({});
  await flushFocus();
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(endCall).toHaveBeenCalledOnce();
});

it("leaves focus in the app beside the desktop card", async () => {
  viewport(1024);
  render({});
  await flushFocus();
  expect(container.querySelector('[data-testid="call-view"]')).not.toBeNull();
  expect(document.activeElement).toBe(composer);
  expect(composer.closest('[aria-hidden="true"]')).toBeNull();
});

it("keeps the running clock readable without including ticks in the live status", async () => {
  viewport(1024);
  vi.setSystemTime(31_000);
  render({ phase: "thinking", connectedAt: 0 });
  const live = container.querySelector('[aria-live="polite"]');
  const clock = [...container.querySelectorAll("span")].find(
    (span) => span.childElementCount === 0 && span.textContent === "00:31",
  );
  expect(clock).toBeDefined();
  expect(clock?.closest('[aria-live], [aria-hidden="true"]')).toBeNull();
  expect(live?.textContent).toBe("Thinking");

  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(clock?.textContent).toBe("00:32");
  expect(live?.textContent).toBe("Thinking");

  render({ phase: "speaking", connectedAt: 0 });
  expect(container.querySelector('[aria-live="polite"]')).toBe(live);
  expect(live?.textContent).toBe("Speaking");
});

it("announces Calling without showing a clock before connection", () => {
  viewport(1024);
  render({ phase: "ringing", connectedAt: null });
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("Calling…");
  expect(container.textContent).not.toMatch(/\d{2}:\d{2}/);
});

it("hides the turn-mode toggle when the voice takes turns only one way", () => {
  viewport(1280);
  render({ turnModes: ["open-mic"] });
  expect(container.querySelector('[data-testid="call-turn-mode"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Mute"]')).not.toBeNull();
});

it("switches between push to talk and an open mic", () => {
  viewport(1280);
  render({ turnModes: ["push-to-talk", "open-mic"] });
  const toggle = container.querySelector('[data-testid="call-turn-mode"]');
  expect(toggle?.textContent).toBe("Push to talkOpen mic");
  act(() => toggle!.querySelector<HTMLButtonElement>('[data-value="push-to-talk"]')!.click());
  expect(setTurnMode).toHaveBeenCalledWith("push-to-talk");
});

it("talks while the talk button or Space is held in push to talk", () => {
  viewport(1280);
  render({ turnModes: ["push-to-talk", "open-mic"], turnMode: "push-to-talk" });
  expect(container.querySelector('button[aria-label="Mute"]')).toBeNull();
  expect(container.textContent).toContain("Hold to talk");
  const talk = container.querySelector<HTMLButtonElement>('[data-testid="call-talk"]')!;
  act(() => talk.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
  expect(pressToTalk).toHaveBeenCalledTimes(1);
  act(() => talk.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
  expect(releaseToTalk).toHaveBeenCalledTimes(1);

  // Space typed into a field stays a space.
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
  expect(pressToTalk).toHaveBeenCalledTimes(1);

  composer.blur();
  const down = new KeyboardEvent("keydown", {
    key: " ",
    code: "Space",
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(down);
  expect(pressToTalk).toHaveBeenCalledTimes(2);
  expect(down.defaultPrevented).toBe(true);
  render({
    turnModes: ["push-to-talk", "open-mic"],
    turnMode: "push-to-talk",
    talking: true,
  });
  window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }));
  expect(releaseToTalk).toHaveBeenCalledTimes(2);
});

it("leaves Space alone with an open mic", () => {
  viewport(1280);
  render({ turnModes: ["push-to-talk", "open-mic"], turnMode: "open-mic" });
  composer.blur();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
  expect(pressToTalk).not.toHaveBeenCalled();
});
